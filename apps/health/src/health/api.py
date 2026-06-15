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
from health.patients import (
    Patient,
    delete_patient,
    get_patient,
    list_patients,
    resolve_owner_for_patient,
    upsert_patient,
)
from health.sino_config import config_status, save_credentials
from health.token_provider import get_token_provider, init_token_provider

log = logging.getLogger(__name__)


class SyncRequest(BaseModel):
    days: int = 7
    include_heartrate: bool = False
    sync_cgm: bool = True
    owner: str | None = None
    all_tenants: bool = False
    manager: str | None = None
    patient_id: str | None = None


class TenantUpsertRequest(BaseModel):
    owner: str
    sino_user_id: str | None = None
    oura_pat: str | None = None
    display_name: str | None = None
    enabled: bool = True


class ConnectRequest(BaseModel):
    """绑定登录用户与三诺 connector（owner 即 shujian-agent 用户标识）。"""

    owner: str
    sino_user_id: str | None = None
    display_name: str | None = None
    sync_days: int = 7
    sync_now: bool = True


class AuthConfigureRequest(BaseModel):
    """三诺 OAuth 应用凭证（服务级，所有用户共用 API 鉴权）。"""

    sino_client_id: str
    sino_client_secret: str
    ican_username: str
    ican_password: str
    test_login: bool = True


class PatientCreateRequest(BaseModel):
    """健管师用手机号添加被监测用户。manager = 健管师 id（由 agent 注入）。"""

    manager: str
    phone: str
    display_name: str | None = None
    sync_days: int = 14
    sync_now: bool = True


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


def _patient_dict(p: Patient, *, with_stats: bool = False) -> dict[str, Any]:
    d: dict[str, Any] = {
        "id": p.id,
        "manager": p.manager,
        "sino_user_id": p.sino_user_id,
        "phone": p.phone,
        "display_name": p.display_name,
        "enabled": p.enabled,
        "connected": bool(p.sino_user_id),
    }
    if with_stats and p.sino_user_id:
        owner = p.sino_user_id
        d["daily_count"] = count_table("health", "cgm_daily", owner)
        d["readings_count"] = count_table("health", "cgm_readings", owner)
        last = db_query(
            "SELECT last_synced_day FROM health.cgm_sync_state WHERE owner = %s",
            (owner,),
        )
        d["last_synced_day"] = (
            str(last[0]["last_synced_day"]) if last and last[0]["last_synced_day"] else None
        )
    return d


def _resolve_owner(
    owner: str | None,
    manager: str | None,
    patient_id: str | None,
) -> str:
    """解析 CGM owner。

    优先级：patient_id（带 manager 归属校验）> owner > 默认租户。
    越权/不存在 -> 403；patient 未绑定三诺 -> 409。
    """
    if patient_id:
        if not manager:
            raise HTTPException(status_code=400, detail="patient_id 需要配合 manager")
        cgm_owner = resolve_owner_for_patient(manager, patient_id)
        if cgm_owner:
            return cgm_owner
        if get_patient(manager, patient_id) is None:
            raise HTTPException(status_code=403, detail="无权访问该用户或用户不存在")
        raise HTTPException(status_code=409, detail="该用户尚未绑定三诺数据")
    return owner or get_settings().health_owner


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
        return {"mode": "unavailable", "error": str(exc), "config": config_status()}


@app.get("/api/health/auth/config")
def api_auth_config() -> dict[str, Any]:
    """OAuth 凭证配置状态（不含明文 secret）。"""
    cfg = config_status()
    try:
        auth = get_token_provider().status()
    except Exception as exc:
        auth = {"mode": "unavailable", "error": str(exc)}
    return {"ok": True, "config": cfg, "auth": auth}


@app.post("/api/health/auth/configure")
def api_auth_configure(body: AuthConfigureRequest) -> dict[str, Any]:
    """保存 OAuth 凭证到 DB，可选立即测试登录。空字段保留已有 DB 值。"""
    from health.sino_config import _row_from_db

    existing = _row_from_db() or {}
    client_id = body.sino_client_id.strip() or (existing.get("sino_client_id") or "").strip()
    client_secret = body.sino_client_secret.strip() or (existing.get("sino_client_secret") or "").strip()
    username = body.ican_username.strip() or (existing.get("ican_username") or "").strip()
    password = body.ican_password.strip() or (existing.get("ican_password") or "").strip()

    if not client_id or not client_secret:
        raise HTTPException(status_code=400, detail="SINO_CLIENT_ID 与 SINO_CLIENT_SECRET 必填")
    if not username or not password:
        raise HTTPException(status_code=400, detail="ICAN_USERNAME 与 ICAN_PASSWORD 必填")

    save_credentials(
        sino_client_id=client_id,
        sino_client_secret=client_secret,
        ican_username=username,
        ican_password=password,
    )
    provider = get_token_provider()
    provider.reload_credentials()

    login_error: str | None = None
    if body.test_login:
        try:
            provider.get_token()
        except Exception as exc:
            login_error = str(exc)

    auth = provider.status()
    ok = login_error is None and auth.get("mode") not in ("unset", "unavailable")
    return {
        "ok": ok,
        "auth": auth,
        "config": config_status(),
        "login_error": login_error,
    }


@app.post("/api/health/auth/refresh")
def api_auth_refresh() -> dict[str, Any]:
    """强制刷新 OAuth token。"""
    provider = get_token_provider()
    provider.reload_credentials()
    try:
        provider.get_token()
    except Exception as exc:
        raise HTTPException(status_code=502, detail=str(exc)) from exc
    return {"ok": True, "auth": provider.status()}


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


# ───────── 健管师名册（patients）─────────

@app.get("/api/health/patients")
def api_list_patients(manager: str = Query(...)) -> dict[str, Any]:
    """列出某健管师名下所有被监测用户（含数据量）。"""
    patients = list_patients(manager)
    return {
        "manager": manager,
        "patients": [_patient_dict(p, with_stats=True) for p in patients],
    }


@app.post("/api/health/patients")
def api_create_patient(body: PatientCreateRequest) -> dict[str, Any]:
    """用手机号添加被监测用户：查三诺 userId → 入名册 → 可选立即同步。"""
    phone = body.phone.strip()
    if not phone:
        raise HTTPException(status_code=400, detail="手机号必填")

    try:
        rec = cgm.find_user_by_phone(phone)
    except SystemExit:
        raise HTTPException(status_code=502, detail="三诺鉴权失败，请检查 OAuth 配置") from None
    except Exception as exc:
        raise HTTPException(status_code=502, detail=f"查询三诺用户失败: {exc}") from exc

    if not rec or not rec.get("id"):
        raise HTTPException(status_code=404, detail="未在三诺找到该手机号对应的用户")

    sino_user_id = str(rec["id"])
    name = body.display_name or rec.get("name") or rec.get("nickName") or phone
    patient = upsert_patient(
        body.manager,
        sino_user_id=sino_user_id,
        phone=phone,
        display_name=name,
    )

    sync_result = "skipped"
    if body.sync_now:
        try:
            cgm.sync_patient(sino_user_id, days=body.sync_days)
            sync_result = "ok"
        except SystemExit:
            sync_result = "auth_required"
        except Exception as exc:
            sync_result = f"error: {exc}"

    return {
        "ok": True,
        "patient": _patient_dict(patient, with_stats=True),
        "sync": sync_result,
    }


@app.delete("/api/health/patients/{patient_id}")
def api_delete_patient(patient_id: str, manager: str = Query(...)) -> dict[str, Any]:
    """从名册移除被监测用户（仅删名册，保留历史 CGM）。"""
    ok = delete_patient(manager, patient_id)
    if not ok:
        raise HTTPException(status_code=404, detail="用户不存在或无权操作")
    return {"ok": True, "deleted": patient_id}


@app.post("/api/health/patients/{patient_id}/sync")
def api_sync_patient(
    patient_id: str,
    manager: str = Query(...),
    days: int = Query(14, ge=1, le=365),
) -> dict[str, Any]:
    """同步指定被监测用户最近 N 天 CGM。"""
    p = get_patient(manager, patient_id)
    if p is None:
        raise HTTPException(status_code=403, detail="无权访问该用户或用户不存在")
    if not p.sino_user_id:
        raise HTTPException(status_code=409, detail="该用户尚未绑定三诺数据")
    try:
        cgm.sync_patient(p.sino_user_id, days=days)
        result = "ok"
    except SystemExit:
        result = "auth_required"
    except Exception as exc:
        result = f"error: {exc}"
    return {"ok": result == "ok", "patient_id": patient_id, "cgm": result}


@app.post("/api/health/connect")
def api_connect(body: ConnectRequest) -> dict[str, Any]:
    """登录用户连接 connector：注册/更新 tenant + 报告鉴权状态 + 可选立即同步。"""
    seed_default_tenant()
    upsert_tenant(
        body.owner,
        sino_user_id=body.sino_user_id,
        display_name=body.display_name,
        enabled=True,
    )
    try:
        auth = get_token_provider().status()
    except Exception as exc:
        auth = {"mode": "unavailable", "error": str(exc)}

    sync_result = "skipped"
    if body.sync_now and body.sino_user_id:
        args = argparse_namespace(days=body.sync_days, owner=body.owner)
        try:
            cgm.cmd_sync(args)
            sync_result = "ok"
        except SystemExit:
            sync_result = "auth_required"
        except Exception as exc:
            sync_result = f"error: {exc}"

    t = get_tenant(body.owner)
    return {
        "ok": True,
        "owner": body.owner,
        "auth": auth,
        "sync": sync_result,
        "tenant": _tenant_dict(t) if t else None,
    }


@app.get("/api/health/cgm/daily")
def api_cgm_daily(
    owner: str | None = Query(None),
    manager: str | None = Query(None),
    patient_id: str | None = Query(None),
    days: int = Query(30, ge=1, le=365),
) -> dict[str, Any]:
    """结构化每日 CGM 指标（TIR/GMI/均值等），用于前端仪表盘图表。"""
    owner_key = _resolve_owner(owner, manager, patient_id)
    rows = db_query(
        """
        SELECT day, tir, tar, tbr, tar_high, tbr_low,
               mean_glucose, min_glucose, max_glucose,
               std_glucose, cv_glucose, gmi,
               hypo_events, dawn_effect, dawn_mean_glucose,
               data_points, data_completeness
        FROM health.cgm_daily
        WHERE owner = %s
        ORDER BY day DESC
        LIMIT %s
        """,
        (owner_key, days),
    )
    rows.reverse()

    def num(v: Any) -> Any:
        return float(v) if isinstance(v, (int, float)) or hasattr(v, "__float__") else v

    series = [
        {
            "day": str(r["day"]),
            "tir": num(r["tir"]),
            "tar": num(r["tar"]),
            "tbr": num(r["tbr"]),
            "tar_high": num(r["tar_high"]),
            "tbr_low": num(r["tbr_low"]),
            "mean_glucose": num(r["mean_glucose"]),
            "min_glucose": num(r["min_glucose"]),
            "max_glucose": num(r["max_glucose"]),
            "std_glucose": num(r["std_glucose"]),
            "cv_glucose": num(r["cv_glucose"]),
            "gmi": num(r["gmi"]),
            "hypo_events": r["hypo_events"],
            "dawn_effect": r["dawn_effect"],
            "dawn_mean_glucose": num(r["dawn_mean_glucose"]),
            "data_points": r["data_points"],
            "data_completeness": num(r["data_completeness"]),
        }
        for r in rows
    ]

    latest = series[-1] if series else None
    avg_tir = (
        round(sum(s["tir"] for s in series if s["tir"] is not None) / len(series), 1)
        if series
        else None
    )
    return {
        "owner": owner_key,
        "count": len(series),
        "latest": latest,
        "avg_tir": avg_tir,
        "series": series,
    }


@app.get("/api/health/readings")
def api_readings(
    owner: str | None = Query(None),
    manager: str | None = Query(None),
    patient_id: str | None = Query(None),
    day: str | None = Query(None, description="按归属日查询 YYYY-MM-DD"),
    start: str | None = Query(None, description="区间起始时间戳"),
    end: str | None = Query(None, description="区间结束时间戳"),
    limit: int = Query(2000, ge=1, le=50000),
) -> dict[str, Any]:
    """分钟级 CGM 原始读数，支持按天或时间区间查询，用于细粒度问答。"""
    owner_key = _resolve_owner(owner, manager, patient_id)
    if day:
        rows = db_query(
            """
            SELECT ts, glucose FROM health.cgm_readings
            WHERE owner = %s AND day = %s
            ORDER BY ts LIMIT %s
            """,
            (owner_key, day, limit),
        )
    elif start and end:
        rows = db_query(
            """
            SELECT ts, glucose FROM health.cgm_readings
            WHERE owner = %s AND ts BETWEEN %s AND %s
            ORDER BY ts LIMIT %s
            """,
            (owner_key, start, end, limit),
        )
    else:
        rows = db_query(
            """
            SELECT ts, glucose FROM health.cgm_readings
            WHERE owner = %s
            ORDER BY ts DESC LIMIT %s
            """,
            (owner_key, limit),
        )
        rows = list(reversed(rows))
    return {
        "owner": owner_key,
        "count": len(rows),
        "readings": [
            {"ts": r["ts"].isoformat(), "glucose": float(r["glucose"])}
            for r in rows
        ],
    }


@app.post("/api/health/sync")
def api_sync(body: SyncRequest) -> dict[str, Any]:
    # patient 维度：仅同步该 patient 的 CGM（带 manager 归属校验）
    if body.patient_id:
        owner_key = _resolve_owner(None, body.manager, body.patient_id)
        cgm_result = "skipped"
        if body.sync_cgm:
            try:
                cgm.sync_patient(owner_key, days=body.days)
                cgm_result = "ok"
            except SystemExit:
                cgm_result = "auth_required"
            except Exception as exc:
                cgm_result = f"error: {exc}"
        return {"ok": True, "oura": "skipped", "cgm": cgm_result}

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
def api_today(
    owner: str | None = Query(None),
    manager: str | None = Query(None),
    patient_id: str | None = Query(None),
) -> dict[str, str]:
    owner_key = _resolve_owner(owner, manager, patient_id)
    args = argparse_namespace(owner=owner_key)
    return {
        "owner": owner_key,
        "oura": _capture(oura.cmd_today, args),
        "cgm": _capture(cgm.cmd_today, args),
    }


@app.get("/api/health/trend")
def api_trend(
    source: str = Query("oura", pattern="^(oura|cgm)$"),
    days: int = Query(30, ge=1, le=365),
    owner: str | None = Query(None),
    manager: str | None = Query(None),
    patient_id: str | None = Query(None),
) -> dict[str, str]:
    owner_key = _resolve_owner(owner, manager, patient_id)
    args = argparse_namespace(days=days, owner=owner_key)
    if source == "oura":
        return {
            "source": "oura",
            "owner": owner_key,
            "text": _capture(oura.cmd_trend, args),
        }
    return {
        "source": "cgm",
        "owner": owner_key,
        "text": _capture(cgm.cmd_trend, args),
    }


@app.get("/api/health/storyline")
def api_storyline(
    days: int = Query(14, ge=1, le=365),
    as_json: bool = False,
    owner: str | None = Query(None),
    manager: str | None = Query(None),
    patient_id: str | None = Query(None),
) -> Any:
    owner_key = _resolve_owner(owner, manager, patient_id)
    if as_json:
        return load_storyline_json(days, owner=owner_key)
    args = argparse_namespace(days=days, owner=owner_key)
    args.json = as_json
    return {
        "owner": owner_key,
        "text": _capture(storyline.cmd_storyline, args),
    }


@app.get("/api/health/stats")
def api_stats(
    owner: str | None = Query(None),
    manager: str | None = Query(None),
    patient_id: str | None = Query(None),
) -> dict[str, Any]:
    owner_key = _resolve_owner(owner, manager, patient_id)
    tables = [
        "oura_daily",
        "oura_events",
        "oura_heartrate",
        "oura_personal_info",
        "oura_sync_state",
        "cgm_daily",
        "cgm_readings",
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
