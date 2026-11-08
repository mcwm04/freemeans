"""Free-aware routing (Chapter 6.3).

For each request:
1. filter candidates by the project's policy (badges)
2. filter by capability (context size, tool calling)
3. skip providers that are cooling down after a 429 or would break a limit
4. score = headroom x quality, best first
5. send; on 429 mark the provider cooling until Retry-After / reset and try the
   NEXT provider - never the same one in a loop
6. record usage and headers in the meter
"""

from __future__ import annotations

import json
import time
from dataclasses import dataclass, field
from typing import Any, Callable

import httpx

from .config import Config, Deployment
from .keys import MissingKeyError, has_key
from .meter import Meter, parse_rate_headers, parse_retry_after
from .policy import ProjectPolicy, blocking_reasons
from .transport import ProviderResponse, Transport

DEFAULT_COOLDOWN_429 = 60.0      # seconds, when a 429 carries no Retry-After or reset
COOLDOWN_SERVER_ERROR = 30.0     # 5xx or network error
COOLDOWN_AUTH_OR_BILLING = 600.0  # 401/402/403: needs the user's attention
UNKNOWN_HEADROOM = 0.5           # neutral score when no limit is known


@dataclass
class Decision:
    deployment: str
    status: str            # "candidate" | "skipped" | "sent" | "failed" | "served"
    reason: str = ""
    score: float | None = None
    headroom: float | None = None


@dataclass
class RouteResult:
    deployment: Deployment
    response: ProviderResponse
    decisions: list[Decision] = field(default_factory=list)


class NoCapacityError(RuntimeError):
    def __init__(self, message: str, decisions: list[Decision], retry_at: float | None):
        super().__init__(message)
        self.decisions = decisions
        self.retry_at = retry_at


class ClientRequestError(RuntimeError):
    def __init__(self, response: ProviderResponse, deployment: str, decisions: list[Decision]):
        super().__init__(f"{deployment} rejected the request with HTTP {response.status}")
        self.response = response
        self.deployment = deployment
        self.decisions = decisions


def estimate_tokens(body: dict[str, Any]) -> int:
    """Rough prompt + completion estimate (4 characters ~ 1 token)."""
    text = json.dumps(body.get("messages", []), ensure_ascii=False)
    prompt = max(1, len(text) // 4)
    completion = int(body.get("max_tokens") or body.get("max_completion_tokens") or 512)
    return prompt + completion


class Router:
    def __init__(self, config: Config, meter: Meter, transport: Transport,
                 now: Callable[[], float] = time.time, check_keys: bool = True):
        self.config = config
        self.meter = meter
        self.transport = transport
        self.now = now
        self.check_keys = check_keys
        self.cooldown_until: dict[str, float] = {}

    # -- selection -----------------------------------------------------
    def resolve(self, model: str) -> list[Deployment]:
        if model in self.config.models:
            return [self.config.deployments[n] for n in self.config.models[model]]
        if model in self.config.deployments:
            return [self.config.deployments[model]]
        matches = [d for d in self.config.deployments.values() if d.model == model]
        if matches:
            return matches
        raise KeyError(f"Unknown model '{model}'. Use a name from GET /v1/models.")

    def plan(self, model: str, body: dict[str, Any], project: ProjectPolicy) -> tuple[list[Deployment], list[Decision]]:
        now = self.now()
        est = estimate_tokens(body)
        needs_tools = bool(body.get("tools"))
        ranked: list[tuple[float, Deployment]] = []
        decisions: list[Decision] = []
        for dep in self.resolve(model):
            reasons = blocking_reasons(project, dep.resource.badges)
            if reasons:
                decisions.append(Decision(dep.name, "skipped", "policy: " + "; ".join(reasons)))
                continue
            if dep.context_tokens and est > dep.context_tokens:
                decisions.append(Decision(dep.name, "skipped", f"context: ~{est} tokens > {dep.context_tokens}"))
                continue
            if needs_tools and not dep.supports_tools:
                decisions.append(Decision(dep.name, "skipped", "capability: no tool calling"))
                continue
            if self.check_keys and not has_key(dep.key_env):
                decisions.append(Decision(dep.name, "skipped", f"no key: set {dep.key_env}"))
                continue
            until = self.cooldown_until.get(dep.name, 0)
            if until > now:
                decisions.append(Decision(dep.name, "skipped", f"cooling down for {int(until - now)}s"))
                continue
            limits = dep.limits()
            ok, why = self.meter.can_send(dep.name, limits, est)
            if not ok:
                decisions.append(Decision(dep.name, "skipped", f"limit: {why}"))
                continue
            head = self.meter.headroom(dep.name, limits)
            score = (UNKNOWN_HEADROOM if head is None else head) * dep.quality
            decisions.append(Decision(dep.name, "candidate", score=round(score, 4), headroom=head))
            ranked.append((score, dep))
        ranked.sort(key=lambda x: x[0], reverse=True)
        return [d for _, d in ranked], decisions

    # -- sending -------------------------------------------------------
    def _cooldown_for_429(self, dep: Deployment, resp: ProviderResponse) -> float:
        now = self.now()
        wait = parse_retry_after(resp.headers, now)
        if wait is None:
            resets = [w.reset_at for w in parse_rate_headers(resp.headers, now)
                      if w.reset_at and w.remaining is not None and w.remaining < 1]
            wait = (min(resets) - now) if resets else None
        if wait is None:
            reset = self.meter.earliest_reset(dep.name, dep.limits())
            wait = (reset - now) if reset else DEFAULT_COOLDOWN_429
        return max(1.0, wait)

    async def complete(self, model: str, body: dict[str, Any], project: ProjectPolicy) -> RouteResult:
        ranked, decisions = self.plan(model, body, project)
        by_name = {d.deployment: d for d in decisions}
        for dep in ranked:
            dec = by_name[dep.name]
            try:
                resp = await self.transport.chat(dep, body)
            except (httpx.HTTPError, MissingKeyError) as exc:
                self.cooldown_until[dep.name] = self.now() + COOLDOWN_SERVER_ERROR
                dec.status, dec.reason = "failed", f"transport: {type(exc).__name__}: {exc}"
                continue

            if 200 <= resp.status < 300:
                usage = resp.body.get("usage") or {}
                tokens = int(usage.get("total_tokens") or estimate_tokens(body))
                self.meter.record(dep.name, tokens, resp.status, resp.headers)
                dec.status = "served"
                return RouteResult(dep, resp, decisions)

            self.meter.record(dep.name, 0, resp.status, resp.headers)
            if resp.status == 429:
                wait = self._cooldown_for_429(dep, resp)
                self.cooldown_until[dep.name] = self.now() + wait
                dec.status, dec.reason = "failed", f"429 rate limited; cooling {int(wait)}s"
                continue
            if resp.status >= 500:
                self.cooldown_until[dep.name] = self.now() + COOLDOWN_SERVER_ERROR
                dec.status, dec.reason = "failed", f"HTTP {resp.status} from provider"
                continue
            if resp.status in (401, 402, 403):
                self.cooldown_until[dep.name] = self.now() + COOLDOWN_AUTH_OR_BILLING
                dec.status, dec.reason = "failed", f"HTTP {resp.status}: check key, billing or model access"
                continue
            # Other 4xx: the request itself is wrong; another provider would reject it too.
            dec.status, dec.reason = "failed", f"HTTP {resp.status}: request rejected"
            raise ClientRequestError(resp, dep.name, decisions)

        now = self.now()
        waits = [t for t in self.cooldown_until.values() if t > now]
        retry_at = min(waits) if waits else None
        raise NoCapacityError(
            "No free-tier provider can take this request right now without breaking a limit or policy.",
            decisions, retry_at,
        )
