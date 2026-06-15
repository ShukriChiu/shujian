"""SINO CGM data sync and query."""

from __future__ import annotations

import argparse
import json
import math
import sys
import urllib.parse
import urllib.request
import urllib.error
from datetime import date, datetime, timedelta
from typing import Any, Dict, List, Optional

from psycopg2.extras import Json, execute_values  # type: ignore

from health.config import get_settings
from health.db import db_conn, db_exec, db_query
from health.tenants import list_tenants, resolve_owner, resolve_sino_user_id, seed_default_tenant
from health.token_provider import get_token_provider

ICAN_BASE = "https://ican.sinocare.com"


# CGM 阈值常量
TIR_LOW = 3.9    # mmol/L
TIR_HIGH = 7.8
VERY_HIGH = 10.0
VERY_LOW = 3.0
POINTS_PER_DAY = 480  # 3min 采样 × 24h


# ───────── Auth ─────────

def _get_auth_header() -> Dict[str, str]:
    try:
        token = get_token_provider().get_token()
    except Exception as e:
        print(f"❌ SINO OAuth 失败: {e}", file=sys.stderr)
        print("   配置 SINO_CLIENT_ID/SECRET + ICAN_USERNAME/PASSWORD", file=sys.stderr)
        sys.exit(2)
    return {"sino-auth": token}


# ───────── HTTP helpers ─────────

def _api_get(path: str, params: Optional[Dict[str, str]] = None) -> Any:
    url = f"{ICAN_BASE}{path}"
    if params:
        url += "?" + urllib.parse.urlencode(params)
    headers = _get_auth_header()
    req = urllib.request.Request(url, headers=headers)
    try:
        with urllib.request.urlopen(req, timeout=30) as resp:
            body = json.loads(resp.read())
    except urllib.error.HTTPError as e:
        body_text = e.read().decode() if e.fp else ""
        print(f"❌ API GET {path} → HTTP {e.code}: {body_text[:200]}", file=sys.stderr)
        sys.exit(2)
    return _unwrap(path, body)


def _api_post(path: str, payload: Dict[str, Any]) -> Any:
    url = f"{ICAN_BASE}{path}"
    headers = _get_auth_header()
    headers["Content-Type"] = "application/json"
    data = json.dumps(payload).encode()
    req = urllib.request.Request(url, data=data, headers=headers, method="POST")
    try:
        with urllib.request.urlopen(req, timeout=60) as resp:
            body = json.loads(resp.read())
    except urllib.error.HTTPError as e:
        body_text = e.read().decode() if e.fp else ""
        print(f"❌ API POST {path} → HTTP {e.code}: {body_text[:200]}", file=sys.stderr)
        sys.exit(2)
    return _unwrap(path, body)


def _unwrap(path: str, body: Any) -> Any:
    """解包 iCan 标准信封 {code, success, data, msg}。"""
    if isinstance(body, dict) and "code" in body:
        if body.get("success") and body.get("code") in (200, 0):
            return body.get("data")
        print(f"❌ API {path} → code={body.get('code')} msg={body.get('msg', '')}", file=sys.stderr)
        sys.exit(2)
    return body


# ───────── 手机号 → 三诺 userId ─────────

def find_user_by_phone(phone: str) -> Optional[Dict[str, Any]]:
    """用手机号在三诺查用户，返回 {id, name, phone(masked)} 或 None。

    逻辑对齐 sino-agentservice：page-user 模糊搜索后按掩码手机号精确匹配。
    """
    phone = (phone or "").strip()
    if not phone:
        return None
    page = _api_post(
        "/api/sino-user/v1/user/page-user",
        {"keyWord": phone, "current": 1, "size": 10},
    )
    records = (page or {}).get("records") or []
    masked = phone[:3] + "****" + phone[-4:] if len(phone) == 11 else None
    if masked:
        for rec in records:
            if rec.get("phone") == masked:
                return rec
    if len(records) == 1:
        return records[0]
    return None


def sync_patient(sino_user_id: str, days: int = 14,
                 start: Optional[str] = None, end: Optional[str] = None) -> None:
    """按 patient 的 sino_user_id 同步 CGM（owner = sino_user_id）。"""
    args = argparse.Namespace(
        days=days, start=start, end=end, owner=sino_user_id, all_tenants=False,
    )
    _sync_one_owner(sino_user_id, sino_user_id, args)


# ───────── CGM metrics computation ─────────

def _extract_glucose(point: Dict[str, Any]) -> Optional[float]:
    for key in ("value", "val", "glucose", "glucose_value"):
        v = point.get(key)
        if v is not None:
            try:
                return float(v)
            except (ValueError, TypeError):
                continue
    return None


def _extract_hour(point: Dict[str, Any]) -> Optional[int]:
    dt_str = point.get("dataTime") or point.get("time") or ""
    if not dt_str:
        return None
    try:
        parts = dt_str.split(" ")
        time_part = parts[1] if len(parts) >= 2 else parts[0]
        return int(time_part.split(":")[0])
    except (IndexError, ValueError):
        return None


def _extract_ts(point: Dict[str, Any], day_str: str) -> Optional[datetime]:
    """从采样点解析完整时间戳（用于分钟级 cgm_readings）。"""
    dt_str = (point.get("dataTime") or point.get("time") or "").strip()
    if not dt_str:
        return None
    for fmt in ("%Y-%m-%d %H:%M:%S", "%Y-%m-%d %H:%M"):
        try:
            return datetime.strptime(dt_str, fmt)
        except ValueError:
            continue
    # 退化：仅有 "HH:MM:SS" 时拼上归属日
    time_part = dt_str.split(" ")[-1]
    for fmt in ("%H:%M:%S", "%H:%M"):
        try:
            t = datetime.strptime(time_part, fmt).time()
            return datetime.combine(date.fromisoformat(day_str), t)
        except ValueError:
            continue
    return None


def compute_daily_metrics(points: List[Dict[str, Any]], api_day: Dict[str, Any]) -> Dict[str, Any]:
    """从 pointList 计算每日 CGM 指标。"""
    values = []
    dawn_values = []
    for p in points:
        g = _extract_glucose(p)
        if g is None or g <= 0:
            continue
        values.append(g)
        hour = _extract_hour(p)
        if hour is not None and 3 <= hour < 6:
            dawn_values.append(g)

    if not values:
        return {}

    n = len(values)
    mean_g = sum(values) / n
    min_g = min(values)
    max_g = max(values)
    variance = sum((x - mean_g) ** 2 for x in values) / n if n > 1 else 0
    std_g = math.sqrt(variance)
    cv_g = (std_g / mean_g) * 100 if mean_g > 0 else 0

    mean_mg_dl = mean_g * 18.018
    gmi = 3.31 + 0.02392 * mean_mg_dl

    tir = api_day.get("tir")
    tar = api_day.get("tar")
    tbr = api_day.get("tbr")
    if tir is None:
        in_range = sum(1 for v in values if TIR_LOW <= v <= TIR_HIGH)
        tir = in_range / n * 100
    if tar is None:
        above = sum(1 for v in values if v > TIR_HIGH)
        tar = above / n * 100
    if tbr is None:
        below = sum(1 for v in values if v < TIR_LOW)
        tbr = below / n * 100

    tar_high = sum(1 for v in values if v > VERY_HIGH) / n * 100
    tbr_low = sum(1 for v in values if v < VERY_LOW) / n * 100

    hypo_events = _count_hypo_events(points)

    dawn_effect = False
    dawn_mean = None
    if dawn_values:
        dawn_mean = sum(dawn_values) / len(dawn_values)
        if mean_g > 0 and dawn_mean > mean_g * 1.15:
            dawn_effect = True

    return {
        "tir": round(float(tir), 1) if tir is not None else None,
        "tar": round(float(tar), 1) if tar is not None else None,
        "tbr": round(float(tbr), 1) if tbr is not None else None,
        "tar_high": round(tar_high, 1),
        "tbr_low": round(tbr_low, 1),
        "mean_glucose": round(mean_g, 2),
        "min_glucose": round(min_g, 2),
        "max_glucose": round(max_g, 2),
        "std_glucose": round(std_g, 2),
        "cv_glucose": round(cv_g, 1),
        "gmi": round(gmi, 2),
        "hypo_events": hypo_events,
        "dawn_effect": dawn_effect,
        "dawn_mean_glucose": round(dawn_mean, 2) if dawn_mean else None,
        "data_points": n,
        "data_completeness": round(n / POINTS_PER_DAY * 100, 1),
    }


def _count_hypo_events(points: List[Dict[str, Any]]) -> int:
    """低血糖事件：连续 >= 15 分钟 glucose < 3.9 算一次。"""
    events = 0
    consecutive_low = 0
    for p in points:
        g = _extract_glucose(p)
        if g is not None and g < TIR_LOW:
            consecutive_low += 1
            if consecutive_low == 5:  # 5 个 3min 间隔 = 15min
                events += 1
        else:
            consecutive_low = 0
    return events


# ───────── Commands ─────────

def cmd_init(args: argparse.Namespace) -> None:
    from health.db import apply_migrations

    applied = apply_migrations()
    print(f"✅ CGM schema 已初始化: {', '.join(applied)}")


def cmd_sync(args: argparse.Namespace) -> None:
    seed_default_tenant()
    if getattr(args, "all_tenants", False):
        tenants = list_tenants(enabled_only=True)
        if not tenants:
            print("❌ 无已启用租户，先运行: health tenant add", file=sys.stderr)
            sys.exit(2)
        for t in tenants:
            if not t.sino_user_id:
                print(f"⚠️  跳过 {t.owner}：未配置 sino_user_id")
                continue
            _sync_one_owner(t.owner, t.sino_user_id, args)
        return

    owner = resolve_owner(args)
    sino_user_id = resolve_sino_user_id(owner)
    if not sino_user_id:
        print(f"❌ 租户 {owner} 未配置 sino_user_id", file=sys.stderr)
        print("   health tenant add --owner ... --sino-user-id ...", file=sys.stderr)
        sys.exit(2)
    _sync_one_owner(owner, sino_user_id, args)


def _sync_one_owner(owner: str, sino_user_id: str, args: argparse.Namespace) -> None:
    if args.start and args.end:
        start = args.start
        end = args.end
    else:
        end_date = date.today()
        start_date = end_date - timedelta(days=args.days - 1)
        start = start_date.isoformat()
        end = end_date.isoformat()

    print(f"📡 [{owner}] CGM: {start} → {end} (sino_user={sino_user_id})")

    avail_dates = _api_get(
        "/api/sino-health/v1/cgm-analysis/data-time-date",
        {"userId": sino_user_id},
    )
    if not avail_dates:
        print(f"⚠️  [{owner}] 无 CGM 数据")
        return

    target_dates = [
        d["date"] for d in avail_dates
        if d.get("date") and start <= d["date"] <= end
    ]
    if not target_dates:
        print(f"⚠️  [{owner}] {start} ~ {end} 无数据")
        return

    target_dates.sort()
    print(f"   找到 {len(target_dates)} 天: {target_dates[0]} → {target_dates[-1]}")

    upserted = 0
    readings_total = 0
    for i in range(0, len(target_dates), 7):
        chunk = target_dates[i:i + 7]
        days_data = _api_post(
            "/api/sino-health/v1/cgm-analysis/data-time-list",
            {"userId": sino_user_id, "dates": chunk},
        )
        if not days_data:
            continue

        for day_data in days_data:
            day_str = day_data.get("date")
            if not day_str:
                continue
            points = day_data.get("pointList") or []
            if not points:
                continue

            metrics = compute_daily_metrics(points, day_data)
            if not metrics:
                continue

            _upsert_day(owner, day_str, metrics, day_data)
            n_read = _upsert_readings(owner, day_str, points)
            readings_total += n_read
            upserted += 1
            pts = metrics.get("data_points", 0)
            tir_val = metrics.get("tir", 0)
            mean_val = metrics.get("mean_glucose", 0)
            print(f"   ✓ {day_str}: {pts} pts ({n_read} readings), TIR={tir_val}%, mean={mean_val} mmol/L")

    db_exec(
        """
        INSERT INTO health.cgm_sync_state (owner, sino_user_id, last_synced_day, last_run_at)
        VALUES (%s, %s, %s, now())
        ON CONFLICT (owner) DO UPDATE SET
            sino_user_id=EXCLUDED.sino_user_id,
            last_synced_day=EXCLUDED.last_synced_day,
            last_run_at=now(),
            last_error=NULL
        """,
        (owner, sino_user_id, end),
    )
    print(f"✅ [{owner}] 同步完成: {upserted} 天, {readings_total} 条分钟级读数")


def _upsert_day(owner: str, day_str: str, metrics: Dict[str, Any], raw: Dict[str, Any]) -> None:
    db_exec(
        """
        INSERT INTO health.cgm_daily (
            owner, day, tir, tar, tbr, tar_high, tbr_low,
            mean_glucose, min_glucose, max_glucose, std_glucose, cv_glucose, gmi,
            hypo_events, dawn_effect, dawn_mean_glucose,
            data_points, data_completeness, raw_day, synced_at
        ) VALUES (
            %s, %s, %s, %s, %s, %s, %s,
            %s, %s, %s, %s, %s, %s,
            %s, %s, %s,
            %s, %s, %s, now()
        )
        ON CONFLICT (owner, day) DO UPDATE SET
            tir=EXCLUDED.tir, tar=EXCLUDED.tar, tbr=EXCLUDED.tbr,
            tar_high=EXCLUDED.tar_high, tbr_low=EXCLUDED.tbr_low,
            mean_glucose=EXCLUDED.mean_glucose, min_glucose=EXCLUDED.min_glucose,
            max_glucose=EXCLUDED.max_glucose, std_glucose=EXCLUDED.std_glucose,
            cv_glucose=EXCLUDED.cv_glucose, gmi=EXCLUDED.gmi,
            hypo_events=EXCLUDED.hypo_events, dawn_effect=EXCLUDED.dawn_effect,
            dawn_mean_glucose=EXCLUDED.dawn_mean_glucose,
            data_points=EXCLUDED.data_points, data_completeness=EXCLUDED.data_completeness,
            raw_day=EXCLUDED.raw_day, synced_at=now()
        """,
        (
            owner, day_str,
            metrics.get("tir"), metrics.get("tar"), metrics.get("tbr"),
            metrics.get("tar_high"), metrics.get("tbr_low"),
            metrics.get("mean_glucose"), metrics.get("min_glucose"),
            metrics.get("max_glucose"), metrics.get("std_glucose"),
            metrics.get("cv_glucose"), metrics.get("gmi"),
            metrics.get("hypo_events"), metrics.get("dawn_effect"),
            metrics.get("dawn_mean_glucose"),
            metrics.get("data_points"), metrics.get("data_completeness"),
            Json({k: v for k, v in raw.items() if k != "pointList"}),
        ),
    )


def _upsert_readings(owner: str, day_str: str, points: List[Dict[str, Any]]) -> int:
    """写入分钟级原始读数（cgm_readings）。返回写入条数。"""
    rows: List[tuple] = []
    seen: set[datetime] = set()
    for p in points:
        g = _extract_glucose(p)
        if g is None or g <= 0:
            continue
        ts = _extract_ts(p, day_str)
        if ts is None or ts in seen:
            continue
        seen.add(ts)
        rows.append((owner, ts, g, day_str))
    if not rows:
        return 0
    with db_conn() as conn, conn.cursor() as cur:
        execute_values(
            cur,
            """
            INSERT INTO health.cgm_readings (owner, ts, glucose, day)
            VALUES %s
            ON CONFLICT (owner, ts) DO UPDATE SET
                glucose = EXCLUDED.glucose, day = EXCLUDED.day
            """,
            rows,
        )
    return len(rows)


def cmd_today(args: argparse.Namespace) -> None:
    owner = resolve_owner(args)
    today_str = date.today().isoformat()
    yesterday = (date.today() - timedelta(days=1)).isoformat()

    row = db_query(
        """
        SELECT * FROM health.cgm_daily
        WHERE owner = %s AND day IN (%s, %s)
        ORDER BY day DESC LIMIT 1
        """,
        (owner, today_str, yesterday),
    )
    if not row:
        print("没有近期 CGM 数据。先运行 cgm.py sync")
        return
    r = row[0]
    day = str(r["day"])

    print(f"\n{'═' * 50}")
    print(f"  CGM 简报 — {day}")
    print(f"{'═' * 50}")
    print(f"  TIR:     {_pct(r.get('tir'))} (目标 ≥70%)")
    print(f"  TAR:     {_pct(r.get('tar'))} (高血糖)")
    print(f"  TBR:     {_pct(r.get('tbr'))} (低血糖)")
    print(f"  均值:    {_val(r.get('mean_glucose'))} mmol/L")
    print(f"  范围:    {_val(r.get('min_glucose'))} ~ {_val(r.get('max_glucose'))} mmol/L")
    print(f"  CV:      {_pct(r.get('cv_glucose'))} (目标 <36%)")
    print(f"  GMI:     {_val(r.get('gmi'))}%")
    if r.get("dawn_effect"):
        print(f"  ⚠ 黎明现象: 03-06时均值 {_val(r.get('dawn_mean_glucose'))} mmol/L")
    if r.get("hypo_events", 0) > 0:
        print(f"  ⚠ 低血糖事件: {r['hypo_events']} 次")
    pts = r.get("data_points", 0)
    comp = r.get("data_completeness", 0)
    print(f"  数据:    {pts} 点 ({_pct(comp)} 完整度)")

    week = db_query(
        """
        SELECT day, tir, mean_glucose, cv_glucose, data_points
        FROM health.cgm_daily
        WHERE owner = %s
        ORDER BY day DESC LIMIT 7
        """,
        (owner,),
    )
    if len(week) > 1:
        print(f"\n  过去 {len(week)} 天:")
        print(f"  {'日期':<12} {'TIR':>6} {'均值':>8} {'CV':>6} {'点数':>5}")
        print(f"  {'─' * 40}")
        for w in reversed(week):
            d = str(w["day"])
            print(f"  {d:<12} {_pct(w.get('tir')):>6} {_val(w.get('mean_glucose')):>6}  {_pct(w.get('cv_glucose')):>6} {w.get('data_points', 0):>5}")
    print()


def cmd_trend(args: argparse.Namespace) -> None:
    owner = resolve_owner(args)
    rows = db_query(
        """
        SELECT day, tir, tar, tbr, mean_glucose, min_glucose, max_glucose,
               cv_glucose, gmi, hypo_events, dawn_effect, data_points
        FROM health.cgm_daily
        WHERE owner = %s
        ORDER BY day DESC LIMIT %s
        """,
        (owner, args.days),
    )
    if not rows:
        print("没有 CGM 数据。先运行 cgm.py sync")
        return

    rows.reverse()
    n = len(rows)

    def _avg(key):
        vals = [float(r[key]) for r in rows if r.get(key) is not None]
        return round(sum(vals) / len(vals), 1) if vals else None

    def _mn(key):
        vals = [float(r[key]) for r in rows if r.get(key) is not None]
        return round(min(vals), 1) if vals else None

    def _mx(key):
        vals = [float(r[key]) for r in rows if r.get(key) is not None]
        return round(max(vals), 1) if vals else None

    print(f"\n{'═' * 60}")
    print(f"  CGM 趋势 — 最近 {n} 天 ({rows[0]['day']} → {rows[-1]['day']})")
    print(f"{'═' * 60}")

    for label, key, unit in [
        ("TIR", "tir", "%"), ("TAR", "tar", "%"), ("TBR", "tbr", "%"),
        ("均值", "mean_glucose", "mmol/L"), ("CV", "cv_glucose", "%"),
        ("GMI", "gmi", "%"),
    ]:
        avg = _avg(key)
        mn = _mn(key)
        mx = _mx(key)
        if avg is not None:
            print(f"  {label:<6} avg={avg}{unit}  min={mn}  max={mx}")

    hypo_total = sum(r.get("hypo_events", 0) for r in rows)
    dawn_total = sum(1 for r in rows if r.get("dawn_effect"))
    print(f"\n  低血糖事件: {hypo_total} 次")
    print(f"  黎明现象:   {dawn_total}/{n} 天")

    print(f"\n  {'日期':<12} {'TIR':>5} {'均值':>7} {'CV':>5} {'GMI':>5} {'低糖':>4} {'黎明':>4} {'点数':>5}")
    print(f"  {'─' * 55}")
    for r in rows:
        dawn = "✓" if r.get("dawn_effect") else ""
        print(
            f"  {str(r['day']):<12}"
            f" {_pct(r.get('tir')):>5}"
            f" {_val(r.get('mean_glucose')):>6} "
            f" {_pct(r.get('cv_glucose')):>5}"
            f" {_val(r.get('gmi')):>5}"
            f" {r.get('hypo_events', 0):>4}"
            f" {dawn:>4}"
            f" {r.get('data_points', 0):>5}"
        )
    print()


# ───────── Formatting helpers ─────────

def _val(v, fmt=".1f") -> str:
    if v is None:
        return "—"
    return f"{float(v):{fmt}}"


def _pct(v) -> str:
    if v is None:
        return "—"
    return f"{float(v):.1f}%"


# ───────── CLI ─────────

def main() -> None:
    p = argparse.ArgumentParser(description="SINO CGM 数据同步")
    sub = p.add_subparsers(dest="cmd")

    sub.add_parser("init", help="建表")

    sp = sub.add_parser("sync", help="同步 CGM 数据")
    sp.add_argument("--days", type=int, default=7, help="拉最近 N 天 (默认 7)")
    sp.add_argument("--start", help="起始日期 YYYY-MM-DD")
    sp.add_argument("--end", help="结束日期 YYYY-MM-DD")
    sp.add_argument("--owner", help="租户 owner（默认 HEALTH_OWNER）")
    sp.add_argument("--all", dest="all_tenants", action="store_true", help="同步所有已启用租户")

    sp = sub.add_parser("today", help="今日 CGM 简报")
    sp.add_argument("--owner", help="租户 owner")

    sp = sub.add_parser("trend", help="CGM 趋势")
    sp.add_argument("--days", type=int, default=14, help="天数 (默认 14)")
    sp.add_argument("--owner", help="租户 owner")

    args = p.parse_args()
    if not args.cmd:
        p.print_help()
        sys.exit(0)

    cmds = {
        "init": cmd_init,
        "sync": cmd_sync,
        "today": cmd_today,
        "trend": cmd_trend,
    }
    cmds[args.cmd](args)


if __name__ == "__main__":
    main()
