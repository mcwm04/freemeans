# Source check · 2026-11-13

Catalog `0.1.0-seed`. Each limit's source page was fetched once and searched for the number on file.

| Result | Limits |
| --- | ---: |
| Possibly changed | 1 |
| Could not read the page | 2 |
| Still matches | 44 |
| Not published | 4 |
| Offers to re-check by hand | 3 |

## Possibly changed: review these

The number we have on file is no longer on its source page. The provider may have changed the limit,
or the page may have been rewritten. Open the source, then edit the file named under each item in this PR:
update the value, set `verified_at` to today, and keep `source_url` pointing at the page you checked.
For a directory tool, also add a line to its `changelog` (it shows on the tool page).

### `google.ai-plus-student` · watch phrase “excluding Hong Kong, Macau, Tunisia, and the United States”
- Source: https://support.google.com/googleone/answer/17422238 (last verified 2026-11-12)
- File: `data/catalog/eligibility.json`
- The phrase is no longer on the page. The offer may have changed or ended: read the page, then update the dates, amounts and `status` on the record, fix its `watch` list, and set `last_verified` to today.

## Could not read

- https://openai.com/index/chatgpt-for-teachers/: HTTP 403 (1 limit)
- https://digiskills.pk: robots.txt could not be read (no connection), so the site is treated as closed (1 limit)

## Re-check by hand

Offers that are unverified, or were last checked more than 60 days ago. Open the provider's own page, confirm who qualifies, where, the dates and the price afterwards,
then set `last_verified` to today (and `status` to `active` for an unverified offer).

- `cursor.pro-student` Cursor Pro, 1 year free for students: unverified. File: `data/catalog/eligibility.json`
- `google.startups-cloud` Google for Startups Cloud Program: unverified. File: `data/catalog/eligibility.json`
- `mofept.cisco-netacad` MoFEPT and Cisco Networking Academy free courses: unverified. File: `data/catalog/eligibility.json`

---
Opened by the nightly source check (`.github/workflows/source-check.yml`). The bot never edits limits itself;
a person confirms every change. Pages that need JavaScript or block bots show up under *Could not read*.
