"""SINO iCan OAuth2 token lifecycle with DB-backed cache for Railway."""

from __future__ import annotations

import asyncio
import base64
import json
import logging
import os
import threading
from dataclasses import asdict, dataclass
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any

import httpx

from health.config import Settings, get_settings

log = logging.getLogger(__name__)

AUTH_PATH = "/api/sino-auth/oauth/token"
OAUTH_ROW_ID = "default"


def build_basic_auth_header(settings: Settings) -> str:
    if settings.sino_client_basic:
        return settings.sino_client_basic.strip()
    cid = settings.sino_client_id
    secret = settings.sino_client_secret
    if not cid or not secret:
        raise ValueError(
            "OAuth requires SINO_CLIENT_BASIC or SINO_CLIENT_ID + SINO_CLIENT_SECRET"
        )
    raw = f"{cid}:{secret}".encode()
    return "Basic " + base64.b64encode(raw).decode("ascii")


def _jwt_exp_utc(token: str) -> datetime | None:
    parts = token.split(".")
    if len(parts) < 2:
        return None
    payload_b64 = parts[1]
    pad = "=" * (-len(payload_b64) % 4)
    try:
        payload = json.loads(base64.urlsafe_b64decode(payload_b64 + pad).decode("utf-8"))
    except (ValueError, json.JSONDecodeError):
        return None
    exp = payload.get("exp")
    if exp is None:
        return None
    return datetime.fromtimestamp(int(exp), tz=timezone.utc)


def _normalize_username(username: str) -> str:
    u = username.strip()
    if "@" not in u:
        u = f"{u}@sinocare.com"
    return u


@dataclass
class TokenCache:
    access_token: str
    refresh_token: str
    expires_at: str
    username: str
    real_name: str | None = None

    @property
    def expires_dt(self) -> datetime:
        return datetime.fromisoformat(self.expires_at.replace("Z", "+00:00"))

    def is_expired(self) -> bool:
        return datetime.now(timezone.utc) >= self.expires_dt

    def expires_within(self, margin: timedelta) -> bool:
        return datetime.now(timezone.utc) + margin >= self.expires_dt


class SinoTokenProvider:
    """Thread-safe token holder; cache in Postgres (Railway) with file fallback."""

    def __init__(self, settings: Settings | None = None):
        self.settings = settings or get_settings()
        self._lock = threading.Lock()
        self._cache: TokenCache | None = None
        self._static_exp: datetime | None = None
        self._mode: str = "unset"

    def _cache_file_path(self) -> Path:
        p = self.settings.sino_token_cache_path
        if p:
            return Path(p).expanduser()
        return Path.home() / ".config" / "sino" / "health_token.json"

    def _load_db(self) -> TokenCache | None:
        try:
            from health.db import db_query

            rows = db_query(
                """
                SELECT access_token, refresh_token, expires_at, username, real_name
                FROM health.sino_oauth WHERE id = %s
                """,
                (OAUTH_ROW_ID,),
            )
            if not rows:
                return None
            r = rows[0]
            exp = r["expires_at"]
            if hasattr(exp, "isoformat"):
                exp_str = exp.isoformat()
            else:
                exp_str = str(exp)
            return TokenCache(
                access_token=r["access_token"],
                refresh_token=r["refresh_token"],
                expires_at=exp_str,
                username=r["username"],
                real_name=r.get("real_name"),
            )
        except Exception as e:
            log.debug("DB token cache miss: %s", e)
            return None

    def _save_db(self, cache: TokenCache) -> None:
        from health.db import db_exec

        db_exec(
            """
            INSERT INTO health.sino_oauth
                (id, access_token, refresh_token, expires_at, username, real_name, updated_at)
            VALUES (%s, %s, %s, %s, %s, %s, now())
            ON CONFLICT (id) DO UPDATE SET
                access_token = EXCLUDED.access_token,
                refresh_token = EXCLUDED.refresh_token,
                expires_at = EXCLUDED.expires_at,
                username = EXCLUDED.username,
                real_name = EXCLUDED.real_name,
                updated_at = now()
            """,
            (
                OAUTH_ROW_ID,
                cache.access_token,
                cache.refresh_token,
                cache.expires_dt,
                cache.username,
                cache.real_name,
            ),
        )

    def _load_disk(self) -> TokenCache | None:
        path = self._cache_file_path()
        if not path.exists():
            return None
        try:
            data = json.loads(path.read_text(encoding="utf-8"))
            return TokenCache(
                access_token=data["access_token"],
                refresh_token=data["refresh_token"],
                expires_at=data["expires_at"],
                username=data["username"],
                real_name=data.get("real_name"),
            )
        except (KeyError, json.JSONDecodeError, OSError) as e:
            log.warning("Could not load token file %s: %s", path, e)
            return None

    def _save_disk(self, cache: TokenCache) -> None:
        path = self._cache_file_path()
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(json.dumps(asdict(cache), indent=2, ensure_ascii=False), encoding="utf-8")
        try:
            os.chmod(path, 0o600)
        except OSError:
            pass

    def _persist(self, cache: TokenCache) -> None:
        if self.settings.database_url:
            try:
                self._save_db(cache)
                return
            except Exception as e:
                log.warning("DB token save failed, falling back to file: %s", e)
        self._save_disk(cache)

    def _load_cache(self) -> TokenCache | None:
        if self.settings.database_url:
            cache = self._load_db()
            if cache:
                return cache
        return self._load_disk()

    def _post_oauth(self, params: dict[str, str]) -> dict[str, Any]:
        auth = build_basic_auth_header(self.settings)
        with httpx.Client(
            base_url=self.settings.ican_base_url,
            timeout=self.settings.request_timeout_s,
        ) as http:
            r = http.post(AUTH_PATH, headers={"Authorization": auth}, params=params)
        if r.status_code >= 400:
            try:
                err = r.json()
                msg = (
                    err.get("error_description")
                    or err.get("msg")
                    or err.get("error")
                    or r.text
                )
            except json.JSONDecodeError:
                msg = r.text
            raise RuntimeError(f"OAuth HTTP {r.status_code}: {msg}")
        return r.json()

    @staticmethod
    def _parse_oauth_response(body: dict[str, Any]) -> tuple[str, str, datetime]:
        data: dict[str, Any] = body
        if isinstance(body.get("data"), dict) and body["data"].get("access_token"):
            data = body["data"]
        access = data.get("access_token")
        refresh = data.get("refresh_token")
        exp_in = data.get("expires_in")
        if not access or not refresh or exp_in is None:
            raise RuntimeError(f"Unexpected OAuth response: {list(body.keys())}")
        expires_at = datetime.now(timezone.utc) + timedelta(seconds=int(exp_in))
        return str(access), str(refresh), expires_at

    def _login_password(self) -> TokenCache:
        user = _normalize_username(self.settings.ican_username)
        pwd_b64 = base64.b64encode(self.settings.ican_password.encode()).decode("ascii")
        body = self._post_oauth(
            {
                "tenant_id": "000000",
                "scope": "all",
                "type": "account",
                "grant_type": "password",
                "username": user,
                "password": pwd_b64,
            }
        )
        access, refresh, exp = self._parse_oauth_response(body)
        real_name = body.get("real_name")
        if not real_name and isinstance(body.get("data"), dict):
            real_name = body["data"].get("real_name")
        cache = TokenCache(
            access_token=access,
            refresh_token=refresh,
            expires_at=exp.isoformat(),
            username=user,
            real_name=real_name,
        )
        self._persist(cache)
        log.info("OAuth password login OK; expires_at=%s", cache.expires_at)
        return cache

    def _login_refresh(self, refresh_token: str, username: str) -> TokenCache:
        body = self._post_oauth(
            {
                "tenant_id": "000000",
                "scope": "all",
                "grant_type": "refresh_token",
                "refresh_token": refresh_token,
            }
        )
        access, refresh, exp = self._parse_oauth_response(body)
        cache = TokenCache(
            access_token=access,
            refresh_token=refresh,
            expires_at=exp.isoformat(),
            username=username,
            real_name=None,
        )
        self._persist(cache)
        log.info("OAuth refresh OK; expires_at=%s", cache.expires_at)
        return cache

    def _oauth_configured(self) -> bool:
        has_basic = bool(self.settings.sino_client_basic) or (
            bool(self.settings.sino_client_id) and bool(self.settings.sino_client_secret)
        )
        has_creds = bool(self.settings.ican_username) and bool(self.settings.ican_password)
        return has_basic and has_creds

    def _ensure_fresh_unlocked(self) -> None:
        margin = timedelta(seconds=self.settings.sino_refresh_margin_seconds)

        if self._oauth_configured():
            self._mode = "oauth"
            if self._cache is None:
                self._cache = self._load_cache()
            if self._cache and not self._cache.is_expired():
                if self._cache.expires_within(margin):
                    try:
                        self._cache = self._login_refresh(
                            self._cache.refresh_token, self._cache.username
                        )
                    except Exception as e:
                        log.warning("Refresh failed, password login: %s", e)
                        self._cache = self._login_password()
                return
            if self._cache and self._cache.is_expired():
                try:
                    self._cache = self._login_refresh(
                        self._cache.refresh_token, self._cache.username
                    )
                    return
                except Exception as e:
                    log.warning("Refresh on expired cache failed: %s", e)
            self._cache = self._login_password()
            return

        has_basic = bool(self.settings.sino_client_basic) or (
            bool(self.settings.sino_client_id) and bool(self.settings.sino_client_secret)
        )
        if has_basic:
            if self._cache is None:
                self._cache = self._load_cache()
            if self._cache:
                self._mode = "cache_only"
                if self._cache.is_expired() or self._cache.expires_within(margin):
                    self._cache = self._login_refresh(
                        self._cache.refresh_token, self._cache.username
                    )
                return

        if self.settings.ican_token:
            self._mode = "static"
            self._static_exp = _jwt_exp_utc(self.settings.ican_token)
            return

        if self.settings.sino_access_token:
            self._mode = "static_env"
            return

        raise RuntimeError(
            "No SINO auth: set SINO_CLIENT_ID+SECRET + ICAN_USERNAME+ICAN_PASSWORD, "
            "or ICAN_TOKEN / SINO_ACCESS_TOKEN"
        )

    def get_token(self) -> str:
        with self._lock:
            self._ensure_fresh_unlocked()
            if self._cache:
                return self._cache.access_token
            if self.settings.ican_token:
                return self.settings.ican_token
            if self.settings.sino_access_token:
                return self.settings.sino_access_token
            raise RuntimeError("No token available")

    async def warmup(self) -> None:
        await asyncio.to_thread(self.get_token)

    async def proactive_tick(self) -> None:
        await asyncio.to_thread(self.get_token)

    def status(self) -> dict[str, Any]:
        exp: str | None = None
        if self._cache:
            exp = self._cache.expires_at
        elif self._static_exp:
            exp = self._static_exp.isoformat()
        return {
            "mode": self._mode,
            "expires_at": exp,
            "username": self._cache.username if self._cache else None,
            "cache": "postgres" if self.settings.database_url else "file",
        }


_provider: SinoTokenProvider | None = None


def init_token_provider(settings: Settings | None = None) -> SinoTokenProvider:
    global _provider
    _provider = SinoTokenProvider(settings)
    return _provider


def get_token_provider() -> SinoTokenProvider:
    if _provider is None:
        return init_token_provider()
    return _provider
