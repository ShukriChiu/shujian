from __future__ import annotations

from functools import lru_cache
from pathlib import Path

from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(
        env_file=".env",
        env_file_encoding="utf-8",
        extra="ignore",
    )

    database_url: str = ""
    health_owner: str = "shujian"
    oura_pat: str = ""
    sino_user_id: str = ""

    # SINO OAuth (service-level; shared across tenants for CGM API access)
    ican_base_url: str = "https://ican.sinocare.com"
    sino_client_basic: str = ""
    sino_client_id: str = ""
    sino_client_secret: str = ""
    ican_username: str = ""
    ican_password: str = ""
    ican_token: str = ""
    sino_access_token: str = ""
    sino_token_cache_path: str = ""
    sino_refresh_margin_seconds: int = 3600
    sino_token_refresh_loop_seconds: int = 120

    port: int = 8090
    host: str = "0.0.0.0"
    sync_cron_hour: int = 1
    enable_scheduler: bool = True
    request_timeout_s: float = 30.0

    @property
    def migrations_dir(self) -> Path:
        return Path(__file__).resolve().parents[2] / "migrations"


@lru_cache
def get_settings() -> Settings:
    return Settings()
