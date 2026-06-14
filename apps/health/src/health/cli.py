"""Unified CLI for shujian-health."""

from __future__ import annotations

import argparse

from health import cgm, oura, storyline
from health.db import apply_migrations
from health.tenants import cmd_add, cmd_list, seed_default_tenant


def main() -> None:
    parser = argparse.ArgumentParser(description="Shujian Health — Oura + CGM + Storyline")
    sub = parser.add_subparsers(dest="cmd", required=True)

    sub.add_parser("init", help="Apply health schema migrations").set_defaults(func=_cmd_init)
    sub.add_parser("serve", help="Start FastAPI server").set_defaults(func=_cmd_serve)

    tenant_sub = sub.add_parser("tenant", help="Multi-tenant registry")
    tenant_cmds = tenant_sub.add_subparsers(dest="tenant_cmd", required=True)
    sp = tenant_cmds.add_parser("list", help="List tenants")
    sp.add_argument("--enabled-only", action="store_true")
    sp.set_defaults(func=cmd_list)
    sp = tenant_cmds.add_parser("add", help="Add or update tenant")
    sp.add_argument("--owner", required=True)
    sp.add_argument("--sino-user-id")
    sp.add_argument("--oura-pat")
    sp.add_argument("--display-name")
    sp.add_argument("--disable", action="store_true", help="Disable tenant")
    sp.set_defaults(func=cmd_add)

    oura_sub = sub.add_parser("oura", help="Oura Ring commands")
    oura_cmds = oura_sub.add_subparsers(dest="oura_cmd", required=True)
    oura_cmds.add_parser("init").set_defaults(func=oura.cmd_init)
    oura_cmds.add_parser("whoami").set_defaults(func=oura.cmd_whoami)
    sp = oura_cmds.add_parser("sync")
    sp.add_argument("--days", type=int, default=7)
    sp.add_argument("--start")
    sp.add_argument("--end")
    sp.add_argument("--resource")
    sp.add_argument("--resume", action="store_true")
    sp.add_argument("--include-heartrate", action="store_true")
    sp.add_argument("--owner")
    sp.add_argument("--all", dest="all_tenants", action="store_true")
    sp.set_defaults(func=oura.cmd_sync)
    sp = oura_cmds.add_parser("today")
    sp.add_argument("--owner")
    sp.set_defaults(func=oura.cmd_today)
    sp = oura_cmds.add_parser("trend")
    sp.add_argument("--days", type=int, default=30)
    sp.add_argument("--owner")
    sp.set_defaults(func=oura.cmd_trend)
    sp = oura_cmds.add_parser("raw")
    sp.add_argument("path")
    sp.set_defaults(func=oura.cmd_raw)

    cgm_sub = sub.add_parser("cgm", help="SINO CGM commands")
    cgm_cmds = cgm_sub.add_subparsers(dest="cgm_cmd", required=True)
    cgm_cmds.add_parser("init").set_defaults(func=cgm.cmd_init)
    sp = cgm_cmds.add_parser("sync")
    sp.add_argument("--days", type=int, default=7)
    sp.add_argument("--start")
    sp.add_argument("--end")
    sp.add_argument("--owner")
    sp.add_argument("--all", dest="all_tenants", action="store_true")
    sp.set_defaults(func=cgm.cmd_sync)
    sp = cgm_cmds.add_parser("today")
    sp.add_argument("--owner")
    sp.set_defaults(func=cgm.cmd_today)
    sp = cgm_cmds.add_parser("trend")
    sp.add_argument("--days", type=int, default=14)
    sp.add_argument("--owner")
    sp.set_defaults(func=cgm.cmd_trend)

    sp = sub.add_parser("storyline", help="Five-layer health storyline analysis")
    sp.add_argument("--days", type=int, default=14)
    sp.add_argument("--owner")
    sp.add_argument("--json", action="store_true")
    sp.set_defaults(func=storyline.cmd_storyline)

    args = parser.parse_args()
    args.func(args)


def _cmd_init(args: argparse.Namespace) -> None:
    applied = apply_migrations()
    seed_default_tenant()
    print(f"✅ health schema 已初始化: {', '.join(applied)}")


def _cmd_serve(args: argparse.Namespace) -> None:
    import uvicorn

    from health.config import get_settings

    settings = get_settings()
    uvicorn.run(
        "health.api:app",
        host=settings.host,
        port=settings.port,
        reload=False,
    )


if __name__ == "__main__":
    main()
