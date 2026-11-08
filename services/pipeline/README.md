# services/pipeline: nightly source check

Every night, GitHub Actions runs `python -m source_check`. For each limit in the catalog it:

1. fetches the limit's `source_url`, once per page, honouring robots.txt, with a pause between pages on the same site and the user agent `FreemeansBot/0.2`;
2. turns the page into plain text (drops scripts and styles; Markdown passes through);
3. looks for the number on file in any common spelling (`14400`, `14,400`, `14.4K`), but never as part of a bigger number;
4. sorts the result into one of five groups:

| Result | Meaning | Opens a PR? |
| --- | --- | --- |
| confirmed | Number found next to its unit ("per minute", "RPD"…) | no |
| weak | Number found, but not next to its unit | no (listed in the report) |
| missing | Number no longer on the page | **yes** |
| unreachable | Page blocked, failed, or needs JavaScript | no (listed) |
| skipped | Limit not published (value is null) | no |

When something is **missing**, the workflow opens one pull request (branch `bot/source-check`). It contains the report, including the sentences on the page that now mention that kind of limit. A person edits `data/catalog/seed.json` in the PR. The bot never changes a limit itself.

```bash
python -m source_check --catalog ../../data/catalog/seed.json --out-dir ../../data/source-checks
python -m pytest -q     # 12 tests, no network
```

Standard library only: no packages to install for the check itself.
