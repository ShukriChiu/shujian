from __future__ import annotations

from pathlib import Path
from typing import Any, Iterable, List, Optional

import psycopg2
from psycopg2.extras import RealDictCursor

from health.config import get_settings

MIGRATION_FILES = (
    "001_health_oura.sql",
    "002_health_oura_webhook.sql",
    "003_health_cgm.sql",
    "004_health_tenants.sql",
)


def require_database_url() -> str:
    url = get_settings().database_url.strip()
    if not url:
        raise RuntimeError("DATABASE_URL 未设置。见 apps/health/.env.example")
    return url


def db_conn():
    return psycopg2.connect(require_database_url(), connect_timeout=15)


def db_exec(sql: str, params: Optional[Iterable[Any]] = None) -> None:
    with db_conn() as conn, conn.cursor() as cur:
        cur.execute(sql, params)


def db_query(sql: str, params: Optional[Iterable[Any]] = None) -> List[dict[str, Any]]:
    with db_conn() as conn, conn.cursor(cursor_factory=RealDictCursor) as cur:
        cur.execute(sql, params)
        return [dict(r) for r in cur.fetchall()]


def apply_migrations(migrations_dir: Optional[Path] = None) -> list[str]:
    root = migrations_dir or get_settings().migrations_dir
    applied: list[str] = []
    for name in MIGRATION_FILES:
        path = root / name
        if not path.exists():
            raise FileNotFoundError(f"找不到 migration: {path}")
        sql = path.read_text(encoding="utf-8")
        with db_conn() as conn, conn.cursor() as cur:
            cur.execute(sql)
        applied.append(name)
    return applied


def count_table(schema: str, table: str, owner: Optional[str] = None) -> int:
    sql = f"SELECT COUNT(*) AS n FROM {schema}.{table}"
    params: tuple[Any, ...] | None = None
    if owner is not None:
        sql += " WHERE owner = %s"
        params = (owner,)
    rows = db_query(sql, params)
    return int(rows[0]["n"]) if rows else 0
