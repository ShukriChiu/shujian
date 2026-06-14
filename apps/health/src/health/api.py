"""FastAPI HTTP surface for shujian-health."""

from __future__ import annotations

import asyncio
import io
import logging
from contextlib import asynccontextmanager, redirect_stdout
from typing import Any

from fastapi import FastAPI, HTTPException, Query
from pydantic import BaseModel

from health import cgm, oura, storyline
from health.config import get_settings
from health.db import apply_migrations, count_table, db_query, require_database_url
from health.scheduler import shutdown_scheduler, start_scheduler
from health.tenants import (
    Tenant,
    get_tenant,
    list_tenants,
    seed_default_tenant,
    upsert_tenant,
)
from health.token_provider import get_token_provider, init_token_provider

log = logging.getLogger(__name__)


class SyncRequest(BaseModel):
    days: int = 7
    include_heartrate: bool = False
    sync_cgm: bool = True
    owner: str | None = None
    all_tenants: bool = False


class TenantUpsertRequest(BaseModel):
    owner: str
    sino_user_id: str | None = None
    oura_pat: str | None = None
    display_name: str | None = None
    enabled: bool = True


def _capture(fn, *args, **kwargs) -> str:
    buf = io.StringIO()
    with redirect_stdout(buf):
        fn(*args, **kwargs)
    return buf.getvalue()


def _tenant_dict(t: Tenant) -> dict[str, Any]:
    return {
        "owner": t.owner,
        "sino_user_id": t.sino_user_id,
        "oura_pat_set": bool(t.oura_pat),
        "display_name": t.display_name,
        "enabled": t.enabled,
    }


@asynccontextmanager
async def lifespan(app: FastAPI):
    settings = get_settings()
    logging.basicConfig(
        level=logging.INFO,
        format="%(asctime)s %(levelname)s %(name)s: %(message)s",
    )
    provider = init_token_provider(settings)
    try:
        await provider.warmup()
        log.info("SINO auth ready: %s", provider.status())
    except Exception:
        log.warning("SINO token warmup skipped (OAuth may be unset)")

    async def token_refresh_loop() -> None:
        while True:
            await asyncio.sleep(max(30, settings.sino_token_refresh_loop_seconds))
            try:
                await provider.proactive_tick()
            except asyncio.CancelledError:
                raise
            except Exception:
                log.exception("background token refresh failed")

    refresh_task = asyncio.create_task(token_refresh_loop())
    if settings.enable_scheduler:
        start_scheduler()
    try:
        yield
    finally:
        refresh_task.cancel()
        try:
            await refresh_task
        except asyncio.CancelledError:
            pass
        shutdown_scheduler()


app = FastAPI(title="Shujian Health", version="0.2.0", lifespan=lifespan)


@app.get("/healthz")
def healthz() -> dict[str, bool]:
    try:
        require_database_url()
        db_query("SELECT 1")
        return {"ok": True}
    except Exception as exc:
        raise HTTPException(status_code=503, detail=str(exc)) from exc


@app.get("/api/health/auth")
def api_auth() -> dict[str, Any]:
    try:
        return get_token_provider().status()
    except Exception as exc:
        return {"mode": "unavailable", "error": str(exc)}


@app.post("/api/health/init")
def api_init() -> dict[str, Any]:
    applied = apply_migrations()
    seed_default_tenant()
    return {"ok": True, "migrations": applied}


@app.get("/api/health/tenants")
def api_list_tenants(enabled_only: bool = False) -> dict[str, Any]:
    tenants = list_tenants(enabled_only=enabled_only)
    return {"tenants": [_tenant_dict(t) for t in tenants]}


@app.get("/api/health/tenants/{owner}")
def api_get_tenant(owner: str) -> dict[str, Any]:
    t = get_tenant(owner)
    if not t:
        raise HTTPException(status_code=404, detail=f"tenant {owner} not found")
    return _tenant_dict(t)


@app.post("/api/health/tenants")
def api_upsert_tenant(body: TenantUpsertRequest) -> dict[str, Any]:
    upsert_tenant(
        body.owner,
        sino_user_id=body.sino_user_id,
        oura_pat=body.oura_pat,
        display_name=body.display_name,
        enabled=body.enabled,
    )
    t = get_tenant(body.owner)
    return {"ok": True, "tenant": _tenant_dict(t) if t else None}


@app.post("/api/health/sync")
def api_sync(body: SyncRequest) -> dict[str, Any]:
    seed_default_tenant()
    args = argparse_namespace(
        days=body.days,
        include_heartrate=body.include_heartrate,
        owner=body.owner,
        all_tenants=body.all_tenants,
    )
    oura.cmd_sync(args)
    cgm_result = "skipped"
    if body.sync_cgm:
        try:
            cgm.cmd_sync(args)
            cgm_result = "ok"
        except SystemExit:
            cgm_result = "auth_required"
        except Exception as exc:
            cgm_result = f"error: {exc}"
    return {"ok": True, "oura": "ok", "cgm": cgm_result}


@app.get("/api/health/today")
def api_today(owner: str | None = Query(None)) -> dict[str, str]:
    args = argparse_namespace(owner=owner)
    return {
        "owner": owner or get_settings().health_owner,
        "oura": _capture(oura.cmd_today, args),
        "cgm": _capture(cgm.cmd_today, args),
    }


@app.get("/api/health/trend")
def api_trend(
    source: str = Query("oura", pattern="^(oura|cgm)$"),
    days: int = Query(30, ge=1, le=365),
    owner: str | None = Query(None),
) -> dict[str, str]:
    args = argparse_namespace(days=days, owner=owner)
    if source == "oura":
        return {
            "source": "oura",
            "owner": owner or get_settings().health_owner,
            "text": _capture(oura.cmd_trend, args),
        }
    return {
        "source": "cgm",
        "owner": owner or get_settings().health_owner,
        "text": _capture(cgm.cmd_trend, args),
    }


@app.get("/api/health/storyline")
def api_storyline(
    days: int = Query(14, ge=1, le=365),
    as_json: bool = False,
    owner: str | None = Query(None),
) -> Any:
    if as_json:
        return load_storyline_json(days, owner=owner)
    args = argparse_namespace(days=days, owner=owner)
    args.json = as_json
    return {
        "owner": owner or get_settings().health_owner,
        "text": _capture(storyline.cmd_storyline, args),
    }


@app.get("/api/health/stats")
def api_stats(owner: str | None = Query(None)) -> dict[str, Any]:
    owner_key = owner or get_settings().health_owner
    tables = [
        "oura_daily",
        "oura_events",
        "oura_heartrate",
        "oura_personal_info",
        "oura_sync_state",
        "cgm_daily",
        "cgm_sync_state",
    ]
    counts = {t: count_table("health", t, owner_key) for t in tables}
    return {"owner": owner_key, "tables": counts}


def load_storyline_json(days: int, owner: str | None = None) -> dict[str, Any]:
    import json as json_lib

    owner_key = owner or get_settings().health_owner
    data = storyline.load_data(days, owner=owner_key)
    sl = storyline.analyze(data)
    return json_lib.loads(storyline.to_json(sl))


def argparse_namespace(**kwargs):
    from health.scheduler import argparse_namespace as _ns

    return _ns(**kwargs)
