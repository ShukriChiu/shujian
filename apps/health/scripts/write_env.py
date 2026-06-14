#!/usr/bin/env python3
"""Write apps/health/.env from Railway + local secret sources."""

from __future__ import annotations

import json
import subprocess
from pathlib import Path


def _grep(path: Path, key: str) -> str:
    if not path.exists():
        return ""
    for line in path.read_text().splitlines():
        if line.startswith(f"{key}="):
            return line.split("=", 1)[1].strip().strip('"').strip("'")
    return ""


def main() -> None:
    health_dir = Path(__file__).resolve().parents[1]
    repo = health_dir.parents[1]  # shujian monorepo root
    workspace_root = repo.parent  # shujian-coding

    railway = subprocess.run(
        ["railway", "variables", "--service", "Postgres", "--json"],
        cwd=repo,
        capture_output=True,
        text=True,
        check=True,
    )
    pg_vars = json.loads(railway.stdout)
    database_url = pg_vars.get("DATABASE_PUBLIC_URL") or pg_vars.get("DATABASE_URL", "")

    brain_env = workspace_root / "shujian-brain" / ".env"
    icancgm_env = workspace_root / "icancgm-cli" / ".env"
    agentservice_env = workspace_root / "sino-agentservice" / ".env"

    lines = [
        f"DATABASE_URL={database_url}",
        "HEALTH_OWNER=shujian",
        f"OURA_PAT={_grep(brain_env, 'OURA_PAT')}",
        f"SINO_USER_ID={_grep(icancgm_env, 'SINO_USER_ID') or _grep(brain_env, 'SINO_USER_ID')}",
        f"SINO_CLIENT_ID={_grep(agentservice_env, 'SINO_CLIENT_ID') or _grep(icancgm_env, 'SINO_CLIENT_ID')}",
        f"SINO_CLIENT_SECRET={_grep(agentservice_env, 'SINO_CLIENT_SECRET') or _grep(icancgm_env, 'SINO_CLIENT_SECRET')}",
        f"ICAN_USERNAME={_grep(agentservice_env, 'ICAN_USERNAME') or _grep(icancgm_env, 'ICAN_USERNAME')}",
        f"ICAN_PASSWORD={_grep(agentservice_env, 'ICAN_PASSWORD') or _grep(icancgm_env, 'ICAN_PASSWORD')}",
        "PORT=8090",
        "HOST=0.0.0.0",
        "ENABLE_SCHEDULER=false",
        "",
    ]
    (health_dir / ".env").write_text("\n".join(lines), encoding="utf-8")
    print(f"Wrote {health_dir / '.env'}")


if __name__ == "__main__":
    main()
