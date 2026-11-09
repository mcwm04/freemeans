import json
from pathlib import Path

import pytest

from crawler.fetch import Page

REPO = Path(__file__).resolve().parents[3]
TAXONOMY = json.loads((REPO / "data" / "taxonomy.json").read_text())


class FakeSite:
    """URL -> HTML. Unknown URLs answer 404."""

    def __init__(self, pages: dict[str, str]):
        self.pages = pages
        self.calls: list[str] = []

    def __call__(self, url: str) -> Page:
        self.calls.append(url)
        if url in self.pages:
            return Page(url, 200, self.pages[url], url)
        return Page(url, 404, error="HTTP 404")


@pytest.fixture
def taxonomy():
    return TAXONOMY


GOOD_DRAFT = {
    "name": "VoiceKit",
    "tagline": "Turn text into natural speech in 20 languages from your browser",
    "description": " ".join(["VoiceKit turns written text into spoken audio."] + ["It lets creators and teachers make voice-overs for videos and lessons without recording."] * 9),
    "categories": ["voice", "not-a-category"],
    "tasks": ["text-to-speech", "voice-over"],
    "best_for": ["Video voice-overs"],
    "platforms": ["web", "api"],
    "open_source": False, "repo_url": None, "license": None,
    "free_tier": {"type": "credits", "quota": {"value": 10000, "unit": "characters", "period": "month"},
                  "trial_days": None, "card_required": False, "signup_required": True, "watermark": None,
                  "commercial_use": False, "notes": None, "source_url": "https://voicekit.ai/pricing"},
    "pricing": {"cheapest_paid_usd": 5, "period": "month", "source_url": "https://voicekit.ai/pricing"},
    "evidence": {"free_tier.quota": "Free: 10,000 characters per month, no credit card."},
}

HOME = """<html><head><title>VoiceKit</title><script>var x=1</script></head><body>
<nav><a href="/pricing">Pricing</a> <a href="/docs">Docs</a> <a href="https://twitter.com/voicekit">X</a></nav>
<h1>VoiceKit</h1><p>Turn text into natural speech in 20 languages.</p><footer>© VoiceKit</footer></body></html>"""
PRICING = """<html><body><h1>Plans</h1><p>Free: 10,000 characters per month, no credit card.</p>
<p>Starter: $5 per month.</p></body></html>"""
DOCS = "<html><body><p>API docs. Rate limit: 2 requests per second.</p></body></html>"
