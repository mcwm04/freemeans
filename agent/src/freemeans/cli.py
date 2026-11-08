"""`freemeans` command line."""

from __future__ import annotations

import argparse
import getpass
import json
import sys
from pathlib import Path

from .catalog import find_repo_root, validate_catalog
from .config import load_config
from .meter import Meter
from .policy import PolicyError

DEFAULT_CONFIG = "freemeans.yaml"


def _cmd_serve(args: argparse.Namespace) -> int:
    import uvicorn

    from .router import Router
    from .server import create_app
    from .transport import HttpxTransport

    cfg = load_config(Path(args.config))
    if cfg.host not in ("127.0.0.1", "localhost", "::1"):
        print(f"warning: listening on {cfg.host}; anyone on your network could use your quotas.", file=sys.stderr)
    meter = Meter(cfg.db_path)
    router = Router(cfg, meter, HttpxTransport())
    print(f"Freemeans agent on http://{cfg.host}:{cfg.port}/v1  (catalog {cfg.catalog.version})")
    uvicorn.run(create_app(cfg, router, meter), host=cfg.host, port=cfg.port, log_level="warning")
    return 0


def _cmd_usage(args: argparse.Namespace) -> int:
    from .server import usage_report

    cfg = load_config(Path(args.config))
    rows = usage_report(cfg, Meter(cfg.db_path))
    if args.json:
        print(json.dumps(rows, indent=2))
        return 0
    for r in rows:
        badges = f"  [{', '.join(r['badges'])}]" if r["badges"] else ""
        print(f"{r['deployment']}  ({r['resource']}, verified {r['catalog_verified']}){badges}")
        for w in r["windows"]:
            approx = "≈" if w["method"] == "counted" else ""
            rem = "?" if w["remaining"] is None else f"{approx}{w['remaining']:g}"
            lim = "unpublished" if w["limit"] is None else f"{w['limit']:g}"
            reset = f"  resets {w['resets_at']}" if w["resets_at"] else ""
            print(f"    {w['metric']:<18} {rem:>10} / {lim:<12} {w['method']}{reset}")
    return 0


def _cmd_explain(args: argparse.Namespace) -> int:
    """Dry run: show how a request would be routed, without calling anyone."""
    from .router import Router

    cfg = load_config(Path(args.config))
    router = Router(cfg, Meter(cfg.db_path), transport=None)  # type: ignore[arg-type]
    body = {"messages": [{"role": "user", "content": "x" * args.prompt_chars}], "max_tokens": args.max_tokens}
    if args.tools:
        body["tools"] = [{"type": "function", "function": {"name": "noop", "parameters": {"type": "object"}}}]
    project = cfg.project(args.project)
    ranked, decisions = router.plan(args.model, body, project)
    print(f"project '{project.name}': {project}")
    for d in decisions:
        extra = f" score={d.score}" if d.score is not None else ""
        print(f"  {d.status:<9} {d.deployment:<28}{extra} {d.reason}")
    print("order:", " -> ".join(d.name for d in ranked) or "(none)")
    return 0


def _cmd_validate(args: argparse.Namespace) -> int:
    root = find_repo_root(Path(args.catalog).resolve().parent) or find_repo_root()
    schema_dir = Path(args.schemas) if args.schemas else (root / "packages" / "schema" if root else None)
    if schema_dir is None:
        print("Cannot find packages/schema; pass --schemas", file=sys.stderr)
        return 2
    data = json.loads(Path(args.catalog).read_text(encoding="utf-8"))
    errors = validate_catalog(data, schema_dir)
    if errors:
        print("\n".join(errors))
        return 1
    stale = [r["id"] for r in data["resources"] if any(
        x["signal_type"] == "third_party_snapshot" for x in r["limit_rules"])]
    print(f"OK: {len(data['resources'])} resources valid (catalog {data['version']}).")
    if stale:
        print(f"{len(stale)} resources rely on third-party snapshots and need official verification:")
        for s in stale:
            print("  -", s)
    return 0


def _cmd_keys(args: argparse.Namespace) -> int:
    from .keys import set_key

    value = getpass.getpass(f"Paste value for {args.key_env} (input hidden): ").strip()
    if not value:
        print("Nothing entered.", file=sys.stderr)
        return 1
    set_key(args.key_env, value)
    print(f"Saved {args.key_env} to your OS keychain.")
    return 0


def main(argv: list[str] | None = None) -> int:
    p = argparse.ArgumentParser(prog="freemeans", description="Freemeans local agent (prototype)")
    p.add_argument("--config", default=DEFAULT_CONFIG, help="path to freemeans.yaml")
    sub = p.add_subparsers(dest="cmd", required=True)

    sub.add_parser("serve", help="run the local OpenAI-compatible router").set_defaults(fn=_cmd_serve)

    u = sub.add_parser("usage", help="show quota used/left per deployment")
    u.add_argument("--json", action="store_true")
    u.set_defaults(fn=_cmd_usage)

    e = sub.add_parser("explain", help="dry-run routing for a request")
    e.add_argument("model", nargs="?", default="freemeans/auto")
    e.add_argument("--project", default="default")
    e.add_argument("--prompt-chars", type=int, default=400)
    e.add_argument("--max-tokens", type=int, default=512)
    e.add_argument("--tools", action="store_true")
    e.set_defaults(fn=_cmd_explain)

    v = sub.add_parser("validate-catalog", help="validate a catalog file against the schemas")
    v.add_argument("catalog")
    v.add_argument("--schemas")
    v.set_defaults(fn=_cmd_validate)

    k = sub.add_parser("keys", help="store a provider key in the OS keychain")
    k.add_argument("action", choices=["set"])
    k.add_argument("key_env", help="e.g. GROQ_API_KEY")
    k.set_defaults(fn=_cmd_keys)

    args = p.parse_args(argv)
    try:
        return args.fn(args)
    except (PolicyError, ValueError, KeyError) as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
