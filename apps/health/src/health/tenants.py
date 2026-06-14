"""Multi-tenant registry: owner -> sino_user_id / oura_pat."""

from __future__ import annotations

import argparse
from dataclasses import dataclass
from typing import Any

from health.config import get_settings
from health.db import db_exec, db_query


def resolve_owner(args: argparse.Namespace | None = None) -> str:
    if args is not None and getattr(args, "owner", None):
        return args.owner
    return get_settings().health_owner


@dataclass
class Tenant:
    owner: str
    sino_user_id: str | None
    oura_pat: str | None
    display_name: str | None
    enabled: bool


def list_tenants(enabled_only: bool = False) -> list[Tenant]:
    sql = """
        SELECT owner, sino_user_id, oura_pat, display_name, enabled
        FROM health.tenants
    """
    if enabled_only:
        sql += " WHERE enabled = true"
    sql += " ORDER BY owner"
    rows = db_query(sql)
    return [_row_to_tenant(r) for r in rows]


def get_tenant(owner: str) -> Tenant | None:
    rows = db_query(
        """
        SELECT owner, sino_user_id, oura_pat, display_name, enabled
        FROM health.tenants WHERE owner = %s
        """,
        (owner,),
    )
    return _row_to_tenant(rows[0]) if rows else None


def resolve_sino_user_id(owner: str) -> str:
    tenant = get_tenant(owner)
    if tenant and tenant.sino_user_id:
        return tenant.sino_user_id.strip()
    settings = get_settings()
    if owner == settings.health_owner and settings.sino_user_id:
        return settings.sino_user_id.strip()
    return ""


def resolve_oura_pat(owner: str) -> str:
    tenant = get_tenant(owner)
    if tenant and tenant.oura_pat:
        return tenant.oura_pat.strip()
    return get_settings().oura_pat.strip()


def upsert_tenant(
    owner: str,
    *,
    sino_user_id: str | None = None,
    oura_pat: str | None = None,
    display_name: str | None = None,
    enabled: bool = True,
) -> None:
    db_exec(
        """
        INSERT INTO health.tenants (owner, sino_user_id, oura_pat, display_name, enabled, updated_at)
        VALUES (%s, %s, %s, %s, %s, now())
        ON CONFLICT (owner) DO UPDATE SET
            sino_user_id = COALESCE(EXCLUDED.sino_user_id, health.tenants.sino_user_id),
            oura_pat = COALESCE(EXCLUDED.oura_pat, health.tenants.oura_pat),
            display_name = COALESCE(EXCLUDED.display_name, health.tenants.display_name),
            enabled = EXCLUDED.enabled,
            updated_at = now()
        """,
        (owner, sino_user_id, oura_pat, display_name, enabled),
    )


def seed_default_tenant() -> None:
    """Register HEALTH_OWNER from env if not already in tenants table."""
    settings = get_settings()
    owner = settings.health_owner
    if not owner:
        return
    existing = get_tenant(owner)
    if existing:
        return
    if settings.sino_user_id or settings.oura_pat:
        upsert_tenant(
            owner,
            sino_user_id=settings.sino_user_id or None,
            oura_pat=settings.oura_pat or None,
            display_name=owner,
        )


def _row_to_tenant(row: dict[str, Any]) -> Tenant:
    return Tenant(
        owner=row["owner"],
        sino_user_id=row.get("sino_user_id"),
        oura_pat=row.get("oura_pat"),
        display_name=row.get("display_name"),
        enabled=bool(row.get("enabled", True)),
    )


def cmd_list(args: argparse.Namespace) -> None:
    tenants = list_tenants(enabled_only=args.enabled_only)
    if not tenants:
        print("（无租户）先运行: health tenant add --owner ...")
        return
    for t in tenants:
        flags = []
        if t.sino_user_id:
            flags.append("cgm")
        if t.oura_pat:
            flags.append("oura")
        status = "on" if t.enabled else "off"
        print(f"  {t.owner:16} [{status}] {','.join(flags) or '—'}  sino={t.sino_user_id or '—'}")


def cmd_add(args: argparse.Namespace) -> None:
    if not args.owner:
        print("❌ --owner 必填", file=__import__("sys").stderr)
        raise SystemExit(2)
    upsert_tenant(
        args.owner,
        sino_user_id=args.sino_user_id,
        oura_pat=args.oura_pat,
        display_name=args.display_name or args.owner,
        enabled=not args.disable,
    )
    print(f"✅ 租户 {args.owner} 已保存")
