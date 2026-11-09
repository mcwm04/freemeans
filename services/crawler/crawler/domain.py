"""One site = one tool. Mirrors services/api/src/domain.js; both read packages/schema/site-key-cases.json in tests."""
from __future__ import annotations

import re
from urllib.parse import urlsplit

PATH_KEYED = {"github.com", "gitlab.com", "codeberg.org", "huggingface.co"}
SHARED_SUFFIXES = ("vercel.app", "netlify.app", "github.io", "pages.dev", "hf.space", "streamlit.app",
                   "replit.app", "onrender.com", "web.app", "firebaseapp.com", "herokuapp.com", "glitch.me",
                   "gradio.live", "fly.dev")
TWO_PART = {"co.uk", "org.uk", "ac.uk", "com.pk", "org.pk", "edu.pk", "gov.pk", "net.pk", "com.au", "co.in",
            "co.jp", "com.br", "co.za", "com.cn", "com.tr", "co.kr", "com.sg", "com.mx", "co.nz", "com.my", "com.ng", "co.id"}
TRACKING = re.compile(r"^(utm_.*|ref|fbclid|gclid|mc_cid|mc_eid)$", re.I)


def parse_site(value: str | None):
    s = str(value or "").strip()
    if not s:
        return None
    if not re.match(r"^[a-z][a-z0-9+.-]*:", s, re.I):
        s = "https://" + s
    try:
        parts = urlsplit(s)
    except ValueError:
        return None
    if parts.scheme.lower() not in ("http", "https") or " " in s:
        return None
    host = (parts.hostname or "").lower()
    if "." not in host or re.fullmatch(r"[\d.]+", host) or ":" in host or host == "localhost" or host.endswith(".local"):
        return None
    return parts


def site_key(value: str | None) -> str | None:
    parts = parse_site(value)
    if not parts:
        return None
    host = parts.hostname.lower()
    if host.startswith("www."):
        host = host[4:]
    path = [p for p in parts.path.lower().split("/") if p]
    if host == "huggingface.co" and path[:1] == ["spaces"]:
        return "/".join([host] + path[:3])
    if host in PATH_KEYED:
        return "/".join([host] + path[:2])
    if any(host == s or host.endswith("." + s) for s in SHARED_SUFFIXES):
        return host
    labels = host.split(".")
    n = 3 if ".".join(labels[-2:]) in TWO_PART else 2
    return ".".join(labels[-n:])


def clean_url(value: str) -> str | None:
    """Drop fragments and tracking parameters; keep the address otherwise as given."""
    parts = parse_site(value)
    if not parts:
        return None
    query = "&".join(q for q in parts.query.split("&") if q and not TRACKING.match(q.split("=")[0]))
    path = parts.path or "/"
    return f"{parts.scheme.lower()}://{parts.netloc.lower()}{path}" + (f"?{query}" if query else "")


def is_path_keyed(key: str) -> bool:
    return "/" in key
