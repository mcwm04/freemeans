# Source check · 2026-11-11

Catalog `0.1.0-seed`. Each limit's source page was fetched once and searched for the number on file.

| Result | Limits |
| --- | ---: |
| Possibly changed | 1 |
| Still matches | 30 |
| Not published | 4 |

## Possibly changed: review these

The number we have on file is no longer on its source page. The provider may have changed the limit,
or the page may have been rewritten. Open the source, then edit the file named under each item in this PR:
update the value, set `verified_at` to today, and keep `source_url` pointing at the page you checked.
For a directory tool, also add a line to its `changelog` (it shows on the tool page).

### `digitalocean.signup-credit` · credit_usd = 200 per one_time
- Source: https://docs.digitalocean.com/platform/teams/refer-others (official_docs, last verified 2026-11-07)
- File: `data/catalog/seed.json`
- What the page says nearby now:
  > …you refer spends and pays for $25 of usage, your team receives $25 in credit. There is no limit to the amount of referral credit you can earn. **N…
  > …m receives $25 in credit. There is no limit to the amount of referral credit you can earn. **Note**: - We do not support the referral program for…
  > …-credit/index.html.md). Once the person you refer spends and pays for $25 of usage, your team receives $25 in credit. There is no limit to th…

---
Opened by the nightly source check (`.github/workflows/source-check.yml`). The bot never edits limits itself;
a person confirms every change. Pages that need JavaScript or block bots show up under *Could not read*.
