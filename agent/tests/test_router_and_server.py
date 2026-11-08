import asyncio

import pytest
from fastapi.testclient import TestClient

from freemeans.router import ClientRequestError, NoCapacityError
from freemeans.server import create_app

from .conftest import ok_body

BODY = {"messages": [{"role": "user", "content": "Hello"}], "max_tokens": 64}


def run(coro):
    return asyncio.run(coro)


def test_highest_quality_with_headroom_wins(setup):
    cfg, meter, transport, router = setup
    res = run(router.complete("freemeans/auto", BODY, cfg.project("default")))
    # groq-gpt-oss-120b has known limits at full headroom (1.0 x 1.0) and beats unknown-limit Gemini (0.5 x 1.0)
    assert res.deployment.name == "groq-gpt-oss-120b"


def test_client_project_never_goes_to_gemini_free(setup):
    cfg, meter, transport, router = setup
    ranked, decisions = router.plan("freemeans/auto", BODY, cfg.project("client-work"))
    assert "gemini-flash" not in [d.name for d in ranked]
    gem = next(d for d in decisions if d.deployment == "gemini-flash")
    assert "trains_on_data" in gem.reason


def test_eu_app_skips_eu_restricted(setup):
    cfg, meter, transport, router = setup
    ranked, _ = router.plan("freemeans/auto", BODY, cfg.project("eu-app"))
    assert "gemini-flash" not in [d.name for d in ranked]


def test_429_cools_down_and_falls_back_without_retrying_same_provider(setup, clock):
    cfg, meter, transport, router = setup
    transport.push("groq-gpt-oss-120b", 429, {"error": {"message": "rate limited"}}, {"retry-after": "20"})
    res = run(router.complete("freemeans/auto", BODY, cfg.project("default")))
    assert transport.calls.count("groq-gpt-oss-120b") == 1
    assert res.deployment.name != "groq-gpt-oss-120b"
    # Still cooling 10 s later -> skipped, not called
    clock.advance(10)
    transport.calls.clear()
    run(router.complete("freemeans/auto", BODY, cfg.project("default")))
    assert "groq-gpt-oss-120b" not in transport.calls
    # After Retry-After passes it is eligible again
    clock.advance(11)
    transport.calls.clear()
    res = run(router.complete("freemeans/auto", BODY, cfg.project("default")))
    assert res.deployment.name == "groq-gpt-oss-120b"


def test_header_driven_headroom_changes_ranking(setup):
    cfg, meter, transport, router = setup
    # Groq says only 5 of 1000 requests left today -> headroom 0.005.
    # OpenRouter (known limits, full headroom: 1.0 x 0.8) now ranks first, then Groq's 8B model (1.0 x 0.6),
    # then Gemini (unknown limits: 0.5 x 1.0). The nearly exhausted model drops to last.
    meter.record("groq-gpt-oss-120b", 10, 200, {"x-ratelimit-limit-requests": "1000",
                                                 "x-ratelimit-remaining-requests": "5",
                                                 "x-ratelimit-reset-requests": "3h"})
    ranked, _ = router.plan("freemeans/auto", BODY, cfg.project("default"))
    names = [d.name for d in ranked]
    assert names == ["openrouter-gemma", "groq-llama-8b", "gemini-flash", "groq-gpt-oss-120b"]


def test_all_exhausted_returns_no_capacity_with_retry(setup, clock):
    cfg, meter, transport, router = setup
    for name in ["groq-llama-8b", "groq-gpt-oss-120b"]:
        transport.push(name, 429, {}, {"retry-after": "45"})
    with pytest.raises(NoCapacityError) as ei:
        run(router.complete("freemeans/fast", BODY, cfg.project("default")))
    assert ei.value.retry_at == pytest.approx(clock() + 45)
    assert transport.calls.count("groq-llama-8b") == 1


def test_bad_request_is_not_retried_elsewhere(setup):
    cfg, meter, transport, router = setup
    transport.push("groq-gpt-oss-120b", 400, {"error": {"message": "bad"}})
    with pytest.raises(ClientRequestError):
        run(router.complete("freemeans/auto", BODY, cfg.project("default")))
    assert transport.calls == ["groq-gpt-oss-120b"]


def test_missing_key_is_skipped_with_reason(setup, monkeypatch):
    cfg, meter, transport, router = setup
    monkeypatch.delenv("GEMINI_API_KEY")
    import freemeans.router as r
    monkeypatch.setattr(r, "has_key", lambda k: k != "GEMINI_API_KEY")
    _, decisions = router.plan("freemeans/auto", BODY, cfg.project("default"))
    gem = next(d for d in decisions if d.deployment == "gemini-flash")
    assert gem.status == "skipped" and "GEMINI_API_KEY" in gem.reason


def test_server_endpoints(setup):
    cfg, meter, transport, router = setup
    client = TestClient(create_app(cfg, router, meter))
    assert client.get("/freemeans/health").json()["ok"] is True
    ids = [m["id"] for m in client.get("/v1/models").json()["data"]]
    assert "freemeans/auto" in ids

    r = client.post("/v1/chat/completions", json={**BODY, "model": "freemeans/auto"},
                    headers={"X-Freemeans-Project": "client-work"})
    assert r.status_code == 200
    assert r.headers["x-freemeans-project"] == "client-work"
    assert r.headers["x-freemeans-deployment"] != "gemini-flash"

    r = client.post("/v1/chat/completions", json={**BODY, "stream": True})
    assert r.status_code == 400

    r = client.post("/v1/chat/completions", json=BODY, headers={"X-Freemeans-Project": "nope"})
    assert r.status_code == 400

    usage = client.get("/freemeans/usage").json()["deployments"]
    groq = next(u for u in usage if u["deployment"] == r.headers.get("x-freemeans-deployment", "groq-gpt-oss-120b"))
    assert any(w["metric"] == "rpm" for w in groq["windows"])


def test_server_429_when_no_capacity(setup):
    cfg, meter, transport, router = setup
    for name in ["groq-llama-8b", "groq-gpt-oss-120b"]:
        transport.push(name, 429, {}, {"retry-after": "30"})
    client = TestClient(create_app(cfg, router, meter))
    r = client.post("/v1/chat/completions", json={**BODY, "model": "freemeans/fast"})
    assert r.status_code == 429
    assert r.headers["retry-after"] == "30"
    assert r.json()["error"]["type"] == "no_free_capacity"
