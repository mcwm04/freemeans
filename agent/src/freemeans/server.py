"""OpenAI-compatible local endpoint (binds to 127.0.0.1 by default)."""

from __future__ import annotations

from datetime import datetime, timezone
from typing import Any

from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse

from .config import Config
from .meter import Meter
from .policy import PolicyError
from .router import ClientRequestError, NoCapacityError, Router


def _iso(ts: float | None) -> str | None:
    return datetime.fromtimestamp(ts, timezone.utc).isoformat() if ts else None


def usage_report(config: Config, meter: Meter) -> list[dict[str, Any]]:
    rows = []
    for dep in config.deployments.values():
        limits = dep.limits()
        rem = {r.metric: r for r in meter.remaining(dep.name, limits)}
        windows = []
        for metric in sorted(set(limits) | set(rem)):
            lim = limits.get(metric)
            r = rem.get(metric)
            windows.append({
                "metric": metric,
                "limit": r.limit if r else (lim.value if lim else None),
                "remaining": round(r.remaining, 1) if r else None,
                "method": r.method if r else "unknown",
                "resets_at": _iso(r.reset_at) if r else None,
                "source": (lim.signal_type if lim else "header"),
            })
        rows.append({
            "deployment": dep.name,
            "resource": dep.resource.id,
            "model": dep.model,
            "badges": sorted(dep.resource.badges),
            "catalog_verified": dep.resource.last_verified,
            "windows": windows,
        })
    return rows


def create_app(config: Config, router: Router, meter: Meter) -> FastAPI:
    app = FastAPI(title="Freemeans local agent", version="0.1.0")

    @app.get("/freemeans/health")
    async def health() -> dict[str, Any]:
        return {"ok": True, "catalog_version": config.catalog.version, "deployments": len(config.deployments)}

    @app.get("/v1/models")
    async def models() -> dict[str, Any]:
        data = [{"id": name, "object": "model", "owned_by": "freemeans", "routes_to": deps}
                for name, deps in config.models.items()]
        data += [{"id": d.name, "object": "model", "owned_by": d.provider, "routes_to": [d.name]}
                 for d in config.deployments.values()]
        return {"object": "list", "data": data}

    @app.get("/freemeans/usage")
    async def usage() -> dict[str, Any]:
        return {"deployments": usage_report(config, meter)}

    @app.post("/v1/chat/completions")
    async def chat(request: Request) -> JSONResponse:
        body = await request.json()
        if body.get("stream"):
            return JSONResponse({"error": {"message": "Streaming is not supported in this prototype; set stream=false."}},
                                status_code=400)
        model = body.get("model") or "freemeans/auto"
        try:
            project = config.project(request.headers.get("x-freemeans-project"))
            result = await router.complete(model, body, project)
        except PolicyError as exc:
            return JSONResponse({"error": {"message": str(exc), "type": "policy_error"}}, status_code=400)
        except KeyError as exc:
            return JSONResponse({"error": {"message": str(exc.args[0]), "type": "unknown_model"}}, status_code=404)
        except ClientRequestError as exc:
            return JSONResponse(exc.response.body, status_code=exc.response.status,
                                headers={"x-freemeans-deployment": exc.deployment})
        except NoCapacityError as exc:
            headers = {}
            if exc.retry_at:
                headers["retry-after"] = str(max(1, int(exc.retry_at - router.now())))
            return JSONResponse({
                "error": {"message": str(exc), "type": "no_free_capacity",
                          "retry_at": _iso(exc.retry_at),
                          "decisions": [d.__dict__ for d in exc.decisions]}
            }, status_code=429, headers=headers)
        return JSONResponse(result.response.body, status_code=result.response.status, headers={
            "x-freemeans-deployment": result.deployment.name,
            "x-freemeans-resource": result.deployment.resource.id,
            "x-freemeans-project": project.name,
        })

    return app
