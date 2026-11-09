"""Model adoption: Hugging Face likes (total) and downloads (rolling 30 days), Hub API.

signals.hf_id is "owner/name" for a model or "spaces/owner/name" for a Space.
Only current totals are available, so there is no backfill (PRD 6.5).
"""
from __future__ import annotations

import datetime as dt

from ..http import Http
from ..model import Outcome

API = "https://huggingface.co/api"


def fetch(http: Http, hf_id: str, day: dt.date) -> Outcome:
    if hf_id.startswith("spaces/"):
        url, is_space = f"{API}/spaces/{hf_id[len('spaces/'):]}", True
    else:
        url, is_space = f"{API}/models/{hf_id}", False
    res = http.get_json(url)
    if res.status in (401, 404):   # the Hub answers 401 for missing or gated-private repos
        return Outcome("not_found", detail=f"{hf_id} not found on Hugging Face")
    if not res.ok or not isinstance(res.data, dict):
        return Outcome("failed", detail=res.error or "unexpected answer")
    cols: dict[str, int] = {}
    if isinstance(res.data.get("likes"), int):
        cols["hf_likes"] = res.data["likes"]
    if not is_space and isinstance(res.data.get("downloads"), int):
        cols["hf_downloads"] = res.data["downloads"]
    if not cols:
        return Outcome("failed", detail="no likes or downloads in the answer")
    return Outcome("ok", {day: cols})
