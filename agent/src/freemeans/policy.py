"""Policy engine: the Chapter 4 rules, enforced in code.

Two kinds of rules live here:
1. Routing rules: which free tiers a given project may use, based on badges.
2. Configuration rules: what the agent refuses to do at all
   (e.g. pooling several accounts/keys of one provider to multiply quota).
"""

from __future__ import annotations

from dataclasses import dataclass


class PolicyError(ValueError):
    """Raised when a configuration would break a provider's terms."""


@dataclass(frozen=True)
class ProjectPolicy:
    name: str = "default"
    client_project: bool = False  # work done for a client, may contain their data
    commercial: bool = False      # earns money / used in a business
    eu_end_users: bool = False    # app is offered to users in the EEA, Switzerland or UK
    users_adult: bool = True      # all end users are 18+
    production: bool = False      # live workload, not a prototype

    @classmethod
    def from_dict(cls, name: str, d: dict | None) -> "ProjectPolicy":
        d = d or {}
        allowed = {"client_project", "commercial", "eu_end_users", "users_adult", "production"}
        unknown = set(d) - allowed
        if unknown:
            raise PolicyError(f"Project '{name}': unknown policy keys {sorted(unknown)}")
        return cls(name=name, **{k: bool(v) for k, v in d.items()})


def blocking_reasons(policy: ProjectPolicy, badges: set[str]) -> list[str]:
    """Return why a resource with these badges may NOT serve this project.

    An empty list means the resource is allowed.
    """
    reasons: list[str] = []
    if "manual_only" in badges:
        reasons.append("manual_only: this resource must never be automated")
    if "trains_on_data" in badges and policy.client_project:
        reasons.append("trains_on_data: client projects never go to tiers that may train on prompts")
    if "non_commercial" in badges and (policy.commercial or policy.client_project):
        reasons.append("non_commercial: tier is not licensed for commercial or client work")
    if "eu_restricted" in badges and policy.eu_end_users:
        reasons.append("eu_restricted: apps for EEA/CH/UK users must use paid services here")
    if "age_18_plus" in badges and not policy.users_adult:
        reasons.append("age_18_plus: tier may not serve users under 18")
    if "not_for_production" in badges and policy.production:
        reasons.append("not_for_production: tier is for prototyping only")
    return reasons


def check_one_account_per_provider(deployments: list[dict]) -> None:
    """Refuse configs that pool several keys of the same provider.

    Providers forbid multiple accounts to get around limits (e.g. OpenRouter's
    terms; Colab's FAQ). Freemeans routes across *different* providers and
    models, never across copies of one account.
    """
    key_by_provider: dict[str, str] = {}
    for d in deployments:
        provider = d["provider"]
        key_env = d["key_env"]
        prev = key_by_provider.setdefault(provider, key_env)
        if prev != key_env:
            raise PolicyError(
                f"Deployments for provider '{provider}' use different keys ({prev} and {key_env}). "
                "Freemeans allows one account/key per provider; pooling accounts to multiply "
                "free quota breaks provider terms."
            )
