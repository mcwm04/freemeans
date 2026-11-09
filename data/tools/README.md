# data/tools: one published listing per file

`{slug}.json`, validated by `services/toolcheck` in CI (schema: `packages/schema/tool.schema.json`).
Git is the source of truth for listings: every change is a reviewable commit and the site rebuilds
from these files. Daily numbers (signals, scores, clicks) live in Neon, joined by `slug`.

- The slug never changes after publishing; URLs depend on it.
- Every free-tier or price fact needs `source_url` and `verified_at`. If a provider does not
  publish a number, the value is `null`, never a guess.
- `signals.*` tells the collector where to look. A `null` signal is skipped, not counted as zero.

The four files here (Ollama, ComfyUI, Whisper, llama.cpp) are starter records so the Phase 0
collector has real tools to measure. Their licences were checked in each repo on 9 Nov 2026. The
editor reviews them before the Phase 1 tool pages go live.
