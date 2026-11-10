"""Command line: python -m source_check --catalog ../../data/catalog/seed.json --out-dir ../../data/source-checks

Exit code is 0 whether or not changes were found; the workflow reads `changes=true|false`
from $GITHUB_OUTPUT to decide whether to open a pull request.
"""
from __future__ import annotations

import argparse
import datetime as dt
import json
import os
import sys
from pathlib import Path

from .check import check_catalog, summary
from .report import markdown, record
from .tools import tools_as_resources


def main(argv: list[str] | None = None) -> int:
    p = argparse.ArgumentParser(prog="source_check", description="Check that catalog limits still appear on their source pages.")
    p.add_argument("--catalog", default="../../data/catalog/seed.json")
    p.add_argument("--out-dir", default="../../data/source-checks")
    p.add_argument("--tools", default="../../data/tools", help="directory tool files (M3); '' to skip")
    p.add_argument("--date", default=dt.date.today().isoformat())
    p.add_argument("--github-output", default=os.environ.get("GITHUB_OUTPUT"))
    args = p.parse_args(argv)

    catalog = json.loads(Path(args.catalog).read_text(encoding="utf-8"))
    if args.tools:
        catalog = {**catalog, "resources": catalog["resources"] + tools_as_resources(Path(args.tools))}
    results = check_catalog(catalog)
    s = summary(results)
    out = Path(args.out_dir)
    out.mkdir(parents=True, exist_ok=True)

    report = markdown(results, args.date, catalog.get("version", "?"))
    changed = s.get("missing", 0) > 0
    # The latest run is always written (useful as a CI artifact); the dated report only when
    # something needs review, so the repo history shows exactly the runs that mattered.
    (out / "latest.json").write_text(record(results, args.date, catalog.get("version", "?")), encoding="utf-8")
    (out / "latest.md").write_text(report, encoding="utf-8")
    if changed:
        (out / f"{args.date}.md").write_text(report, encoding="utf-8")

    print(" · ".join(f"{k}: {v}" for k, v in sorted(s.items())))
    if args.github_output:
        with open(args.github_output, "a", encoding="utf-8") as fh:
            fh.write(f"changes={'true' if changed else 'false'}\n")
            fh.write(f"missing={s.get('missing', 0)}\n")
            fh.write(f"report={(out / (args.date + '.md') if changed else out / 'latest.md').resolve()}\n")
    return 0


if __name__ == "__main__":
    sys.exit(main())
