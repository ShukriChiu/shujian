"""Health storyline analysis engine (DeepKang-inspired five-layer framework)."""

from __future__ import annotations

import argparse
import json
import math
import sys
from dataclasses import asdict, dataclass
from datetime import date
from decimal import Decimal
from typing import Any, Dict, List, Optional, Tuple

from health.config import get_settings
from health.db import db_query
from health.tenants import resolve_owner

_current_owner: str | None = None


def _owner() -> str:
    if _current_owner:
        return _current_owner
    return get_settings().health_owner


def _f(v) -> Optional[float]:
    """把 Decimal / None 归一化成 float。"""
    if v is None:
        return None
    return float(v)


# ═══════════════════════════════════════════════════════════════
# 参考范围 — 文献来源 + 年龄校正 + 个人基线
# ═══════════════════════════════════════════════════════════════
#
# 证据等级标注：
#   A = 大型 RCT / meta-analysis / 学会共识（如 AASM 睡眠时长推荐）
#   B = 前瞻性队列 / 系统综述（如 HRV-死亡率关联）
#   C = 横断面研究 / 专家意见 / 厂商算法（如 Oura Score）
#   D = 本系统启发式规则（如 CV>0.2 阈值）

EVIDENCE_LEVEL = {
    "sleep_score":       "C",  # Oura 专有算法，基于已发表生理学但未独立同行评审
    "total_sleep_hours": "A",  # AASM/NSF 共识 7-9h (Hirshkowitz 2015; Watson 2015)
    "deep_sleep_hours":  "B",  # Oura 占比估计; 绝对时长参考 Diekelmann & Born 2010
    "rem_sleep_hours":   "B",  # 同上
    "sleep_efficiency":  "B",  # PSQI 标准 >85% (Buysse 1989); 广泛用于临床
    "hrv_avg":           "B",  # Task Force ESC/NASPE 1996; Shaffer & Ginsberg 2017
    "rhr_avg":           "B",  # AHA 正常范围 60-100; <60 为运动员常见
    "readiness_score":   "C",  # Oura 专有算法
    "activity_score":    "C",  # Oura 专有算法
    "steps":             "B",  # Tudor-Locke 2011; WHO 2020 建议
    # CGM 指标
    "tir":               "A",  # 国际共识 (Battelino 2019, Diabetes Care)
    "mean_glucose":      "A",  # 同上
    "cv_glucose":        "A",  # Monnier 2017; Danne 2017 国际共识
    "gmi":               "A",  # Bergenstal 2018, Diabetes Care
}

# 默认参考范围（无年龄校正时的 fallback）
REFERENCE_DEFAULT = {
    "sleep_score":       {"good": 75, "fair": 60, "unit": "分",   "label": "睡眠评分"},
    "total_sleep_hours": {"good": 7.0, "fair": 6.0, "unit": "h",  "label": "总睡眠"},
    "deep_sleep_hours":  {"good": 1.5, "fair": 1.0, "unit": "h",  "label": "深睡"},
    "rem_sleep_hours":   {"good": 1.5, "fair": 1.0, "unit": "h",  "label": "REM"},
    "sleep_efficiency":  {"good": 85,  "fair": 75,  "unit": "%",  "label": "睡眠效率"},
    "hrv_avg":           {"good": 40,  "fair": 25,  "unit": "ms", "label": "HRV"},
    "rhr_avg":           {"good": 60,  "fair": 70,  "unit": "bpm","label": "RHR", "invert": True},
    "readiness_score":   {"good": 75,  "fair": 60,  "unit": "分",  "label": "Readiness"},
    "activity_score":    {"good": 75,  "fair": 60,  "unit": "分",  "label": "活动评分"},
    "steps":             {"good": 8000,"fair": 5000,"unit": "步",  "label": "步数"},
    # CGM 指标 — 阈值来自 Battelino 2019 国际共识 + ADA 2024 指南
    "tir":               {"good": 70,  "fair": 50,  "unit": "%",     "label": "TIR"},
    "mean_glucose":      {"good": 7.0, "fair": 8.5, "unit": "mmol/L","label": "日均血糖", "invert": True},
    "cv_glucose":        {"good": 25,  "fair": 36,  "unit": "%",     "label": "血糖CV", "invert": True},
    "gmi":               {"good": 6.5, "fair": 7.0, "unit": "%",     "label": "GMI", "invert": True},
}

# HRV 按年龄段校正（文献来源：Nunan 2010 meta-analysis; van den Berg 2018）
# rMSSD (ms) 的人群中位数随年龄下降，这里给 good/fair 阈值
HRV_BY_AGE = {
    (0, 29):  {"good": 45, "fair": 30},
    (30, 39): {"good": 38, "fair": 25},
    (40, 49): {"good": 30, "fair": 20},
    (50, 59): {"good": 25, "fair": 17},
    (60, 99): {"good": 22, "fair": 15},
}

# RHR 按年龄段校正（AHA; Spodick 1992）
RHR_BY_AGE = {
    (0, 29):  {"good": 58, "fair": 68},
    (30, 39): {"good": 60, "fair": 70},
    (40, 49): {"good": 62, "fair": 72},
    (50, 59): {"good": 64, "fair": 74},
    (60, 99): {"good": 66, "fair": 76},
}


def _get_user_age() -> Optional[int]:
    """从 health.oura_personal_info 读年龄；没有则返回 None。"""
    try:
        rows = db_query(
            "SELECT age FROM health.oura_personal_info WHERE owner = %s LIMIT 1",
            (_owner(),),
        )
        return int(rows[0]["age"]) if rows and rows[0].get("age") else None
    except Exception:
        return None


def _age_bracket(age: int) -> Tuple[int, int]:
    for bracket in HRV_BY_AGE:
        if bracket[0] <= age <= bracket[1]:
            return bracket
    return (30, 39)


def build_reference(age: Optional[int]) -> Dict[str, Dict[str, Any]]:
    """构建参考范围：优先年龄校正，fallback 到默认值。"""
    import copy
    ref = copy.deepcopy(REFERENCE_DEFAULT)
    if age is not None:
        bracket = _age_bracket(age)
        hrv_adj = HRV_BY_AGE[bracket]
        rhr_adj = RHR_BY_AGE[bracket]
        ref["hrv_avg"]["good"] = hrv_adj["good"]
        ref["hrv_avg"]["fair"] = hrv_adj["fair"]
        ref["rhr_avg"]["good"] = rhr_adj["good"]
        ref["rhr_avg"]["fair"] = rhr_adj["fair"]
    return ref


def _load_personal_baseline() -> Dict[str, Dict[str, float]]:
    """拉历史全量数据算个人基线（mean ± std）。"""
    rows = db_query("""
        SELECT hrv_avg, rhr_avg, total_sleep_seconds, deep_sleep_seconds,
               rem_sleep_seconds, sleep_efficiency, sleep_score,
               readiness_score, activity_score, steps
        FROM health.oura_daily
        WHERE owner = %s
        ORDER BY day ASC
    """, (_owner(),))

    baseline: Dict[str, Dict[str, float]] = {}

    if len(rows) >= 14:
        mapping = {
            "hrv_avg": "hrv_avg",
            "rhr_avg": "rhr_avg",
            "sleep_score": "sleep_score",
            "readiness_score": "readiness_score",
            "activity_score": "activity_score",
            "steps": "steps",
            "sleep_efficiency": "sleep_efficiency",
        }
        for metric_key, db_col in mapping.items():
            vals = [float(r[db_col]) for r in rows if r.get(db_col) is not None]
            if len(vals) >= 14:
                avg = sum(vals) / len(vals)
                std = math.sqrt(sum((v - avg) ** 2 for v in vals) / (len(vals) - 1))
                baseline[metric_key] = {"mean": round(avg, 2), "std": round(std, 2), "n": len(vals)}

        for db_col, divisor, metric_key in [
            ("total_sleep_seconds", 3600, "total_sleep_hours"),
            ("deep_sleep_seconds", 3600, "deep_sleep_hours"),
            ("rem_sleep_seconds", 3600, "rem_sleep_hours"),
        ]:
            vals = [float(r[db_col]) / divisor for r in rows if r.get(db_col) is not None and float(r[db_col]) > 0]
            if len(vals) >= 14:
                avg = sum(vals) / len(vals)
                std = math.sqrt(sum((v - avg) ** 2 for v in vals) / (len(vals) - 1))
                baseline[metric_key] = {"mean": round(avg, 2), "std": round(std, 2), "n": len(vals)}

    # CGM 基线
    if _has_cgm_table():
        cgm_rows = db_query("""
            SELECT tir, mean_glucose, cv_glucose, gmi
            FROM health.cgm_daily
            WHERE owner = %s
            ORDER BY day ASC
        """, (_owner(),))
        if len(cgm_rows) >= 14:
            for metric_key in ("tir", "mean_glucose", "cv_glucose", "gmi"):
                vals = [float(r[metric_key]) for r in cgm_rows if r.get(metric_key) is not None]
                if len(vals) >= 14:
                    avg = sum(vals) / len(vals)
                    std = math.sqrt(sum((v - avg) ** 2 for v in vals) / (len(vals) - 1))
                    baseline[metric_key] = {"mean": round(avg, 2), "std": round(std, 2), "n": len(vals)}

    return baseline


# 后向兼容：如果其他代码直接引用 REFERENCE，指向默认值
REFERENCE = REFERENCE_DEFAULT

# 功能系统 → 相关指标映射
FUNCTIONAL_SYSTEMS = {
    "自主神经系统": {
        "desc": "交感/副交感平衡，决定应激与恢复能力",
        "metrics": ["hrv_avg", "rhr_avg"],
        "root_causes": {
            "sympathetic_dominance": "交感神经持续激活（应激负荷过高）",
        },
    },
    "睡眠系统": {
        "desc": "睡眠时长、结构和效率",
        "metrics": ["sleep_score", "total_sleep_hours", "deep_sleep_hours", "rem_sleep_hours", "sleep_efficiency"],
        "root_causes": {
            "chronic_sleep_debt": "慢性睡眠负债（总时长不足）",
            "irregular_schedule": "作息不规律（睡眠时长波动大）",
            "poor_architecture": "睡眠结构失衡（深睡/REM 不足）",
        },
    },
    "恢复系统": {
        "desc": "身体修复和恢复能力",
        "metrics": ["readiness_score"],
        "root_causes": {
            "recovery_exhaustion": "恢复力耗竭（持续低 Readiness）",
        },
    },
    "活动与代谢": {
        "desc": "日常活动量和能量消耗",
        "metrics": ["activity_score", "steps"],
        "root_causes": {
            "sedentary": "久坐不动（步数持续低于 5000）",
            "overtraining": "过度训练（高活动 + 次日 Readiness 暴跌）",
        },
    },
    "血糖代谢": {
        "desc": "血糖稳态控制能力（CGM 数据）",
        "metrics": ["tir", "mean_glucose", "cv_glucose", "gmi"],
        "root_causes": {
            "chronic_hyperglycemia": "慢性高血糖（TIR 持续低、均值偏高）",
            "glucose_instability": "血糖波动过大（CV > 36%）",
            "dawn_phenomenon": "黎明现象（凌晨 3-6 点血糖持续上升）",
        },
    },
}

# 干预库：root_cause_key → 干预建议（含证据等级和文献来源）
INTERVENTIONS = {
    "chronic_sleep_debt": {
        "priority": 0,
        "action": "把睡眠时长拉到 7h+",
        "why": "睡眠负债是一切恢复指标的底层依赖；HRV、Readiness、免疫、认知都建立在充足睡眠之上",
        "feedback": "sleep_score",
        "target": "Sleep Score → 75+（2 周内）",
        "evidence_level": "A",
        "citation": "Watson 2015 (AASM); Cappuccio 2010 meta-analysis, Sleep",
    },
    "irregular_schedule": {
        "priority": 1,
        "action": "固定上床/起床时间（±30 分钟）",
        "why": "昼夜节律混乱会让深睡窗口漂移，即使总时长够了质量也差",
        "feedback": "sleep_efficiency",
        "target": "睡眠效率 → 88%+，深睡比例稳定",
        "evidence_level": "B",
        "citation": "Phillips 2017, Scientific Reports; Lunsford-Avery 2018, Sleep",
    },
    "sympathetic_dominance": {
        "priority": 2,
        "action": "日间加入 10 分钟呼吸练习或冥想；睡前 1 小时低刺激",
        "why": "HRV 极低 + RHR 偏高说明交感神经长期占主导，副交感切换不了",
        "feedback": "hrv_avg",
        "target": "HRV 7 天均值 → 个人基线+1σ（4 周内）",
        "evidence_level": "A",
        "citation": "Lehrer & Gevirtz 2014, Biofeedback; Zou 2018 meta-analysis",
    },
    "poor_architecture": {
        "priority": 3,
        "action": "睡前避免酒精和大量碳水；卧室温度 18-20°C",
        "why": "深睡和 REM 对温度和血糖波动敏感",
        "feedback": "deep_sleep_hours",
        "target": "深睡 → 1.5h+，REM → 1.5h+",
        "evidence_level": "B",
        "citation": "Ebrahim 2013, Alcohol Clin Exp Res; Okamoto-Mizuno 2012, J Physiol Anthropol",
    },
    "recovery_exhaustion": {
        "priority": 4,
        "action": "连续 3 天 Readiness < 65 时强制休息日（无高强度运动）",
        "why": "恢复力耗竭时继续加量会让 HRV 进一步下跌",
        "feedback": "readiness_score",
        "target": "Readiness → 75+",
        "evidence_level": "C",
        "citation": "Readiness 为 Oura 合成指标；休息日建议基于 Halson 2014, Sports Med",
    },
    "sedentary": {
        "priority": 5,
        "action": "每天至少 30 分钟中等强度活动（快走/骑车）",
        "why": "适量运动提升 HRV 和深睡比例",
        "feedback": "steps",
        "target": "日均步数 → 8000+",
        "evidence_level": "A",
        "citation": "WHO 2020 Physical Activity Guidelines; Tudor-Locke 2011",
    },
    "overtraining": {
        "priority": 5,
        "action": "高强度训练后安排 1-2 天低强度恢复",
        "why": "过度训练会压低 HRV、拉高 RHR，抵消运动收益",
        "feedback": "readiness_score",
        "target": "训练后次日 Readiness 不低于 60",
        "evidence_level": "B",
        "citation": "Meeusen 2013, Med Sci Sports Exerc (ECSS/ACSM 共识声明)",
    },
    "chronic_hyperglycemia": {
        "priority": 1,
        "action": "控制碳水摄入总量和 GI 值；增加餐后 15 分钟步行",
        "why": "TIR < 50% 说明血糖大部分时间在目标范围外，是心血管和神经并发症的独立风险因子",
        "feedback": "tir",
        "target": "TIR → 70%+（4 周内）",
        "evidence_level": "A",
        "citation": "Battelino 2019, Diabetes Care; ADA Standards 2024",
    },
    "glucose_instability": {
        "priority": 2,
        "action": "固定进餐时间和份量；避免空腹高强度运动；睡前加餐稳定夜间血糖",
        "why": "血糖 CV > 36% 提示波动过大，是低血糖风险和氧化应激的标志",
        "feedback": "cv_glucose",
        "target": "血糖 CV → 25% 以下（2 周内）",
        "evidence_level": "A",
        "citation": "Monnier 2017; Danne 2017 国际共识",
    },
    "dawn_phenomenon": {
        "priority": 3,
        "action": "睡前加高蛋白/低 GI 零食；保证深睡质量以稳定皮质醇节律",
        "why": "黎明现象由凌晨皮质醇和生长激素分泌驱动，深睡不足会加重",
        "feedback": "mean_glucose",
        "target": "03-06 时段均值与日均差距 < 15%",
        "evidence_level": "B",
        "citation": "Bolli 1984, NEJM; Porcellati 2013, Diabetes Care",
    },
}


# ═══════════════════════════════════════════════════════════════
# 数据层 — 从 DB 拉数据 + 预处理
# ═══════════════════════════════════════════════════════════════

@dataclass
class DaySummary:
    day: str
    # Oura
    sleep_score: Optional[float] = None
    total_sleep_hours: Optional[float] = None
    deep_sleep_hours: Optional[float] = None
    rem_sleep_hours: Optional[float] = None
    sleep_efficiency: Optional[float] = None
    hrv_avg: Optional[float] = None
    rhr_avg: Optional[float] = None
    readiness_score: Optional[float] = None
    activity_score: Optional[float] = None
    steps: Optional[float] = None
    stress_day_summary: Optional[str] = None
    resilience_level: Optional[str] = None
    spo2_avg: Optional[float] = None
    temperature_deviation: Optional[float] = None
    # CGM
    tir: Optional[float] = None
    mean_glucose: Optional[float] = None
    cv_glucose: Optional[float] = None
    gmi: Optional[float] = None
    tar: Optional[float] = None
    tbr: Optional[float] = None
    hypo_events: Optional[int] = None
    dawn_effect: Optional[bool] = None
    dawn_mean_glucose: Optional[float] = None
    cgm_data_points: Optional[int] = None


def _has_cgm_table() -> bool:
    """检查 health.cgm_daily 表是否存在。"""
    try:
        rows = db_query("""
            SELECT 1 FROM information_schema.tables
            WHERE table_schema = 'health' AND table_name = 'cgm_daily'
            LIMIT 1
        """)
        return len(rows) > 0
    except Exception:
        return False


def load_data(days: int, owner: str | None = None) -> List[DaySummary]:
    global _current_owner
    owner_key = owner or get_settings().health_owner
    _current_owner = owner_key
    has_cgm = _has_cgm_table()

    if has_cgm:
        rows = db_query("""
            SELECT
                COALESCE(o.day, c.day) AS day,
                o.sleep_score, o.readiness_score, o.activity_score,
                o.hrv_avg, o.rhr_avg,
                o.total_sleep_seconds, o.deep_sleep_seconds, o.rem_sleep_seconds,
                o.sleep_efficiency, o.steps, o.active_calories,
                o.stress_day_summary, o.resilience_level, o.spo2_avg,
                o.readiness_temperature_deviation,
                c.tir, c.mean_glucose, c.cv_glucose, c.gmi,
                c.tar, c.tbr, c.hypo_events, c.dawn_effect,
                c.dawn_mean_glucose, c.data_points AS cgm_data_points
            FROM health.oura_daily o
            FULL OUTER JOIN health.cgm_daily c
                ON o.owner = c.owner AND o.day = c.day
            WHERE COALESCE(o.owner, c.owner) = %s
            ORDER BY COALESCE(o.day, c.day) DESC
            LIMIT %s
        """, (owner_key, days))
    else:
        rows = db_query("""
            SELECT day, sleep_score, readiness_score, activity_score,
                   hrv_avg, rhr_avg,
                   total_sleep_seconds, deep_sleep_seconds, rem_sleep_seconds,
                   sleep_efficiency, steps, active_calories,
                   stress_day_summary, resilience_level, spo2_avg,
                   readiness_temperature_deviation
            FROM health.oura_daily
            WHERE owner = %s
            ORDER BY day DESC
            LIMIT %s
        """, (owner_key, days))

    result = []
    for r in rows:
        tss = _f(r.get("total_sleep_seconds"))
        result.append(DaySummary(
            day=str(r["day"]),
            sleep_score=_f(r.get("sleep_score")),
            total_sleep_hours=round(tss / 3600, 2) if tss else None,
            deep_sleep_hours=round(_f(r["deep_sleep_seconds"]) / 3600, 2) if r.get("deep_sleep_seconds") else None,
            rem_sleep_hours=round(_f(r["rem_sleep_seconds"]) / 3600, 2) if r.get("rem_sleep_seconds") else None,
            sleep_efficiency=_f(r.get("sleep_efficiency")),
            hrv_avg=_f(r.get("hrv_avg")),
            rhr_avg=_f(r.get("rhr_avg")),
            readiness_score=_f(r.get("readiness_score")),
            activity_score=_f(r.get("activity_score")),
            steps=_f(r.get("steps")),
            stress_day_summary=r.get("stress_day_summary"),
            resilience_level=r.get("resilience_level"),
            spo2_avg=_f(r.get("spo2_avg")),
            temperature_deviation=_f(r.get("readiness_temperature_deviation")),
            # CGM fields
            tir=_f(r.get("tir")),
            mean_glucose=_f(r.get("mean_glucose")),
            cv_glucose=_f(r.get("cv_glucose")),
            gmi=_f(r.get("gmi")),
            tar=_f(r.get("tar")),
            tbr=_f(r.get("tbr")),
            hypo_events=int(r["hypo_events"]) if r.get("hypo_events") is not None else None,
            dawn_effect=r.get("dawn_effect"),
            dawn_mean_glucose=_f(r.get("dawn_mean_glucose")),
            cgm_data_points=int(r["cgm_data_points"]) if r.get("cgm_data_points") is not None else None,
        ))
    result.reverse()
    return result


# ═══════════════════════════════════════════════════════════════
# 统计工具
# ═══════════════════════════════════════════════════════════════

def _vals(data: List[DaySummary], key: str) -> List[float]:
    return [getattr(d, key) for d in data if getattr(d, key) is not None]


def _stats(vals: List[float]) -> Dict[str, float]:
    if not vals:
        return {}
    n = len(vals)
    avg = sum(vals) / n
    mn, mx = min(vals), max(vals)
    if n >= 2:
        variance = sum((x - avg) ** 2 for x in vals) / (n - 1)
        std = math.sqrt(variance)
        cv = std / avg if avg != 0 else 0
    else:
        std, cv = 0.0, 0.0
    return {"avg": round(avg, 1), "min": round(mn, 1), "max": round(mx, 1),
            "std": round(std, 1), "cv": round(cv, 3), "n": n}


def _trend_direction(vals: List[float]) -> str:
    """简单线性趋势：上升/下降/平稳。"""
    if len(vals) < 3:
        return "insufficient"
    n = len(vals)
    x_mean = (n - 1) / 2
    y_mean = sum(vals) / n
    num = sum((i - x_mean) * (v - y_mean) for i, v in enumerate(vals))
    den = sum((i - x_mean) ** 2 for i in range(n))
    if den == 0:
        return "flat"
    slope = num / den
    relative = slope / y_mean if y_mean != 0 else 0
    if relative > 0.01:
        return "improving"
    elif relative < -0.01:
        return "declining"
    return "stable"


def _pearson(xs: List[float], ys: List[float]) -> Optional[float]:
    """Pearson 相关系数。"""
    if len(xs) < 5 or len(xs) != len(ys):
        return None
    n = len(xs)
    mx, my = sum(xs) / n, sum(ys) / n
    num = sum((x - mx) * (y - my) for x, y in zip(xs, ys))
    dx = math.sqrt(sum((x - mx) ** 2 for x in xs))
    dy = math.sqrt(sum((y - my) ** 2 for y in ys))
    if dx == 0 or dy == 0:
        return None
    return round(num / (dx * dy), 3)


# ═══════════════════════════════════════════════════════════════
# 五层分析引擎
# ═══════════════════════════════════════════════════════════════

@dataclass
class MetricAssessment:
    key: str
    label: str
    avg: float
    status: str          # "good" | "fair" | "poor"
    trend: str           # "improving" | "declining" | "stable"
    detail: str
    reference_good: float
    reference_fair: float
    evidence_level: str = "C"       # A/B/C/D
    baseline_mean: Optional[float] = None
    baseline_std: Optional[float] = None
    baseline_deviation: Optional[str] = None  # "within" | "below_1sd" | "below_2sd" | "above_1sd" | "above_2sd"
    reference_source: str = ""      # "age_adjusted" | "population" | "personal_baseline"


@dataclass
class SystemAssessment:
    name: str
    desc: str
    status: str          # "healthy" | "stressed" | "critical"
    metrics: List[str]
    triggered_roots: List[str]


@dataclass
class RootCause:
    key: str
    label: str
    system: str
    evidence: List[str]
    confidence: str      # "high" | "medium" | "low"
    evidence_level: str = "D"  # 根因推断本身多为 D 级（启发式规则）
    caveat: str = ""           # 局限性说明


@dataclass
class Intervention:
    priority: int
    root_cause: str
    action: str
    why: str
    feedback_metric: str
    target: str
    evidence_level: str = "B"  # 干预建议的证据等级
    citation: str = ""         # 主要文献来源


@dataclass
class StoryLine:
    period: str
    data_days: int
    valid_days: int
    phenotype: List[MetricAssessment]
    systems: List[SystemAssessment]
    root_causes: List[RootCause]
    interventions: List[Intervention]
    feedback_indicators: List[str]
    correlations: Dict[str, float]
    resilience_streak: int
    worst_day: Optional[str]
    best_day: Optional[str]
    summary: str
    user_age: Optional[int] = None
    has_personal_baseline: bool = False
    disclaimer: str = ""


def analyze(data: List[DaySummary]) -> StoryLine:
    if not data:
        return StoryLine(
            period="", data_days=0, valid_days=0,
            phenotype=[], systems=[], root_causes=[], interventions=[],
            feedback_indicators=[], correlations={}, resilience_streak=0,
            worst_day=None, best_day=None, summary="没有数据可分析。"
        )

    period = f"{data[0].day} → {data[-1].day}"
    valid = [d for d in data if d.sleep_score is not None or d.readiness_score is not None or d.tir is not None]

    # 加载个性化参数
    user_age = _get_user_age()
    reference = build_reference(user_age)
    baseline = _load_personal_baseline()
    has_baseline = bool(baseline)

    # ── Layer 1: 表型 ──
    phenotype: List[MetricAssessment] = []
    for key, ref in reference.items():
        vals = _vals(data, key)
        if not vals:
            continue
        st = _stats(vals)
        avg = st["avg"]
        invert = ref.get("invert", False)

        bl = baseline.get(key)
        bl_mean = bl["mean"] if bl else None
        bl_std = bl["std"] if bl else None
        bl_deviation = None
        ref_source = "population"

        if bl and bl_std and bl_std > 0:
            delta = avg - bl_mean
            z = abs(delta) / bl_std
            if invert:
                if delta > bl_std * 2:
                    bl_deviation = "above_2sd"
                elif delta > bl_std:
                    bl_deviation = "above_1sd"
                elif delta < -bl_std * 2:
                    bl_deviation = "below_2sd"
                elif delta < -bl_std:
                    bl_deviation = "below_1sd"
                else:
                    bl_deviation = "within"
            else:
                if delta < -bl_std * 2:
                    bl_deviation = "below_2sd"
                elif delta < -bl_std:
                    bl_deviation = "below_1sd"
                elif delta > bl_std * 2:
                    bl_deviation = "above_2sd"
                elif delta > bl_std:
                    bl_deviation = "above_1sd"
                else:
                    bl_deviation = "within"
            ref_source = "personal_baseline"
        elif user_age and key in ("hrv_avg", "rhr_avg"):
            ref_source = "age_adjusted"

        if invert:
            status = "good" if avg <= ref["good"] else ("fair" if avg <= ref["fair"] else "poor")
        else:
            status = "good" if avg >= ref["good"] else ("fair" if avg >= ref["fair"] else "poor")

        if bl_deviation in ("below_2sd", "above_2sd") and status == "good":
            status = "fair"

        trend = _trend_direction(vals)

        detail_parts = [f"均值 {avg}{ref['unit']}"]
        if st["n"] >= 3:
            detail_parts.append(f"范围 {st['min']}~{st['max']}")
            detail_parts.append(f"波动 CV={st['cv']}")
        if bl_mean is not None:
            detail_parts.append(f"个人基线 {bl_mean}±{bl_std}")
            if bl_deviation and bl_deviation != "within":
                label_map = {
                    "below_1sd": "低于基线 1σ",
                    "below_2sd": "⚠ 低于基线 2σ",
                    "above_1sd": "高于基线 1σ",
                    "above_2sd": "⚠ 高于基线 2σ",
                }
                detail_parts.append(label_map.get(bl_deviation, ""))
        if trend in ("improving", "declining"):
            detail_parts.append(f"趋势{'↑' if trend == 'improving' else '↓'}")

        phenotype.append(MetricAssessment(
            key=key, label=ref["label"], avg=avg, status=status, trend=trend,
            detail="，".join(detail_parts),
            reference_good=ref["good"], reference_fair=ref["fair"],
            evidence_level=EVIDENCE_LEVEL.get(key, "C"),
            baseline_mean=bl_mean, baseline_std=bl_std,
            baseline_deviation=bl_deviation, reference_source=ref_source,
        ))

    # ── Layer 2: 功能系统 ──
    metric_status = {p.key: p.status for p in phenotype}
    systems: List[SystemAssessment] = []
    for sys_name, sys_def in FUNCTIONAL_SYSTEMS.items():
        statuses = [metric_status.get(m, "unknown") for m in sys_def["metrics"]]
        poor_count = statuses.count("poor")
        fair_count = statuses.count("fair")
        if poor_count >= 1:
            sys_status = "critical"
        elif fair_count >= 1:
            sys_status = "stressed"
        else:
            sys_status = "healthy"

        triggered: List[str] = []
        for rc_key, rc_label in sys_def["root_causes"].items():
            if _check_root_cause(rc_key, data, metric_status):
                triggered.append(rc_key)

        systems.append(SystemAssessment(
            name=sys_name, desc=sys_def["desc"], status=sys_status,
            metrics=[m for m in sys_def["metrics"] if m in metric_status],
            triggered_roots=triggered,
        ))

    # ── Layer 3: 根因 ──
    ROOT_CAUSE_CAVEATS = {
        "chronic_sleep_debt": "因果推断为 D 级——仅基于时长阈值计数，未排除记录误差、午睡补偿",
        "irregular_schedule": "CV 阈值 0.2 为启发式，文献中 SRI 有更精确的量化（Phillips 2017）",
        "sympathetic_dominance": "HRV 个体差异大，此推断需结合个人基线才有临床意义",
        "poor_architecture": "Oura 的睡眠分期基于加速度计+PPG，与 PSG 金标准有 10-15% 偏差",
        "recovery_exhaustion": "Readiness 是 Oura 专有合成指标，非临床标准",
        "sedentary": "步数受佩戴习惯影响（室内活动/游泳等可能漏计）",
        "overtraining": "单日高步数+次日低 Readiness 只是相关，不等于过度训练",
        "chronic_hyperglycemia": "TIR 阈值来自国际共识 (A 级)，但个人目标范围可能因医嘱不同",
        "glucose_instability": "CV 阈值 36% 来自国际共识；消费级 CGM 精度约 ±10% 可放大 CV",
        "dawn_phenomenon": "需排除 Somogyi 效应（夜间低血糖反弹导致的晨高）和用药影响",
    }
    root_causes: List[RootCause] = []
    for sa in systems:
        for rc_key in sa.triggered_roots:
            evidence = _gather_evidence(rc_key, data, phenotype)
            confidence = "high" if len(evidence) >= 3 else ("medium" if len(evidence) >= 2 else "low")
            rc_label = ""
            for sys_def in FUNCTIONAL_SYSTEMS.values():
                if rc_key in sys_def["root_causes"]:
                    rc_label = sys_def["root_causes"][rc_key]
                    break
            root_causes.append(RootCause(
                key=rc_key, label=rc_label, system=sa.name,
                evidence=evidence, confidence=confidence,
                evidence_level="D",
                caveat=ROOT_CAUSE_CAVEATS.get(rc_key, ""),
            ))

    # ── Layer 4: 干预 ──
    interventions: List[Intervention] = []
    seen_rc = set()
    for rc in root_causes:
        if rc.key in seen_rc or rc.key not in INTERVENTIONS:
            continue
        seen_rc.add(rc.key)
        iv = INTERVENTIONS[rc.key]
        interventions.append(Intervention(
            priority=iv["priority"], root_cause=rc.label,
            action=iv["action"], why=iv["why"],
            feedback_metric=iv["feedback"], target=iv["target"],
            evidence_level=iv.get("evidence_level", "B"),
            citation=iv.get("citation", ""),
        ))
    interventions.sort(key=lambda x: x.priority)

    # ── Layer 5: 反馈指标 ──
    feedback = []
    for iv in interventions[:3]:
        ref_info = REFERENCE.get(iv.feedback_metric, {})
        feedback.append(f"{ref_info.get('label', iv.feedback_metric)}：{iv.target}")

    # ── 辅助分析 ──
    correlations = _compute_correlations(data)

    resilience_limited = 0
    for d in reversed(data):
        if d.resilience_level == "limited":
            resilience_limited += 1
        elif d.resilience_level is not None:
            break

    readiness_vals = [(d.day, d.readiness_score) for d in data if d.readiness_score is not None]
    worst_day = min(readiness_vals, key=lambda x: x[1])[0] if readiness_vals else None
    best_day = max(readiness_vals, key=lambda x: x[1])[0] if readiness_vals else None

    summary = _generate_summary(phenotype, root_causes, interventions, period)

    has_cgm_data = any(d.tir is not None for d in data)
    disclaimer_parts = [
        "⚕️ 免责声明：本分析基于消费级可穿戴设备" + ("和 CGM " if has_cgm_data else "") + "数据，不构成医学诊断或治疗建议。",
    ]
    if user_age:
        disclaimer_parts.append(f"参考范围已按年龄 {user_age} 岁校正（HRV/RHR）。")
    else:
        disclaimer_parts.append("未检测到年龄信息，HRV/RHR 使用人群通用阈值（可能不适合你）。")
    if has_baseline:
        disclaimer_parts.append(f"个人基线基于 {baseline[next(iter(baseline))]['n']} 天历史数据。")
    else:
        disclaimer_parts.append("历史数据不足 14 天，未启用个人基线对比。")
    disclaimer_parts.append("证据等级：A=学会共识/RCT, B=队列/综述, C=厂商算法, D=启发式规则。")

    return StoryLine(
        period=period, data_days=len(data), valid_days=len(valid),
        phenotype=phenotype, systems=systems, root_causes=root_causes,
        interventions=interventions, feedback_indicators=feedback,
        correlations=correlations, resilience_streak=resilience_limited,
        worst_day=worst_day, best_day=best_day, summary=summary,
        user_age=user_age, has_personal_baseline=has_baseline,
        disclaimer=" ".join(disclaimer_parts),
    )


# ═══════════════════════════════════════════════════════════════
# 根因检测 — 每个 root_cause_key 的触发条件
# ═══════════════════════════════════════════════════════════════

def _check_root_cause(key: str, data: List[DaySummary], metric_status: Dict[str, str]) -> bool:
    if key == "chronic_sleep_debt":
        vals = _vals(data, "total_sleep_hours")
        if not vals:
            return False
        return sum(1 for v in vals if v < 6.5) / len(vals) > 0.5

    if key == "irregular_schedule":
        vals = _vals(data, "total_sleep_hours")
        st = _stats(vals)
        return st.get("cv", 0) > 0.2

    if key == "poor_architecture":
        deep = _vals(data, "deep_sleep_hours")
        rem = _vals(data, "rem_sleep_hours")
        deep_low = sum(1 for v in deep if v < 1.0) / len(deep) > 0.5 if deep else False
        rem_low = sum(1 for v in rem if v < 1.0) / len(rem) > 0.5 if rem else False
        return deep_low or rem_low

    if key == "sympathetic_dominance":
        return metric_status.get("hrv_avg") in ("poor", "fair") and metric_status.get("rhr_avg") in ("poor", "fair")

    if key == "recovery_exhaustion":
        vals = _vals(data, "readiness_score")
        return sum(1 for v in vals if v < 65) / len(vals) > 0.4 if vals else False

    if key == "sedentary":
        vals = _vals(data, "steps")
        return sum(1 for v in vals if v < 5000) / len(vals) > 0.6 if vals else False

    if key == "overtraining":
        for i in range(1, len(data)):
            prev, cur = data[i - 1], data[i]
            if (prev.steps and prev.steps > 10000 and
                    cur.readiness_score is not None and cur.readiness_score < 60):
                return True
        return False

    if key == "chronic_hyperglycemia":
        vals = _vals(data, "tir")
        if not vals:
            return False
        return sum(1 for v in vals if v < 50) / len(vals) > 0.5

    if key == "glucose_instability":
        vals = _vals(data, "cv_glucose")
        if not vals:
            return False
        avg_cv = sum(vals) / len(vals)
        return avg_cv > 36

    if key == "dawn_phenomenon":
        dawn_days = [d for d in data if d.dawn_effect is True]
        total_cgm_days = [d for d in data if d.tir is not None]
        if not total_cgm_days:
            return False
        return len(dawn_days) / len(total_cgm_days) > 0.5

    return False


def _gather_evidence(key: str, data: List[DaySummary], phenotype: List[MetricAssessment]) -> List[str]:
    evidence = []

    if key == "chronic_sleep_debt":
        vals = _vals(data, "total_sleep_hours")
        if vals:
            avg = sum(vals) / len(vals)
            under6 = sum(1 for v in vals if v < 6)
            evidence.append(f"平均睡眠 {avg:.1f}h（目标 7h+）")
            evidence.append(f"{under6}/{len(vals)} 天不足 6 小时")
            if any(p.key == "sleep_score" and p.status != "good" for p in phenotype):
                evidence.append("Sleep Score 持续偏低")

    elif key == "irregular_schedule":
        vals = _vals(data, "total_sleep_hours")
        st = _stats(vals)
        if st:
            evidence.append(f"睡眠时长 CV={st['cv']}（>0.2 为高波动）")
            evidence.append(f"范围 {st['min']}h ~ {st['max']}h")

    elif key == "sympathetic_dominance":
        hrv = _vals(data, "hrv_avg")
        rhr = _vals(data, "rhr_avg")
        if hrv:
            evidence.append(f"HRV 均值 {sum(hrv)/len(hrv):.0f}ms（健康参考 40+）")
        if rhr:
            evidence.append(f"RHR 均值 {sum(rhr)/len(rhr):.0f}bpm（偏高）")
        res = [d.resilience_level for d in data if d.resilience_level]
        lim = sum(1 for r in res if r == "limited")
        if res and lim / len(res) > 0.5:
            evidence.append(f"Resilience {lim}/{len(res)} 天为 limited")

    elif key == "poor_architecture":
        deep = _vals(data, "deep_sleep_hours")
        rem = _vals(data, "rem_sleep_hours")
        if deep:
            evidence.append(f"深睡均值 {sum(deep)/len(deep):.1f}h（目标 1.5h+）")
        if rem:
            evidence.append(f"REM 均值 {sum(rem)/len(rem):.1f}h（目标 1.5h+）")

    elif key == "recovery_exhaustion":
        vals = _vals(data, "readiness_score")
        if vals:
            low = sum(1 for v in vals if v < 65)
            evidence.append(f"Readiness < 65 的天数：{low}/{len(vals)}")

    elif key == "sedentary":
        vals = _vals(data, "steps")
        if vals:
            evidence.append(f"日均步数 {sum(vals)/len(vals):.0f}")
            low = sum(1 for v in vals if v < 5000)
            evidence.append(f"{low}/{len(vals)} 天不足 5000 步")

    elif key == "overtraining":
        for i in range(1, len(data)):
            prev, cur = data[i - 1], data[i]
            if (prev.steps and prev.steps > 10000 and
                    cur.readiness_score is not None and cur.readiness_score < 60):
                evidence.append(f"{prev.day} 步数 {int(prev.steps)} → {cur.day} Readiness {cur.readiness_score}")

    elif key == "chronic_hyperglycemia":
        tir_vals = _vals(data, "tir")
        mean_vals = _vals(data, "mean_glucose")
        if tir_vals:
            avg_tir = sum(tir_vals) / len(tir_vals)
            low_tir = sum(1 for v in tir_vals if v < 50)
            evidence.append(f"平均 TIR {avg_tir:.1f}%（目标 70%+）")
            evidence.append(f"{low_tir}/{len(tir_vals)} 天 TIR < 50%")
        if mean_vals:
            avg_mean = sum(mean_vals) / len(mean_vals)
            evidence.append(f"日均血糖 {avg_mean:.1f} mmol/L")

    elif key == "glucose_instability":
        cv_vals = _vals(data, "cv_glucose")
        if cv_vals:
            avg_cv = sum(cv_vals) / len(cv_vals)
            high_cv = sum(1 for v in cv_vals if v > 36)
            evidence.append(f"平均 CV {avg_cv:.1f}%（目标 <36%）")
            evidence.append(f"{high_cv}/{len(cv_vals)} 天 CV > 36%")
        hypo_total = sum(d.hypo_events or 0 for d in data if d.hypo_events is not None)
        if hypo_total > 0:
            evidence.append(f"低血糖事件共 {hypo_total} 次")

    elif key == "dawn_phenomenon":
        dawn_days = [d for d in data if d.dawn_effect is True]
        cgm_days = [d for d in data if d.tir is not None]
        if cgm_days:
            evidence.append(f"黎明现象: {len(dawn_days)}/{len(cgm_days)} 天检出")
        dawn_means = [d.dawn_mean_glucose for d in dawn_days if d.dawn_mean_glucose is not None]
        if dawn_means:
            evidence.append(f"03-06 时段平均 {sum(dawn_means)/len(dawn_means):.1f} mmol/L")

    return evidence


def _compute_correlations(data: List[DaySummary]) -> Dict[str, float]:
    pairs = [
        ("total_sleep_hours", "hrv_avg",       "睡眠时长 ↔ HRV"),
        ("total_sleep_hours", "readiness_score","睡眠时长 ↔ Readiness"),
        ("hrv_avg",           "readiness_score","HRV ↔ Readiness"),
        ("steps",             "sleep_score",    "步数 ↔ 次日睡眠"),
        ("deep_sleep_hours",  "hrv_avg",        "深睡 ↔ HRV"),
    ]

    # Oura × CGM 跨源关联（仅当有 CGM 数据时）
    has_cgm = any(d.tir is not None for d in data)
    if has_cgm:
        pairs.extend([
            ("total_sleep_hours", "tir",          "睡眠时长 ↔ 次日TIR"),
            ("hrv_avg",           "cv_glucose",    "HRV ↔ 血糖CV"),
            ("readiness_score",   "mean_glucose",  "Readiness ↔ 日均血糖"),
            ("deep_sleep_hours",  "mean_glucose",  "深睡 ↔ 日均血糖"),
            ("steps",             "tir",           "步数 ↔ TIR"),
        ])

    result = {}
    for k1, k2, label in pairs:
        paired = [(getattr(d, k1), getattr(d, k2)) for d in data
                  if getattr(d, k1) is not None and getattr(d, k2) is not None]
        if len(paired) >= 5:
            xs, ys = zip(*paired)
            r = _pearson(list(xs), list(ys))
            if r is not None:
                result[label] = r
    return result


def _generate_summary(
    phenotype: List[MetricAssessment],
    root_causes: List[RootCause],
    interventions: List[Intervention],
    period: str,
) -> str:
    poor = [p for p in phenotype if p.status == "poor"]
    fair = [p for p in phenotype if p.status == "fair"]
    good = [p for p in phenotype if p.status == "good"]

    cgm_metrics = {"TIR", "日均血糖", "血糖CV", "GMI"}
    oura_phenotype = [p for p in phenotype if p.label not in cgm_metrics]
    cgm_phenotype = [p for p in phenotype if p.label in cgm_metrics]

    lines = [f"分析周期：{period}"]

    sources = []
    if oura_phenotype:
        sources.append("Oura Ring")
    if cgm_phenotype:
        sources.append("SINO CGM")
    lines.append(f"数据源：{'、'.join(sources)}")

    if poor:
        lines.append(f"⚠ {len(poor)} 项指标处于警戒区：{'、'.join(p.label for p in poor)}")
    if fair:
        lines.append(f"△ {len(fair)} 项指标需要关注：{'、'.join(p.label for p in fair)}")
    if good:
        lines.append(f"✓ {len(good)} 项指标在健康范围")

    high_rc = [rc for rc in root_causes if rc.confidence == "high"]
    if high_rc:
        lines.append(f"根因推断（高置信）：{'、'.join(rc.label for rc in high_rc)}")

    if interventions:
        top = interventions[0]
        lines.append(f"最优先干预：{top.action}")

    return "\n".join(lines)


# ═══════════════════════════════════════════════════════════════
# 输出格式化
# ═══════════════════════════════════════════════════════════════

STATUS_ICON = {"good": "✅", "fair": "⚠️ ", "poor": "🔴"}
SYS_ICON = {"healthy": "✅", "stressed": "⚠️ ", "critical": "🔴"}
CONFIDENCE_LABEL = {"high": "高", "medium": "中", "low": "低"}
EVIDENCE_BADGE = {"A": "[A]", "B": "[B]", "C": "[C]", "D": "[D]"}
REF_SOURCE_LABEL = {
    "personal_baseline": "个人基线",
    "age_adjusted": "年龄校正",
    "population": "人群通用",
}


def print_storyline(sl: StoryLine) -> None:
    if not sl.phenotype:
        print("没有数据可分析。先跑 `oura.py sync`。")
        return

    print(f"\n{'═' * 64}")
    print(f"  健康故事线 — {sl.period}（{sl.valid_days}/{sl.data_days} 天有效）")
    age_str = f"  年龄：{sl.user_age} 岁（参考值已校正）" if sl.user_age else "  年龄：未知（使用人群通用参考值）"
    bl_str = "  个人基线：✓ 已加载" if sl.has_personal_baseline else "  个人基线：✗ 数据不足"
    print(age_str)
    print(bl_str)
    print(f"{'═' * 64}")

    # Layer 1
    print(f"\n{'─' * 50}")
    print("  Layer 1: 表型层 — 现在发生了什么")
    print(f"  证据等级：A=学会共识 B=队列研究 C=厂商算法 D=启发式")
    print(f"{'─' * 50}")
    for p in sl.phenotype:
        icon = STATUS_ICON.get(p.status, "  ")
        ev = EVIDENCE_BADGE.get(p.evidence_level, "")
        src = REF_SOURCE_LABEL.get(p.reference_source, "")
        src_tag = f" ({src})" if src else ""
        print(f"  {icon} {ev} {p.label:<8} {p.detail}{src_tag}")

    # Layer 2
    print(f"\n{'─' * 50}")
    print("  Layer 2: 功能系统 — 哪些系统失衡")
    print(f"{'─' * 50}")
    for s in sl.systems:
        icon = SYS_ICON.get(s.status, "  ")
        root_note = f"  → 触发根因：{'、'.join(s.triggered_roots)}" if s.triggered_roots else ""
        print(f"  {icon} {s.name}（{s.desc}）{root_note}")

    # Layer 3
    print(f"\n{'─' * 50}")
    print("  Layer 3: 根因推断")
    print(f"  ⚠ 根因推断均为 D 级（启发式模式匹配），不等于临床诊断")
    print(f"{'─' * 50}")
    if not sl.root_causes:
        print("  没有检测到明确根因。")
    for rc in sl.root_causes:
        print(f"\n  [{CONFIDENCE_LABEL[rc.confidence]}置信] {rc.label}")
        print(f"    所属系统：{rc.system}")
        for ev in rc.evidence:
            print(f"    · {ev}")
        if rc.caveat:
            print(f"    ⚠ 局限：{rc.caveat}")

    # Correlations
    if sl.correlations:
        print(f"\n{'─' * 50}")
        print("  跨指标相关性")
        n_str = f"（N={sl.valid_days}，小样本结论需谨慎）" if sl.valid_days < 30 else ""
        print(f"{'─' * 50}")
        if n_str:
            print(f"  {n_str}")
        for label, r in sorted(sl.correlations.items(), key=lambda x: abs(x[1]), reverse=True):
            strength = "强" if abs(r) > 0.6 else ("中" if abs(r) > 0.3 else "弱")
            direction = "正相关" if r > 0 else "负相关"
            print(f"  {label}: r={r:+.3f}（{strength}{direction}）")

    # Layer 4
    print(f"\n{'─' * 50}")
    print("  Layer 4: 干预优先级")
    print(f"{'─' * 50}")
    for i, iv in enumerate(sl.interventions):
        ev = EVIDENCE_BADGE.get(iv.evidence_level, "")
        print(f"\n  P{i} {ev} {iv.action}")
        print(f"      因为：{iv.root_cause}")
        print(f"      原理：{iv.why}")
        print(f"      目标：{iv.target}")
        if iv.citation:
            print(f"      文献：{iv.citation}")

    # Layer 5
    print(f"\n{'─' * 50}")
    print("  Layer 5: 反馈指标追踪")
    print(f"{'─' * 50}")
    for fb in sl.feedback_indicators:
        print(f"  📊 {fb}")

    if sl.resilience_streak > 0:
        print(f"\n  ⚡ Resilience 连续 {sl.resilience_streak} 天 limited")

    if sl.worst_day:
        print(f"  📉 最差日：{sl.worst_day}")
    if sl.best_day:
        print(f"  📈 最佳日：{sl.best_day}")

    print(f"\n{'═' * 64}")
    print(f"  摘要")
    print(f"{'═' * 64}")
    print(f"  {sl.summary.replace(chr(10), chr(10) + '  ')}")

    # 免责声明
    print(f"\n{'─' * 64}")
    print(f"  {sl.disclaimer}")
    print()


def to_json(sl: StoryLine) -> str:
    def _ser(obj):
        if isinstance(obj, (date, Decimal)):
            return str(obj)
        if hasattr(obj, "__dataclass_fields__"):
            return asdict(obj)
        return obj
    return json.dumps(asdict(sl), default=_ser, ensure_ascii=False, indent=2)


# ═══════════════════════════════════════════════════════════════
# CLI
# ═══════════════════════════════════════════════════════════════

def cmd_storyline(args: argparse.Namespace) -> None:
    global _current_owner
    _current_owner = resolve_owner(args)
    data = load_data(args.days, owner=_current_owner)
    sl = analyze(data)
    if getattr(args, "json", False):
        print(to_json(sl))
    else:
        print_storyline(sl)


def main() -> None:
    p = argparse.ArgumentParser(description="健康故事线分析引擎")
    p.add_argument("--days", type=int, default=14, help="分析最近 N 天（默认 14）")
    p.add_argument("--json", action="store_true", help="输出 JSON")
    args = p.parse_args()
    cmd_storyline(args)


if __name__ == "__main__":
    main()
