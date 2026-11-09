# services/toolcheck: directory file checks

Validates `data/tools/*.json` against `packages/schema/tool.schema.json` and
`data/taxonomy.json` against `taxonomy.schema.json`, then checks what a schema cannot:

- `slug` equals the file name; one file per site (GitHub and Hugging Face are keyed by repo);
- categories (1–3) and tasks (1–8) exist in the taxonomy; task ids never clash with category ids;
- tagline has no marketing words ("best", "revolutionary", …); description is 80–150 words;
- every free tier and price has `source_url` and `verified_at`, and no date is in the future;
- free-tier logic (`none` has no quota, `trial` uses `trial_days`, open source needs `repo_url`).

Errors fail CI; warnings (unknown alternatives, a tool with no external signal) do not.

```bash
pip install -e ".[dev]"
python -m toolcheck            # exit 1 on any error; --strict also fails on warnings
python -m pytest -q
```
