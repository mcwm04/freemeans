"""Turn fetched pages into a tool record the editor can approve (PRD 7.1, 7.3).

1. The LLM fills the record from the page text only, picking categories and tasks from the taxonomy.
2. Fixed fields are set by code, never by the LLM: slug, url, status, dates, signals.
3. Number check: every number in the free tier and price must appear in the fetched text next to
   its unit. Otherwise it is blanked (null) and flagged. This blocks invented quotas.
4. The record is validated with services/toolcheck; problems become flags for the editor.
"""
from __future__ import annotations

import datetime as dt
import json
import re

from toolcheck.check import DEFAULT_SCHEMA_DIR, _validator, check_tool, Report

from .domain import is_path_keyed, site_key
from .llm import Drafter

NEAR = 120

SYSTEM = """You write listings for Freemeans, a directory of AI tools that shows what each tool gives for free.
Rules:
- Use ONLY facts stated in the page text you are given. Never use outside knowledge.
- If a field is not stated in the text, return null. Never guess quotas, prices, trial length, watermark or card rules.
- tagline: under 120 characters, plain English, no marketing words (best, leading, revolutionary, ultimate, powerful, amazing, seamless).
- description: 80 to 150 words, plain English, factual, says what the tool does and for whom. No superlatives.
- categories (1-3) and tasks (1-8): choose ONLY ids from the lists given.
- evidence: for every free_tier and pricing value you fill, quote the exact sentence from the text it came from.
- Answer with one JSON object and nothing else."""

SHAPE = {
    "name": "string", "tagline": "string", "description": "string",
    "categories": ["category id"], "tasks": ["task id"], "best_for": ["up to 5 short use cases"],
    "platforms": ["web|api|ios|android|windows|macos|linux|browser-extension|cli|self-hosted"],
    "open_source": "boolean", "repo_url": "https URL or null", "license": "SPDX id or null",
    "free_tier": {"type": "forever_free|credits|trial|open_source|none", "quota": {"value": "number", "unit": "string", "period": "day|month|once"},
                  "trial_days": "integer or null", "card_required": "boolean or null", "signup_required": "boolean or null",
                  "watermark": "boolean or null", "commercial_use": "boolean or null", "notes": "string or null",
                  "source_url": "URL of the page that states the free plan"},
    "pricing": {"cheapest_paid_usd": "number or null", "period": "month|year|once|null", "source_url": "URL"},
    "evidence": {"free_tier.quota": "quoted sentence", "free_tier.card_required": "quoted sentence", "pricing.cheapest_paid_usd": "quoted sentence"},
}


def build_prompt(texts: dict[str, str], urls: dict[str, str], taxonomy: dict, hint: dict) -> str:
    cats = ", ".join(c["id"] for c in taxonomy["categories"])
    tasks = ", ".join(f"{t['id']}" for t in taxonomy["tasks"])
    pages = "\n\n".join(f"=== {role.upper()} PAGE: {urls[role]} ===\n{text}" for role, text in texts.items())
    hints = "\n".join(f"- {k}: {v}" for k, v in hint.items() if v)
    return (f"Category ids: {cats}\n\nTask ids: {tasks}\n\n"
            f"Return JSON with exactly this shape (null where the text says nothing; quota is null if no number is stated):\n"
            f"{json.dumps(SHAPE, indent=1)}\n\n" + (f"Hints (from the submitter or source, may be wrong):\n{hints}\n\n" if hints else "")
            + f"Page text:\n{pages}")


def slugify(name: str, taken: set[str]) -> str:
    base = re.sub(r"[^a-z0-9]+", "-", name.lower()).strip("-")[:50].strip("-") or "tool"
    slug, n = base, 2
    reserved = {"c", "t", "submit", "search", "top-10", "category", "task", "compare", "go", "api", "admin"}
    while slug in taken or slug in reserved:
        slug, n = f"{base}-{n}", n + 1
    return slug


def _variants(value) -> list[str]:
    """How a number may be written: 10000, 10,000, 10k, 10K, 10.000."""
    try:
        v = float(value)
    except (TypeError, ValueError):
        return []
    out = set()
    if v == int(v):
        i = int(v)
        out |= {str(i), f"{i:,}", f"{i:,}".replace(",", ".")}
        if i >= 1000 and i % 1000 == 0:
            out |= {f"{i // 1000}k", f"{i // 1000}K"}
        if i >= 1_000_000 and i % 1_000_000 == 0:
            out |= {f"{i // 1_000_000}M", f"{i // 1_000_000} million"}
    else:
        out.add(f"{v:g}")
    return sorted(out, key=len, reverse=True)


def number_near(text: str, value, unit_words: list[str]) -> bool:
    units = [re.compile(re.escape(u), re.I) for u in unit_words if u]
    for variant in _variants(value):
        for m in re.finditer(rf"(?<![\d.,]){re.escape(variant)}(?![\d])", text):
            window = text[max(0, m.start() - NEAR): m.end() + NEAR]
            if not units or any(u.search(window) for u in units):
                return True
    return False


def _unit_words(unit: str) -> list[str]:
    u = (unit or "").strip().lower()
    words = {u, u.rstrip("s")} if u else set()
    return [w for w in words if len(w) >= 2]


def check_numbers(record: dict, text: str) -> list[str]:
    """Blank every free-tier or price number that the fetched text does not state. Returns flags."""
    flags = []
    ft = record.get("free_tier") or {}
    q = ft.get("quota")
    if isinstance(q, dict) and q.get("value") is not None:
        if not number_near(text, q["value"], _unit_words(q.get("unit", ""))):
            ft["quota"] = None
            flags.append("number_blanked:free_tier.quota")
    elif isinstance(q, dict):
        ft["quota"] = None
    if ft.get("trial_days") is not None and not number_near(text, ft["trial_days"], ["day", "trial"]):
        ft["trial_days"] = None
        flags.append("number_blanked:free_tier.trial_days")
    pr = record.get("pricing")
    if isinstance(pr, dict) and pr.get("cheapest_paid_usd") is not None:
        if not number_near(text, pr["cheapest_paid_usd"], ["$", "usd", "us$", "month", "/mo", "year", "per "]):
            pr["cheapest_paid_usd"] = None
            flags.append("number_blanked:pricing.cheapest_paid_usd")
    return flags


def _clean_list(values, allowed: set[str], limit: int) -> list[str]:
    out = []
    for v in values or []:
        if isinstance(v, str) and v in allowed and v not in out:
            out.append(v)
    return out[:limit]


def assemble(raw: dict, *, url: str, key: str, source: str, source_ref: str | None, page_urls: dict[str, str],
             taxonomy: dict, taken: set[str], today: dt.date) -> dict:
    """Merge the LLM's answer with the fields code owns. Never trusts the LLM for slug, url or dates."""
    cat_ids = {c["id"] for c in taxonomy["categories"]}
    task_ids = {t["id"] for t in taxonomy["tasks"]}
    platforms_ok = {"web", "api", "ios", "android", "windows", "macos", "linux", "browser-extension", "cli", "self-hosted"}
    name = str(raw.get("name") or "").strip()[:80] or key
    ft = raw.get("free_tier") if isinstance(raw.get("free_tier"), dict) else {}
    known_pages = set(page_urls.values())
    src = ft.get("source_url") if ft.get("source_url") in known_pages else page_urls.get("pricing") or page_urls["home"]
    ftype = ft.get("type") if ft.get("type") in {"forever_free", "credits", "trial", "open_source", "none"} else "none"
    quota = ft.get("quota") if isinstance(ft.get("quota"), dict) else None
    if quota is not None:
        period = quota.get("period") if quota.get("period") in ("day", "month", "once") else None
        quota = {"value": quota.get("value") if isinstance(quota.get("value"), (int, float)) else None,
                 "unit": str(quota.get("unit") or "")[:40] or "units", "period": period}
    bool_or_none = lambda v: v if isinstance(v, bool) else None  # noqa: E731
    repo_url = raw.get("repo_url") if isinstance(raw.get("repo_url"), str) and raw["repo_url"].startswith("https://") else None
    if source == "github" and source_ref:
        repo_url = repo_url or f"https://github.com/{source_ref}"
    record = {
        "slug": slugify(name, taken),
        "name": name,
        "url": url,
        "tagline": str(raw.get("tagline") or "").strip()[:120],
        "description": str(raw.get("description") or "").strip(),
        "categories": _clean_list(raw.get("categories"), cat_ids, 3),
        "tasks": _clean_list(raw.get("tasks"), task_ids, 8),
        "best_for": [str(b)[:60] for b in (raw.get("best_for") or []) if isinstance(b, str)][:5],
        "platforms": _clean_list(raw.get("platforms"), platforms_ok, 10) or ["web"],
        "open_source": bool(raw.get("open_source")) and bool(repo_url),
        "repo_url": repo_url,
        "license": raw.get("license") if isinstance(raw.get("license"), str) else None,
        "free_tier": {
            "type": ftype,
            "quota": quota if ftype not in ("none", "open_source") else None,
            "trial_days": ft.get("trial_days") if ftype == "trial" and isinstance(ft.get("trial_days"), int) and ft["trial_days"] > 0 else None,
            "card_required": bool_or_none(ft.get("card_required")),
            "signup_required": bool_or_none(ft.get("signup_required")),
            "watermark": bool_or_none(ft.get("watermark")),
            "commercial_use": bool_or_none(ft.get("commercial_use")),
            "works_in_pk": None,
            "notes": str(ft["notes"])[:300] if isinstance(ft.get("notes"), str) else None,
            "source_url": src,
            "verified_at": today.isoformat(),
        },
        "pricing": None,
        "signals": _signals(name, key, source, source_ref, repo_url),
        "alternatives": [],
        "status": "published",
        "listed_at": today.isoformat(),
        "changelog": [{"date": today.isoformat(), "field": "listed", "note": "Listed in the directory"}],
        "affiliate_url": None,
        "sponsor": None,
        "verified_vendor": False,
    }
    if record["open_source"] and ftype == "none":
        record["free_tier"]["type"] = "open_source"
    pr = raw.get("pricing")
    if isinstance(pr, dict) and (pr.get("cheapest_paid_usd") is not None):
        price = pr.get("cheapest_paid_usd")
        record["pricing"] = {
            "cheapest_paid_usd": price if isinstance(price, (int, float)) and price >= 0 else None,
            "period": pr.get("period") if pr.get("period") in ("month", "year", "once") else None,
            "source_url": pr.get("source_url") if pr.get("source_url") in known_pages else page_urls.get("pricing") or page_urls["home"],
            "verified_at": today.isoformat(),
        }
    return record


def _signals(name: str, key: str, source: str, source_ref: str | None, repo_url: str | None) -> dict:
    gh = None
    if repo_url and repo_url.startswith("https://github.com/"):
        parts = repo_url.removeprefix("https://github.com/").strip("/").split("/")
        gh = "/".join(parts[:2]) if len(parts) >= 2 else None
    return {
        "trends_term": name,
        "wikipedia_article": None,       # the editor sets it after checking the article exists
        "github_repo": gh,
        "hf_id": f"spaces/{source_ref}" if source == "hf" and source_ref else None,
        "producthunt_slug": None,
        "hn_domain": key if not is_path_keyed(key) or key.startswith("github.com/") else None,
        "hn_query": None,
    }


def validate(record: dict, taxonomy: dict, today: dt.date) -> list[str]:
    report = Report()
    cat_ids = {c["id"] for c in taxonomy["categories"]}
    task_ids = {t["id"] for t in taxonomy["tasks"]}
    check_tool(record["slug"], record, report, _validator(DEFAULT_SCHEMA_DIR, "tool.schema.json"), cat_ids, task_ids, today)
    return report.errors


def draft_listing(drafter: Drafter, fetched, *, url: str, source: str, source_ref: str | None, hint: dict,
                  taxonomy: dict, taken: set[str], today: dt.date) -> dict:
    """Returns {record, evidence, flags, errors, provider}. Retries the LLM once if the record is invalid."""
    page_urls = {role: (p.final_url or p.url) for role, p in fetched.pages.items()}
    key = site_key(url) or url
    prompt = build_prompt(fetched.texts, page_urls, taxonomy, hint)
    best = None
    for attempt in range(2):
        user = prompt if attempt == 0 else prompt + "\n\nYour previous answer had these problems; fix them:\n- " + "\n- ".join(best["errors"])
        raw, provider = drafter.complete_json(SYSTEM, user)
        record = assemble(raw, url=url, key=key, source=source, source_ref=source_ref, page_urls=page_urls,
                          taxonomy=taxonomy, taken=taken, today=today)
        flags = check_numbers(record, fetched.all_text)
        errors = validate(record, taxonomy, today)
        evidence = raw.get("evidence") if isinstance(raw.get("evidence"), dict) else {}
        best = {"record": record, "evidence": {k: str(v)[:400] for k, v in evidence.items() if v}, "flags": flags,
                "errors": errors, "provider": provider}
        if not errors:
            break
    return best
