"""三诺 OAuth 凭证：.env 优先，缺项时从 health.sino_oauth_config 补全。"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any

from health.config import Settings, get_settings
from health.db import db_exec, db_query

CONFIG_ROW_ID = "default"


@dataclass
class OAuthCredentials:
    sino_client_id: str
    sino_client_secret: str
    sino_client_basic: str
    ican_username: str
    ican_password: str

    def oauth_ready(self) -> bool:
        has_basic = bool(self.sino_client_basic) or (
            bool(self.sino_client_id) and bool(self.sino_client_secret)
        )
        has_creds = bool(self.ican_username) and bool(self.ican_password)
        return has_basic and has_creds


def _row_from_db() -> dict[str, Any] | None:
    try:
        rows = db_query(
            """
            SELECT sino_client_id, sino_client_secret, sino_client_basic,
                   ican_username, ican_password, updated_at
            FROM health.sino_oauth_config WHERE id = %s
            """,
            (CONFIG_ROW_ID,),
        )
        return dict(rows[0]) if rows else None
    except Exception:
        return None


def _pick(env_val: str, db_val: str | None) -> str:
    v = (env_val or "").strip()
    if v:
        return v
    return (db_val or "").strip()


def effective_credentials(settings: Settings | None = None) -> OAuthCredentials:
    s = settings or get_settings()
    row = _row_from_db()
    db = row or {}
    return OAuthCredentials(
        sino_client_id=_pick(s.sino_client_id, db.get("sino_client_id")),
        sino_client_secret=_pick(s.sino_client_secret, db.get("sino_client_secret")),
        sino_client_basic=_pick(s.sino_client_basic, db.get("sino_client_basic")),
        ican_username=_pick(s.ican_username, db.get("ican_username")),
        ican_password=_pick(s.ican_password, db.get("ican_password")),
    )


def config_source(settings: Settings | None = None) -> str:
    """凭证来源：env / db / mixed / none"""
    s = settings or get_settings()
    row = _row_from_db()
    db = row or {}
    env_keys = (
        "sino_client_id",
        "sino_client_secret",
        "sino_client_basic",
        "ican_username",
        "ican_password",
    )
    env_set = any(getattr(s, k).strip() for k in env_keys if hasattr(s, k))
    db_set = any((db.get(k) or "").strip() for k in env_keys)
    if env_set and db_set:
        return "mixed"
    if env_set:
        return "env"
    if db_set or effective_credentials(settings).oauth_ready():
        return "db"
    return "none"


def config_status(settings: Settings | None = None) -> dict[str, Any]:
    creds = effective_credentials(settings)
    src = config_source(settings)
    row = _row_from_db()
    updated_at = None
    if row and row.get("updated_at"):
        ts = row["updated_at"]
        updated_at = ts.isoformat() if hasattr(ts, "isoformat") else str(ts)

    def hint(v: str) -> str | None:
        v = v.strip()
        if not v:
            return None
        if len(v) <= 4:
            return "****"
        return f"{'*' * max(4, len(v) - 4)}{v[-4:]}"

    return {
        "source": src,
        "configured": creds.oauth_ready(),
        "has_client_id": bool(creds.sino_client_id or creds.sino_client_basic),
        "has_client_secret": bool(creds.sino_client_secret or creds.sino_client_basic),
        "has_username": bool(creds.ican_username),
        "has_password": bool(creds.ican_password),
        "client_id_hint": hint(creds.sino_client_id),
        "username_hint": hint(creds.ican_username),
        "db_updated_at": updated_at,
    }


def save_credentials(
    *,
    sino_client_id: str,
    sino_client_secret: str,
    ican_username: str,
    ican_password: str,
    sino_client_basic: str = "",
) -> None:
    db_exec(
        """
        INSERT INTO health.sino_oauth_config (
            id, sino_client_id, sino_client_secret, sino_client_basic,
            ican_username, ican_password, updated_at
        ) VALUES (%s, %s, %s, %s, %s, %s, now())
        ON CONFLICT (id) DO UPDATE SET
            sino_client_id = EXCLUDED.sino_client_id,
            sino_client_secret = EXCLUDED.sino_client_secret,
            sino_client_basic = EXCLUDED.sino_client_basic,
            ican_username = EXCLUDED.ican_username,
            ican_password = EXCLUDED.ican_password,
            updated_at = now()
        """,
        (
            CONFIG_ROW_ID,
            sino_client_id.strip() or None,
            sino_client_secret.strip() or None,
            sino_client_basic.strip() or None,
            ican_username.strip() or None,
            ican_password.strip() or None,
        ),
    )
