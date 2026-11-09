# Freemeans

**Free means you can build.** · freemeans.com

Freemeans helps builders run projects on **their own** free AI quotas. It knows which free tiers exist, what their limits and rules are, and it routes each request to the provider with the most headroom. It never breaks a provider's terms.

The repo so far (Step 1 + Step 2):

| Part | Folder | Status |
| --- | --- | --- |
| JSON schemas for `badge`, `limit_rule`, `resource`, `catalog` | `packages/schema/` | ✅ Step 1 |
| Seed catalog: 15 free resources, every limit with source link + date | `data/catalog/seed.json` | ✅ Step 1 (12 of 15 still rely on third-party snapshots) |
| Local agent: free-aware router, usage meter, policy engine, CLI | `agent/` | ✅ Step 1, 41 tests |
| Brand: design tokens + logos | `packages/brand/` | ✅ Step 2 |
| Website (Astro, static) for Cloudflare Pages | `apps/web/` | ✅ Step 2, 9 tests |
| API (`/catalog`, `/resources/:id`, `/waitlist`) on Cloudflare Workers | `services/api/` | ✅ Step 2, 12 tests |
| Neon Postgres schema, migration, seed loader | `db/` | ✅ Step 2, 7 tests |
| Nightly source check + GitHub Actions PR | `services/pipeline/`, `.github/workflows/` | ✅ Step 2, 17 tests |
| AI tools directory, Phase 0: tool schema, taxonomy (25 categories, 80 tasks), `toolcheck` | `packages/schema/`, `data/`, `services/toolcheck/` | ✅ 33 tests · [docs/DIRECTORY.md](docs/DIRECTORY.md) |
| Directory tables (`002_directory.sql`) + nightly signal collector with 2-year backfill | `db/`, `services/signals/` | ✅ 30 tests |
| Directory pages (M1–M3): `/tools/`, tool, category and task pages, filters, Pagefind search, freshness | `apps/web/`, `services/pipeline/` | ✅ web 29 tests |
| `/go/{slug}` click counting (M4) | `services/api/` | ✅ API 18 tests |
| Alerts, recipes, dashboard, admin console | `services/alerts/`, `recipes/` | ⏳ later steps |

**Deploy everything for $0, no card:** [docs/DEPLOY.md](docs/DEPLOY.md).

```
             freemeans.com (Cloudflare Pages, static)      api.freemeans.com (Cloudflare Workers)
 browser ──►  home · catalog · 15 resource pages  ──form──►  /catalog  /resources/:id  /waitlist
                        ▲ built from                                   │ HTTPS (Neon driver)
                        │                                              ▼
              data/catalog/seed.json  ── npm run load-seed ──►  Neon Postgres (Singapore)
                        ▲
   GitHub Actions, nightly 02:17 PKT: fetch each source page → number gone? → one review PR
```

## How it works

```
your app ──► http://127.0.0.1:4000/v1 (OpenAI-compatible)
               │
               ├─ 1. policy filter   (project rules vs. resource badges)
               ├─ 2. capability check (context size, tools)
               ├─ 3. skip cooling / exhausted providers
               ├─ 4. rank by headroom × quality
               └─ 5. send; on 429 → cool that provider down, try the NEXT one
                        ▲
     keys stay here (env vars or OS keychain), never sent anywhere else
```

**Quota tracking** uses only official channels:

| Method | Shown as | Example |
| --- | --- | --- |
| Provider rate-limit headers | exact (`header`) | Groq: `x-ratelimit-remaining-requests` (per day), `x-ratelimit-remaining-tokens` (per minute) |
| Own count vs. catalog limit | estimate `≈` (`counted`) | OpenRouter `:free`: 20/min, 50/day |
| Nothing published, nothing configured | `?` (`unknown`) | Gemini free tier: copy your limits from AI Studio into `limits_override` |

**Policy rules (Chapter 4 of the plan, enforced in code):**

| Badge on a resource | Blocked when the project is… |
| --- | --- |
| `trains_on_data` (e.g. Gemini free tier) | `client_project: true` |
| `non_commercial` (e.g. Cohere trial key) | `commercial: true` or `client_project: true` |
| `eu_restricted` (e.g. Gemini free tier) | `eu_end_users: true` |
| `age_18_plus` | `users_adult: false` |
| `not_for_production` | `production: true` |
| `manual_only` (e.g. Colab) | always: cannot even be configured |

The agent also **refuses to start** if a config uses two different keys for the same provider. One account per provider is the rule: pooling accounts to multiply free quota breaks provider terms.

## Quick start

Requires Python 3.10+.

```bash
cd agent
python -m venv .venv
# Windows: .venv\Scripts\activate     macOS/Linux: source .venv/bin/activate
pip install -e ".[dev]"

python -m pytest -q                      # 41 tests, no network needed

copy freemeans.example.yaml freemeans.yaml   # Windows  (macOS/Linux: cp)
```

Add your keys. Use only the providers you have accounts for; missing keys are skipped with a reason.

```bash
# Option A: environment variables (Windows PowerShell shown)
$env:GROQ_API_KEY="gsk_..."
$env:GEMINI_API_KEY="..."
$env:OPENROUTER_API_KEY="sk-or-..."

# Option B: OS keychain (Windows Credential Manager / macOS Keychain)
freemeans keys set GROQ_API_KEY
```

Check how a request would be routed, without calling anyone:

```bash
freemeans explain --project client-work
#   candidate groq-gpt-oss-120b   score=1.0
#   skipped   gemini-flash        policy: trains_on_data: client projects never go to tiers that may train on prompts
#   ...
```

Run the router and point any OpenAI client at it:

```bash
freemeans serve                  # http://127.0.0.1:4000/v1
```

```python
from openai import OpenAI
client = OpenAI(base_url="http://127.0.0.1:4000/v1", api_key="unused")
resp = client.chat.completions.create(
    model="freemeans/auto",
    messages=[{"role": "user", "content": "Hello"}],
    extra_headers={"X-Freemeans-Project": "client-work"},
)
```

Each response carries `x-freemeans-deployment` and `x-freemeans-resource` headers, showing which free tier served it.

See quota left:

```bash
freemeans usage            # or GET http://127.0.0.1:4000/freemeans/usage
```

Validate the catalog after editing it:

```bash
freemeans validate-catalog ../data/catalog/seed.json
```

## Endpoints

| Method | Path | Purpose |
| --- | --- | --- |
| POST | `/v1/chat/completions` | OpenAI-style chat (non-streaming). Header `X-Freemeans-Project` picks the policy. |
| GET | `/v1/models` | Logical models (`freemeans/auto`, `freemeans/fast`) and deployments |
| GET | `/freemeans/usage` | Used / left / resets per deployment, with method |
| GET | `/freemeans/health` | Liveness + catalog version |

When no provider can take a request, the router answers **HTTP 429** with `Retry-After` and a `decisions` list explaining why each provider was skipped.

## Known limitations (prototype)

- **No streaming** yet (`stream: true` returns 400).
- **Only OpenAI-compatible endpoints** (Groq, Gemini, OpenRouter, Mistral, SambaNova, NVIDIA). The transport is pluggable (`transport.py`), so a LiteLLM-backed transport can be added for other providers.
- **Catalog freshness:** 12 of 15 resources use third-party snapshots (dated Oct 2026, one May 2026). `validate-catalog` lists them. The freshness pipeline (later step) upgrades them to official sources.
- **Model IDs** in `freemeans.example.yaml` (e.g. `gemini-3.8-flash`, `google/gemma-4-31b-it:free`) come from Oct 2026 sources. Check current IDs before use.
- Token estimates for counting use ~4 characters per token. Provider headers, where available, override the estimate.
- Not yet tested against the live provider APIs: this build environment has no access to them. It was tested end-to-end against a local mock that sends Groq's documented headers. Your first run with real keys is the live test.

## Layout

```
packages/schema/   JSON Schemas (shared by agent, API, pipeline)
packages/brand/    design tokens (tokens.json) + logos, the site's CSS is generated from them
data/catalog/      seed catalog: the single source for site, API and database
data/source-checks/ dated reports from the nightly source check
agent/             freemeans CLI + local router (Python package)
apps/web/          Astro static site for Cloudflare Pages
services/api/      Cloudflare Workers API (JavaScript)
db/                Neon Postgres migrations + seed loader
services/pipeline/ nightly source check (Python, standard library only)
.github/workflows/ ci.yml (all tests) · source-check.yml (nightly)
docs/DEPLOY.md     step-by-step $0 deployment
services/alerts/   (later) drift alerts: email + Telegram
recipes/           (later) tested $0 stack recipes
infra/             (later)
```

## Run every test

```bash
cd agent && pip install -e ".[dev]" && python -m pytest -q && cd ..        # 41
cd services/pipeline && python -m pytest -q && cd ../..                     # 17
cd db && npm ci && npm test && cd ..                                        # 7
cd services/api && npm ci && npm test && cd ../..                           # 12
cd apps/web && npm ci && npm test && cd ../..                               # 9
```
