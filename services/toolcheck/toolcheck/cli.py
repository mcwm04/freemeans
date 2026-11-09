"""python -m toolcheck [--tools DIR] [--taxonomy FILE] [--schemas DIR]

Exit code 0 when there are no errors (warnings allowed), 1 otherwise.
"""
from __future__ import annotations

import argparse
from pathlib import Path

from .check import DEFAULT_SCHEMA_DIR, DEFAULT_TAXONOMY, DEFAULT_TOOLS_DIR, check_directory, load_directory


def main(argv: list[str] | None = None) -> int:
    p = argparse.ArgumentParser(prog="toolcheck", description="Validate the AI tools directory files.")
    p.add_argument("--tools", type=Path, default=DEFAULT_TOOLS_DIR)
    p.add_argument("--taxonomy", type=Path, default=DEFAULT_TAXONOMY)
    p.add_argument("--schemas", type=Path, default=DEFAULT_SCHEMA_DIR)
    p.add_argument("--strict", action="store_true", help="treat warnings as errors")
    args = p.parse_args(argv)

    report = check_directory(load_directory(args.tools, args.taxonomy), args.schemas)
    for w in report.warnings:
        print(f"warning  {w}")
    for e in report.errors:
        print(f"ERROR    {e}")
    failed = report.errors or (args.strict and report.warnings)
    print(f"\n{report.tools_checked} tool file(s) checked: {len(report.errors)} error(s), {len(report.warnings)} warning(s)"
          + (" — FAILED" if failed else " — OK"))
    return 1 if failed else 0
