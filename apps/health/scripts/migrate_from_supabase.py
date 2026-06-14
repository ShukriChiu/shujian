#!/usr/bin/env python3
"""Migrate health.* data from Supabase to Railway/local Postgres."""

from __future__ import annotations

import argparse
import subprocess
import sys
import tempfile
from pathlib import Path

import psycopg2
from psycopg2.extras import RealDictCursor

TABLES = [
    "oura_daily",
    "oura_events",
    "oura_heartrate",
    "oura_personal_info",
    "oura_sync_state",
    "oura_oauth_tokens",
    "oura_webhook_events",
    "oura_webhook_subscriptions",
    "cgm_daily",
    "cgm_sync_state",
]


def count_rows(url: str, owner: str | None = None) -> dict[str, int]:
    counts: dict[str, int] = {}
    with psycopg2.connect(url, connect_timeout=30) as conn, conn.cursor(cursor_factory=RealDictCursor) as cur:
        for table in TABLES:
            try:
                if owner and table not in ("oura_oauth_tokens",):
                    cur.execute(f"SELECT COUNT(*) AS n FROM health.{table} WHERE owner = %s", (owner,))
                else:
                    cur.execute(f"SELECT COUNT(*) AS n FROM health.{table}")
                counts[table] = int(cur.fetchone()["n"])
            except Exception:
                conn.rollback()
                counts[table] = -1
    return counts


def migrate(source: str, target: str, owner: str | None) -> None:
    with tempfile.NamedTemporaryFile(suffix=".sql", delete=False) as tmp:
        dump_path = Path(tmp.name)

    cmd = [
        "pg_dump",
        source,
        "--schema=health",
        "--data-only",
        "--no-owner",
        "--no-privileges",
        "--disable-triggers",
        "-f",
        str(dump_path),
    ]
    print("Exporting health schema from source...")
    subprocess.run(cmd, check=True)

    print("Importing into target...")
    subprocess.run(["psql", target, "-v", "ON_ERROR_STOP=1", "-f", str(dump_path)], check=True)
    dump_path.unlink(missing_ok=True)

    print("\nRow counts (source → target):")
    src_counts = count_rows(source, owner)
    tgt_counts = count_rows(target, owner)
    for table in TABLES:
        print(f"  {table:30} {src_counts.get(table, -1):>8} → {tgt_counts.get(table, -1):>8}")


def main() -> None:
    p = argparse.ArgumentParser(description="Migrate health.* from Supabase to Railway PG")
    p.add_argument("--source", required=True, help="Supabase BRAIN_DATABASE_URI")
    p.add_argument("--target", required=True, help="Railway DATABASE_URL")
    p.add_argument("--owner", default="shujian")
    args = p.parse_args()
    migrate(args.source, args.target, args.owner)


if __name__ == "__main__":
    main()
