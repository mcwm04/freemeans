import pytest

from freemeans.catalog import Limit
from freemeans.meter import Meter, parse_duration, parse_rate_headers, parse_reset, parse_retry_after
from freemeans.policy import ProjectPolicy, blocking_reasons

from .conftest import Clock


@pytest.mark.parametrize("text,seconds", [
    ("2m59.56s", 179.56), ("7.66s", 7.66), ("14h12m", 51120), ("500ms", 0.5), ("2", 2.0), ("1h2m3s", 3723),
])
def test_parse_duration(text, seconds):
    assert parse_duration(text) == pytest.approx(seconds)


def test_parse_duration_rejects_garbage():
    assert parse_duration("soon") is None


def test_parse_reset_handles_epoch_ms_and_seconds():
    now = 1_794_000_000.0
    assert parse_reset("1794000060000", now) == pytest.approx(1_794_000_060.0)
    assert parse_reset("1794000060", now) == pytest.approx(1_794_000_060.0)
    assert parse_reset("30", now) == pytest.approx(now + 30)
    assert parse_reset("7.66s", now) == pytest.approx(now + 7.66)


def test_groq_headers_map_to_rpd_and_tpm():
    # Header names and example values from Groq's rate-limit docs
    h = {"x-ratelimit-limit-requests": "14400", "x-ratelimit-remaining-requests": "14370",
         "x-ratelimit-reset-requests": "2m59.56s", "x-ratelimit-limit-tokens": "18000",
         "x-ratelimit-remaining-tokens": "17997", "x-ratelimit-reset-tokens": "7.66s"}
    windows = {w.metric: w for w in parse_rate_headers(h, 1000.0)}
    assert windows["rpd"].limit == 14400 and windows["rpd"].remaining == 14370
    assert windows["rpd"].reset_at == pytest.approx(1179.56)
    assert windows["tpm"].remaining == 17997


def test_generic_headers_and_retry_after():
    h = {"X-RateLimit-Limit": "50", "X-RateLimit-Remaining": "0", "X-RateLimit-Reset": "1794003600000", "Retry-After": "12"}
    w = parse_rate_headers(h, 1_794_000_000.0)[0]
    assert (w.metric, w.limit, w.remaining) == ("requests", 50, 0)
    assert parse_retry_after(h, 0) == 12


def _lim(metric, value, window, kind="rolling", tz=None, at=None):
    return Limit(metric, value, window, kind, tz, at, True, "official_docs", "2026-11-08")


def test_counted_headroom_and_minute_window():
    clock = Clock()
    m = Meter(None, now=clock)
    limits = {"rpm": _lim("rpm", 4, "minute")}
    for _ in range(3):
        m.record("d", 100, 200)
    assert m.headroom("d", limits) == pytest.approx(0.25)
    m.record("d", 100, 200)
    ok, why = m.can_send("d", limits, 10)
    assert not ok and "rpm exhausted" in why
    clock.advance(61)
    assert m.can_send("d", limits, 10)[0]


def test_failed_calls_do_not_count_against_quota():
    m = Meter(None, now=Clock())
    limits = {"rpm": _lim("rpm", 2, "minute")}
    m.record("d", 0, 429)
    m.record("d", 0, 500)
    assert m.headroom("d", limits) == 1.0


def test_daily_window_resets_at_fixed_time_in_zone():
    clock = Clock(1_794_000_000.0)  # 2026-11-08 ~18:40 Pacific? any time works
    m = Meter(None, now=clock)
    lim = {"rpd": _lim("rpd", 10, "day", "fixed_daily", "America/Los_Angeles", "00:00")}
    m.record("d", 1, 200)
    assert m.remaining("d", lim)[0].remaining == 9
    reset = m.remaining("d", lim)[0].reset_at
    clock.t = reset + 1
    assert m.remaining("d", lim)[0].remaining == 10


def test_header_value_is_preferred_over_counting():
    clock = Clock()
    m = Meter(None, now=clock)
    limits = {"rpd": _lim("rpd", 1000, "day")}
    m.record("d", 50, 200, {"x-ratelimit-limit-requests": "1000", "x-ratelimit-remaining-requests": "10",
                            "x-ratelimit-reset-requests": "1h"})
    r = m.remaining("d", limits)[0]
    assert (r.method, r.remaining) == ("header", 10)
    m.record("d", 50, 200)  # one more call after the header was seen
    assert m.remaining("d", limits)[0].remaining == 9


def test_usage_survives_restart(tmp_path):
    clock = Clock()
    db = tmp_path / "u.sqlite3"
    Meter(db, now=clock).record("d", 100, 200)
    m2 = Meter(db, now=clock)
    assert m2.remaining("d", {"rpm": _lim("rpm", 5, "minute")})[0].remaining == 4


@pytest.mark.parametrize("policy,badges,blocked", [
    (ProjectPolicy(client_project=True), {"trains_on_data"}, True),
    (ProjectPolicy(), {"trains_on_data"}, False),
    (ProjectPolicy(commercial=True), {"non_commercial"}, True),
    (ProjectPolicy(eu_end_users=True), {"eu_restricted"}, True),
    (ProjectPolicy(users_adult=False), {"age_18_plus"}, True),
    (ProjectPolicy(production=True), {"not_for_production"}, True),
    (ProjectPolicy(), {"manual_only"}, True),
    (ProjectPolicy(), set(), False),
])
def test_policy_rules(policy, badges, blocked):
    assert bool(blocking_reasons(policy, badges)) is blocked


def test_header_readings_survive_restart(tmp_path):
    clock = Clock()
    db = tmp_path / "u.sqlite3"
    m1 = Meter(db, now=clock)
    m1.record("d", 50, 200, {"x-ratelimit-limit-requests": "1000", "x-ratelimit-remaining-requests": "10",
                             "x-ratelimit-reset-requests": "1h"})
    clock.advance(5)
    m1.record("d", 50, 200)  # a later call, after the header
    m2 = Meter(db, now=clock)
    r = m2.remaining("d", {"rpd": _lim("rpd", 1000, "day")})[0]
    assert (r.method, r.remaining) == ("header", 9)
