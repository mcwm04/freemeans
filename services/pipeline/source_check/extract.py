"""Turn a fetched page into plain text and look for a limit's number in it.

The check is deliberately simple and honest: it answers "does this page still state the
number we have on file, next to its unit?". It never guesses a new value on its own; when
a number is missing it collects the nearby sentences so a person can decide in the PR.
"""
from __future__ import annotations

import html
import re
from dataclasses import dataclass, field
from html.parser import HTMLParser

# Words that show which limit a number belongs to. Matched case-insensitively.
UNIT_WORDS: dict[str, list[str]] = {
    "rps": [r"per second", r"/\s*s(ec)?\b", r"\brps\b", r"requests? a second"],
    "rpm": [r"per minute", r"/\s*min", r"\brpm\b", r"requests? a minute", r"a minute"],
    "rpd": [r"per day", r"/\s*day", r"\brpd\b", r"daily", r"a day"],
    "requests_per_month": [r"per month", r"/\s*mo(nth)?", r"monthly", r"a month"],
    "tpm": [r"tokens? per minute", r"\btpm\b", r"tokens?/\s*min", r"per minute"],
    "tpd": [r"tokens? per day", r"\btpd\b", r"tokens?/\s*day", r"per day", r"daily"],
    "itpm": [r"input tokens? per minute", r"\bitpm\b"],
    "otpm": [r"output tokens? per minute", r"\botpm\b"],
    "neurons_per_day": [r"neurons?"],
    "inputs_per_minute": [r"inputs? per minute", r"per minute"],
    "session_hours": [r"hours?", r"\bhrs?\b"],
    "credit_usd": [r"credit", r"\$", r"usd", r"dollars?"],
}

NEAR = 120  # characters on each side of a number that count as "next to it"


class _TextParser(HTMLParser):
    SKIP = {"script", "style", "noscript", "svg", "template", "head"}
    BLOCK = {"p", "div", "li", "tr", "td", "th", "br", "h1", "h2", "h3", "h4", "h5", "h6", "section", "article", "table", "pre"}

    def __init__(self) -> None:
        super().__init__(convert_charrefs=True)
        self.parts: list[str] = []
        self.skip = 0

    def handle_starttag(self, tag, attrs):
        if tag in self.SKIP:
            self.skip += 1
        elif tag in self.BLOCK:
            self.parts.append("\n")

    def handle_endtag(self, tag):
        if tag in self.SKIP and self.skip:
            self.skip -= 1
        elif tag in self.BLOCK:
            self.parts.append("\n")

    def handle_data(self, data):
        if not self.skip:
            self.parts.append(data)


def page_text(body: str, content_type: str = "") -> str:
    """HTML → text; Markdown and plain text pass through. Whitespace is collapsed per line."""
    looks_html = "html" in content_type.lower() or re.search(r"<(html|body|div|p)\b", body[:5000], re.I)
    if looks_html:
        p = _TextParser()
        p.feed(body)
        text = "".join(p.parts)
    else:
        text = html.unescape(body)
    lines = (re.sub(r"[ \t ]+", " ", ln).strip() for ln in text.splitlines())
    return "\n".join(ln for ln in lines if ln)


def _trim(x: float) -> str:
    s = f"{x:.1f}".rstrip("0").rstrip(".")
    return s


def number_variants(value: float | int) -> list[str]:
    """Ways a page may write the same number: 14400 → 14400, 14,400, 14 400, 14.4K, 14.4k."""
    v = float(value)
    out: list[str] = []
    if v.is_integer():
        n = int(v)
        out += [str(n), f"{n:,}", f"{n:,}".replace(",", " "), f"{n:,}".replace(",", ".")]
        if n >= 1000 and (n * 10) % 1000 == 0:
            k = _trim(n / 1000)
            out += [f"{k}K", f"{k}k", f"{k} K", f"{k} k", f"{k} thousand"]
        if n >= 1_000_000 and (n * 10) % 1_000_000 == 0:
            m = _trim(n / 1_000_000)
            out += [f"{m}M", f"{m}m", f"{m} M", f"{m} million"]
    else:
        out.append(_trim(v) if abs(v * 10 - round(v * 10)) < 1e-9 else str(v))
    seen, uniq = set(), []
    for s in out:
        if s not in seen:
            seen.add(s)
            uniq.append(s)
    # Longer forms first so "1,000" is preferred over "1" inside it.
    return sorted(uniq, key=len, reverse=True)


def _number_pattern(variant: str) -> re.Pattern[str]:
    # Not part of a bigger number: no digit, comma-digit or dot-digit glued on either side.
    return re.compile(r"(?<![\d.,])" + re.escape(variant) + r"(?![\d])(?![.,]\d)", re.I)


@dataclass
class Match:
    status: str  # "near_unit" | "number_only" | "missing"
    variant: str | None = None
    snippet: str | None = None
    nearby: list[str] = field(default_factory=list)


def _snippet(text: str, start: int, end: int, pad: int = 80) -> str:
    a, b = max(0, start - pad), min(len(text), end + pad)
    s = text[a:b].replace("\n", " ")
    return ("…" if a else "") + s.strip() + ("…" if b < len(text) else "")


def unit_words(metric: str) -> list[str]:
    if metric.startswith("tool:"):  # directory tools: the quota's own unit (source_check/tools.py)
        from .tools import unit_patterns
        return unit_patterns(metric)
    return UNIT_WORDS.get(metric, [])


def find_limit(text: str, metric: str, value) -> Match:
    """Look for `value` in `text`, preferring a hit that sits next to the metric's unit words."""
    units = [re.compile(u, re.I) for u in unit_words(metric)]
    first_plain: Match | None = None
    for variant in number_variants(value):
        for m in _number_pattern(variant).finditer(text):
            window = text[max(0, m.start() - NEAR): m.end() + NEAR]
            if any(u.search(window) for u in units):
                return Match("near_unit", variant, _snippet(text, m.start(), m.end()))
            if first_plain is None:
                first_plain = Match("number_only", variant, _snippet(text, m.start(), m.end()))
    if first_plain:
        return first_plain
    return Match("missing", nearby=nearby_mentions(text, metric))


def nearby_mentions(text: str, metric: str, limit: int = 3) -> list[str]:
    """Sentences that mention the metric's unit next to some number, to help the reviewer."""
    out: list[str] = []
    for u in unit_words(metric):
        for m in re.finditer(u, text, re.I):
            window = text[max(0, m.start() - 60): m.end() + 60]
            if re.search(r"\d", window):
                s = _snippet(text, m.start(), m.end(), 70)
                if s not in out:
                    out.append(s)
            if len(out) >= limit:
                return out
    return out


def _norm(s: str) -> str:
    """Lower case, one space between words, straight quotes and dashes: so a phrase still
    matches when the page breaks the line or uses curly quotes."""
    s = (s.replace("\u2019", "'").replace("\u2018", "'").replace("\u201c", '"').replace("\u201d", '"')
          .replace("\u2013", "-").replace("\u2014", "-"))
    return re.sub(r"\s+", " ", s).strip().lower()


def find_phrase(text: str, phrase: str) -> Match:
    """Is the watch phrase (a date, an amount or a condition) still on the page?

    Whole-word match: "$100" does not match "$1000". Returns status "found" or "missing"."""
    t, p = _norm(text), _norm(phrase)
    if not p:
        return Match("missing")
    pre = r"(?<!\w)" if p[0].isalnum() else ""
    post = r"(?!\w)" if p[-1].isalnum() else ""
    m = re.search(pre + re.escape(p) + post, t)
    if not m:
        return Match("missing")
    return Match("found", phrase, _snippet(t, m.start(), m.end()))
