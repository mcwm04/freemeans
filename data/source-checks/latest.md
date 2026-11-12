# Source check · 2026-11-12

Catalog `0.1.0-seed`. Each limit's source page was fetched once and searched for the number on file.

| Result | Limits |
| --- | ---: |
| Possibly changed | 1 |
| Could not read the page | 1 |
| Still matches | 40 |
| Not published | 4 |
| Offers to re-check by hand | 6 |

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

## Could not read

- https://digiskills.pk: robots.txt could not be read (no connection), so the site is treated as closed (1 limit)

## Re-check by hand

Offers that are unverified, or were last checked more than 60 days ago. Open the provider's own page, confirm who qualifies, where, the dates and the price afterwards,
then set `last_verified` to today (and `status` to `active` for an unverified offer).

- `cursor.pro-student` Cursor Pro, 1 year free for students: unverified. File: `data/catalog/eligibility.json`
- `google.ai-plus-student` Google AI Plus, 12 months free for students: unverified. File: `data/catalog/eligibility.json`
- `google.startups-cloud` Google for Startups Cloud Program: unverified. File: `data/catalog/eligibility.json`
- `microsoft.startups` Microsoft for Startups Founders Hub: unverified. File: `data/catalog/eligibility.json`
- `mofept.cisco-netacad` MoFEPT and Cisco Networking Academy free courses: unverified. File: `data/catalog/eligibility.json`
- `openai.chatgpt-for-teachers` ChatGPT for Teachers: unverified. File: `data/catalog/eligibility.json`

---
Opened by the nightly source check (`.github/workflows/source-check.yml`). The bot never edits limits itself;
a person confirms every change. Pages that need JavaScript or block bots show up under *Could not read*.
