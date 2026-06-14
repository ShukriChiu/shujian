"""Oura Ring data sync and query."""

from __future__ import annotations

import argparse
import json
import sys
import urllib.parse
import urllib.request
import urllib.error
from datetime import date, datetime, timedelta, timezone
from typing import Any, Dict, Iterable, List, Optional, Tuple

from psycopg2.extras import Json, execute_values  # type: ignore

from health.config import get_settings
from health.db import db_conn, db_exec, db_query
from health.tenants import list_tenants, resolve_oura_pat, resolve_owner, seed_default_tenant

OURA_BASE = "https://api.ouraring.com"
_current_owner: str | None = None


def _owner() -> str:
    if _current_owner:
        return _current_owner
    return get_settings().health_owner


def _pat() -> str:
    return resolve_oura_pat(_owner())


def _set_owner(owner: str) -> None:
    global _current_owner
    _current_owner = owner


def _need(var: str, value: str) -> None:
    if not value:
        print(f"❌ 环境变量 {var} 未设置。见 apps/health/.env.example", file=sys.stderr)
        sys.exit(2)


# ───────── HTTP ─────────

def oura_get(path: str, params: Optional[Dict[str, Any]] = None) -> Dict[str, Any]:
    pat = _pat()
    _need("OURA_PAT", pat)
    url = OURA_BASE + path
    if params:
        qs = urllib.parse.urlencode({k: v for k, v in params.items() if v is not None})
        url = f"{url}{'&' if '?' in url else '?'}{qs}"
    req = urllib.request.Request(url, headers={"Authorization": f"Bearer {pat}"})
    try:
        with urllib.request.urlopen(req, timeout=30) as r:
            return json.loads(r.read().decode("utf-8"))
    except urllib.error.HTTPError as e:
        body = e.read().decode("utf-8", errors="replace")[:300]
        print(f"❌ Oura API {e.code}: {url}\n{body}", file=sys.stderr)
        raise


def oura_list(path: str, start: date, end: date, date_param: str = "date") -> List[Dict[str, Any]]:
    """分页拉 v2 list endpoints。date_param='date' 对应 start_date/end_date（几乎所有接口），'datetime' 只给 /heartrate 用。"""
    items: List[Dict[str, Any]] = []
    if date_param == "datetime":
        params = {
            "start_datetime": f"{start.isoformat()}T00:00:00+00:00",
            "end_datetime": f"{end.isoformat()}T23:59:59+00:00",
        }
    else:
        params = {"start_date": start.isoformat(), "end_date": end.isoformat()}
    token = None
    while True:
        if token:
            params["next_token"] = token
        resp = oura_get(path, params)
        items.extend(resp.get("data", []))
        token = resp.get("next_token")
        if not token:
            break
    return items


# ───────── Commands ─────────

def cmd_init(args: argparse.Namespace) -> None:
    from health.db import apply_migrations

    applied = apply_migrations()
    print(f"✅ health schema 已初始化: {', '.join(applied)}")


def cmd_whoami(args: argparse.Namespace) -> None:
    info = oura_get("/v2/usercollection/personal_info")
    print(json.dumps(info, indent=2, ensure_ascii=False))
    db_exec(
        """
        INSERT INTO health.oura_personal_info (owner, oura_user_id, age, weight, height, biological_sex, email, raw, synced_at)
        VALUES (%s,%s,%s,%s,%s,%s,%s,%s, now())
        ON CONFLICT (owner) DO UPDATE SET
          oura_user_id=EXCLUDED.oura_user_id, age=EXCLUDED.age, weight=EXCLUDED.weight,
          height=EXCLUDED.height, biological_sex=EXCLUDED.biological_sex, email=EXCLUDED.email,
          raw=EXCLUDED.raw, synced_at=now()
        """,
        (_owner(), info.get("id"), info.get("age"), info.get("weight"), info.get("height"),
         info.get("biological_sex"), info.get("email"), Json(info)),
    )


# 列名到 jsonb 列 + merge 函数
# 每个 resource 返回 (path, date_param, raw_column, apply_fn)
# apply_fn(row) -> Dict[str, Any]  要合并进 oura_daily 的列

def _parse_ts(s: Optional[str]) -> Optional[str]:
    return s  # Postgres 能吃 ISO8601，直接传字符串


def merge_daily_sleep(row: Dict[str, Any]) -> Dict[str, Any]:
    return {
        "sleep_score": row.get("score"),
        "raw_daily_sleep": Json(row),
    }


def merge_sleep(rows: List[Dict[str, Any]], day: date) -> Dict[str, Any]:
    """从同一天多段 sleep 中挑主睡眠段（type==long_sleep 或时长最长）。"""
    if not rows:
        return {}
    main = next((r for r in rows if r.get("type") == "long_sleep"), None)
    if not main:
        main = max(rows, key=lambda r: r.get("total_sleep_duration") or 0)
    hr_avg = main.get("average_heart_rate")
    return {
        "total_sleep_seconds": main.get("total_sleep_duration"),
        "deep_sleep_seconds": main.get("deep_sleep_duration"),
        "rem_sleep_seconds": main.get("rem_sleep_duration"),
        "light_sleep_seconds": main.get("light_sleep_duration"),
        "sleep_efficiency": main.get("efficiency"),
        "sleep_latency_seconds": main.get("latency"),
        "bedtime_start": _parse_ts(main.get("bedtime_start")),
        "bedtime_end": _parse_ts(main.get("bedtime_end")),
        "hrv_avg": main.get("average_hrv"),
        "rhr_avg": hr_avg,  # sleep 段内平均心率当 RHR 代理；daily_readiness 里的 rhr 更准会覆盖
        "respiratory_rate": main.get("average_breath"),
        "raw_sleep": Json(rows),
    }


def merge_readiness(row: Dict[str, Any]) -> Dict[str, Any]:
    c = row.get("contributors") or {}
    return {
        "readiness_score": row.get("score"),
        "readiness_temperature_deviation": row.get("temperature_deviation"),
        "readiness_temperature_trend_deviation": row.get("temperature_trend_deviation"),
        # readiness 里 contributors.resting_heart_rate 是贡献分，不是 bpm；真 RHR 继续取自 sleep 段
        "raw_readiness": Json(row),
    }


def merge_activity(row: Dict[str, Any]) -> Dict[str, Any]:
    return {
        "activity_score": row.get("score"),
        "steps": row.get("steps"),
        "active_calories": row.get("active_calories"),
        "total_calories": row.get("total_calories"),
        "equivalent_walking_distance_m": row.get("equivalent_walking_distance"),
        "high_activity_seconds": row.get("high_activity_time"),
        "medium_activity_seconds": row.get("medium_activity_time"),
        "low_activity_seconds": row.get("low_activity_time"),
        "sedentary_seconds": row.get("sedentary_time"),
        "raw_activity": Json(row),
    }


def merge_stress(row: Dict[str, Any]) -> Dict[str, Any]:
    return {
        "stress_day_summary": row.get("day_summary"),
        "stress_high_seconds": row.get("stress_high"),
        "stress_recovery_seconds": row.get("recovery_high"),
        "raw_stress": Json(row),
    }


def merge_spo2(row: Dict[str, Any]) -> Dict[str, Any]:
    pct = (row.get("spo2_percentage") or {}).get("average")
    return {"spo2_avg": pct, "raw_spo2": Json(row)}


def merge_resilience(row: Dict[str, Any]) -> Dict[str, Any]:
    return {"resilience_level": row.get("level"), "raw_resilience": Json(row)}


def merge_cardio_age(row: Dict[str, Any]) -> Dict[str, Any]:
    return {"cardiovascular_age": row.get("vascular_age"), "raw_cardio_age": Json(row)}


def _upsert_daily(updates_by_day: Dict[date, Dict[str, Any]]) -> int:
    """按 day 合并 merge_* 的输出并 UPSERT 到 health.oura_daily。"""
    if not updates_by_day:
        return 0
    # 列列表：数据列 + (owner, day) + synced_at
    all_cols = [
        "sleep_score","total_sleep_seconds","deep_sleep_seconds","rem_sleep_seconds","light_sleep_seconds",
        "sleep_efficiency","sleep_latency_seconds","bedtime_start","bedtime_end","hrv_avg","rhr_avg","respiratory_rate",
        "readiness_score","readiness_temperature_deviation","readiness_temperature_trend_deviation",
        "activity_score","steps","active_calories","total_calories","equivalent_walking_distance_m",
        "high_activity_seconds","medium_activity_seconds","low_activity_seconds","sedentary_seconds",
        "stress_day_summary","stress_high_seconds","stress_recovery_seconds","spo2_avg",
        "resilience_level","cardiovascular_age",
        "raw_daily_sleep","raw_sleep","raw_readiness","raw_activity","raw_stress","raw_spo2","raw_resilience","raw_cardio_age",
    ]

    with db_conn() as conn, conn.cursor() as cur:
        count = 0
        for day, patch in updates_by_day.items():
            cols = ["owner", "day"] + [c for c in all_cols if c in patch] + ["synced_at"]
            vals: List[Any] = [_owner(), day] + [patch[c] for c in all_cols if c in patch] + [datetime.now(timezone.utc)]
            placeholders = ",".join(["%s"] * len(vals))
            update_set = ",".join(f"{c}=EXCLUDED.{c}" for c in cols if c not in ("owner", "day"))
            sql = f"""
                INSERT INTO health.oura_daily ({",".join(cols)})
                VALUES ({placeholders})
                ON CONFLICT (owner, day) DO UPDATE SET {update_set}
            """
            cur.execute(sql, vals)
            count += 1
        return count


def _sync_daily_resource(path: str, start: date, end: date, merge_fn, label: str) -> int:
    rows = oura_list(path, start, end, date_param="date")
    updates: Dict[date, Dict[str, Any]] = {}
    for r in rows:
        d = r.get("day")
        if not d:
            continue
        try:
            day = date.fromisoformat(d)
        except ValueError:
            continue
        updates[day] = merge_fn(r)
    n = _upsert_daily(updates)
    print(f"  ✓ {label}: {len(rows)} 条 → {n} 天")
    _set_state(label, end)
    return n


def _sync_sleep(start: date, end: date) -> int:
    rows = oura_list("/v2/usercollection/sleep", start, end, date_param="date")
    by_day: Dict[date, List[Dict[str, Any]]] = {}
    for r in rows:
        d = r.get("day")
        if not d:
            continue
        by_day.setdefault(date.fromisoformat(d), []).append(r)
    updates = {day: merge_sleep(rs, day) for day, rs in by_day.items()}
    n = _upsert_daily(updates)
    print(f"  ✓ sleep: {len(rows)} 段 → {n} 天")
    _set_state("sleep", end)
    return n


def _sync_events(kind: str, path: str, start: date, end: date,
                 label_fn=lambda r: r.get("activity_type") or r.get("tag_type_code") or r.get("type")) -> int:
    rows = oura_list(path, start, end, date_param="date")
    with db_conn() as conn, conn.cursor() as cur:
        for r in rows:
            day_str = r.get("day")
            cur.execute(
                """
                INSERT INTO health.oura_events (owner, kind, external_id, day, start_time, end_time, label, raw, synced_at)
                VALUES (%s,%s,%s,%s,%s,%s,%s,%s, now())
                ON CONFLICT (owner, kind, external_id) DO UPDATE SET
                  day=EXCLUDED.day, start_time=EXCLUDED.start_time, end_time=EXCLUDED.end_time,
                  label=EXCLUDED.label, raw=EXCLUDED.raw, synced_at=now()
                """,
                (_owner(), kind, r.get("id") or f"{r.get('start_datetime')}",
                 date.fromisoformat(day_str) if day_str else None,
                 _parse_ts(r.get("start_datetime") or r.get("timestamp")),
                 _parse_ts(r.get("end_datetime")),
                 label_fn(r),
                 Json(r)),
            )
    print(f"  ✓ {kind}: {len(rows)} 条")
    _set_state(kind, end)
    return len(rows)


def _sync_heartrate(start: date, end: date) -> int:
    rows = oura_list("/v2/usercollection/heartrate", start, end, date_param="datetime")
    if not rows:
        print("  ✓ heartrate: 0 条")
        _set_state("heartrate", end)
        return 0
    tuples = [(_owner(), r.get("timestamp"), r.get("bpm"), r.get("source")) for r in rows if r.get("timestamp")]
    with db_conn() as conn, conn.cursor() as cur:
        execute_values(
            cur,
            "INSERT INTO health.oura_heartrate (owner, ts, bpm, source) VALUES %s ON CONFLICT (owner, ts) DO UPDATE SET bpm=EXCLUDED.bpm, source=EXCLUDED.source",
            tuples,
            template="(%s,%s,%s,%s)",
        )
    print(f"  ✓ heartrate: {len(tuples)} 条")
    _set_state("heartrate", end)
    return len(tuples)


def _set_state(resource: str, last_day: date, err: Optional[str] = None) -> None:
    db_exec(
        """
        INSERT INTO health.oura_sync_state (owner, resource, last_synced_day, last_run_at, last_error)
        VALUES (%s,%s,%s, now(), %s)
        ON CONFLICT (owner, resource) DO UPDATE SET
          last_synced_day=EXCLUDED.last_synced_day, last_run_at=now(), last_error=EXCLUDED.last_error
        """,
        (_owner(), resource, last_day, err),
    )


def _get_state(resource: str) -> Optional[date]:
    rows = db_query(
        "SELECT last_synced_day FROM health.oura_sync_state WHERE owner=%s AND resource=%s",
        (_owner(), resource),
    )
    return rows[0]["last_synced_day"] if rows else None


RESOURCES = {
    "daily_sleep":   ("/v2/usercollection/daily_sleep",   "daily",   merge_daily_sleep),
    "sleep":         ("/v2/usercollection/sleep",         "sleep",   None),
    "daily_readiness": ("/v2/usercollection/daily_readiness", "daily", merge_readiness),
    "daily_activity":  ("/v2/usercollection/daily_activity",  "daily", merge_activity),
    "daily_stress":    ("/v2/usercollection/daily_stress",    "daily", merge_stress),
    "daily_spo2":      ("/v2/usercollection/daily_spo2",      "daily", merge_spo2),
    "daily_resilience":("/v2/usercollection/daily_resilience","daily", merge_resilience),
    "daily_cardiovascular_age":("/v2/usercollection/daily_cardiovascular_age","daily", merge_cardio_age),
    "workout":       ("/v2/usercollection/workout",       "event",   None),
    "session":       ("/v2/usercollection/session",       "event",   None),
    "enhanced_tag":  ("/v2/usercollection/enhanced_tag",  "event",   None),
    "vo2_max":       ("/v2/usercollection/vo2_max",       "event",   None),
    "heartrate":     ("/v2/usercollection/heartrate",     "hr",      None),
}


def cmd_sync(args: argparse.Namespace) -> None:
    seed_default_tenant()
    if getattr(args, "all_tenants", False):
        for t in list_tenants(enabled_only=True):
            if not resolve_oura_pat(t.owner):
                print(f"⚠️  跳过 {t.owner}：未配置 oura_pat")
                continue
            _set_owner(t.owner)
            _sync_owner(args)
        _set_owner("")
        return
    _set_owner(resolve_owner(args))
    _sync_owner(args)
    _set_owner("")


def _sync_owner(args: argparse.Namespace) -> None:
    today = date.today()
    if args.start and args.end:
        start = date.fromisoformat(args.start)
        end = date.fromisoformat(args.end)
    else:
        days = args.days or 7
        end = today
        start = today - timedelta(days=days - 1)

    resources = [args.resource] if args.resource else [
        "daily_sleep", "sleep", "daily_readiness", "daily_activity",
        "daily_stress", "daily_spo2", "daily_resilience", "daily_cardiovascular_age",
        "workout", "session", "enhanced_tag",
    ]
    if args.include_heartrate:
        resources.append("heartrate")

    print(f"🔄 同步 {_owner()} 的 Oura 数据：{start} → {end}（{(end-start).days+1} 天）")
    for res in resources:
        if res not in RESOURCES:
            print(f"  ⚠️  未知 resource: {res}，跳过")
            continue
        path, kind, merge_fn = RESOURCES[res]
        s = _get_state(res) + timedelta(days=1) if (args.resume and _get_state(res)) else start
        if s > end:
            print(f"  ✓ {res}: 已是最新（last={_get_state(res)}）")
            continue
        try:
            if kind == "daily":
                _sync_daily_resource(path, s, end, merge_fn, res)
            elif kind == "sleep":
                _sync_sleep(s, end)
            elif kind == "event":
                _sync_events(res, path, s, end)
            elif kind == "hr":
                _sync_heartrate(s, end)
        except Exception as e:
            print(f"  ❌ {res}: {e}")
            _set_state(res, s, err=str(e)[:500])


# ───────── 查询 ─────────

def _fmt_duration(seconds: Optional[int]) -> str:
    if seconds is None:
        return "  —  "
    h, rem = divmod(seconds, 3600)
    m, _ = divmod(rem, 60)
    return f"{h}h{m:02d}m"


def _fmt(v: Any, w: int = 5) -> str:
    if v is None:
        return "—".rjust(w)
    if isinstance(v, float):
        return f"{v:.1f}".rjust(w)
    return str(v).rjust(w)


def cmd_today(args: argparse.Namespace) -> None:
    _set_owner(resolve_owner(args))
    rows = db_query(
        """
        SELECT day, sleep_score, total_sleep_seconds, deep_sleep_seconds, rem_sleep_seconds,
               sleep_efficiency, hrv_avg, rhr_avg,
               readiness_score, readiness_temperature_deviation,
               activity_score, steps, active_calories,
               stress_day_summary, resilience_level, spo2_avg
        FROM health.oura_daily
        WHERE owner=%s
        ORDER BY day DESC
        LIMIT 7
        """,
        (_owner(),),
    )
    if not rows:
        print("没数据，先跑 `oura.py sync`。")
        return

    latest = rows[0]
    print(f"\n📅 最近同步: {latest['day']}\n")
    print("─── 昨晚睡眠 ───")
    print(f"  Sleep Score     : {_fmt(latest['sleep_score'])}")
    print(f"  总睡眠          : {_fmt_duration(latest['total_sleep_seconds'])}")
    print(f"  深睡 / REM      : {_fmt_duration(latest['deep_sleep_seconds'])} / {_fmt_duration(latest['rem_sleep_seconds'])}")
    print(f"  睡眠效率        : {_fmt(latest['sleep_efficiency'])}%")
    print(f"  HRV             : {_fmt(latest['hrv_avg'])}")
    print(f"  静息心率        : {_fmt(latest['rhr_avg'])}")

    print("\n─── 今日状态 ───")
    print(f"  Readiness       : {_fmt(latest['readiness_score'])}")
    print(f"  体温偏离        : {_fmt(latest['readiness_temperature_deviation'])}")
    print(f"  压力            : {latest['stress_day_summary'] or '—'}")
    print(f"  恢复力          : {latest['resilience_level'] or '—'}")
    print(f"  SpO2            : {_fmt(latest['spo2_avg'])}")

    print("\n─── 昨日活动 ───")
    print(f"  Activity Score  : {_fmt(latest['activity_score'])}")
    print(f"  步数            : {_fmt(latest['steps'], 6)}")
    print(f"  活动卡路里      : {_fmt(latest['active_calories'], 4)}")

    print("\n─── 过去 7 天 ───")
    print(f"  {'日期':<12} {'Sleep':>6} {'Ready':>6} {'Act':>5} {'HRV':>5} {'RHR':>5} {'Steps':>6}")
    for r in rows:
        print(f"  {str(r['day']):<12} {_fmt(r['sleep_score'])} {_fmt(r['readiness_score'])} {_fmt(r['activity_score'])} {_fmt(r['hrv_avg'])} {_fmt(r['rhr_avg'])} {_fmt(r['steps'], 6)}")


def cmd_trend(args: argparse.Namespace) -> None:
    _set_owner(resolve_owner(args))
    days = args.days or 30
    rows = db_query(
        """
        SELECT day, sleep_score, readiness_score, activity_score, hrv_avg, rhr_avg,
               total_sleep_seconds, steps
        FROM health.oura_daily
        WHERE owner=%s AND day >= current_date - (%s::int - 1)
        ORDER BY day ASC
        """,
        (_owner(), days),
    )
    if not rows:
        print("没数据。")
        return
    import statistics

    def stats(key: str) -> str:
        vals = [r[key] for r in rows if r.get(key) is not None]
        if not vals:
            return "—"
        avg = statistics.mean(vals)
        if len(vals) >= 2:
            return f"avg={avg:.1f} min={min(vals):.1f} max={max(vals):.1f} n={len(vals)}"
        return f"avg={avg:.1f} n=1"

    print(f"\n📈 最近 {days} 天趋势（{_owner()}）\n")
    print(f"  Sleep Score    : {stats('sleep_score')}")
    print(f"  Readiness      : {stats('readiness_score')}")
    print(f"  Activity       : {stats('activity_score')}")
    print(f"  HRV            : {stats('hrv_avg')}")
    print(f"  RHR            : {stats('rhr_avg')}")
    sleep_h = [r['total_sleep_seconds']/3600 for r in rows if r.get('total_sleep_seconds')]
    if sleep_h:
        print(f"  睡眠时长 (h)   : avg={statistics.mean(sleep_h):.2f} min={min(sleep_h):.2f} max={max(sleep_h):.2f}")
    steps = [r['steps'] for r in rows if r.get('steps')]
    if steps:
        print(f"  步数           : avg={statistics.mean(steps):.0f} max={max(steps)}")

    print("\n  日期         Sleep  Ready  Act   HRV   RHR")
    for r in rows[-14:]:
        print(f"  {str(r['day']):<12} {_fmt(r['sleep_score'])} {_fmt(r['readiness_score'])} {_fmt(r['activity_score'])} {_fmt(r['hrv_avg'])} {_fmt(r['rhr_avg'])}")


def cmd_raw(args: argparse.Namespace) -> None:
    path = args.path
    if not path.startswith("/"):
        path = "/" + path
    resp = oura_get(path)
    print(json.dumps(resp, indent=2, ensure_ascii=False))


# ───────── CLI ─────────

def main() -> None:
    p = argparse.ArgumentParser(description="shujian-health / Oura Ring CLI")
    sub = p.add_subparsers(dest="cmd", required=True)

    sub.add_parser("init", help="建表").set_defaults(func=cmd_init)
    sub.add_parser("whoami", help="personal_info").set_defaults(func=cmd_whoami)

    sp = sub.add_parser("sync", help="同步数据")
    sp.add_argument("--days", type=int, default=7)
    sp.add_argument("--start")
    sp.add_argument("--end")
    sp.add_argument("--resource")
    sp.add_argument("--resume", action="store_true")
    sp.add_argument("--include-heartrate", action="store_true", help="顺带拉分钟级心率（数据量大）")
    sp.add_argument("--owner", help="租户 owner（默认 HEALTH_OWNER）")
    sp.add_argument("--all", dest="all_tenants", action="store_true", help="同步所有已启用租户")
    sp.set_defaults(func=cmd_sync)

    sp = sub.add_parser("today", help="今日简报")
    sp.add_argument("--owner", help="租户 owner")
    sp.set_defaults(func=cmd_today)

    sp = sub.add_parser("trend", help="趋势表")
    sp.add_argument("--days", type=int, default=30)
    sp.add_argument("--owner", help="租户 owner")
    sp.set_defaults(func=cmd_trend)

    sp = sub.add_parser("raw", help="直接打 API 调试")
    sp.add_argument("path")
    sp.set_defaults(func=cmd_raw)

    args = p.parse_args()
    args.func(args)


if __name__ == "__main__":
    main()
