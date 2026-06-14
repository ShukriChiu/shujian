-- shujian-health: CGM (连续血糖监测) 每日聚合
-- 数据源：三诺 iCan CGM 系统，通过 sino-health API 拉取
-- 由 shujian-health skill 的 cgm.py sync 命令消费
--
-- 设计思路：
--   - 每日一行 (owner, day)，存储从 pointList 计算的统计指标
--   - 服务端预算的 tir/tar/tbr 直接存储，本地额外计算 cv/gmi/dawn 等
--   - raw_day 保留完整 API 响应（含 pointList），支持事后重算

CREATE SCHEMA IF NOT EXISTS health;

CREATE TABLE IF NOT EXISTS health.cgm_daily (
    owner text NOT NULL,
    day date NOT NULL,

    -- Time in Range (服务端预算 + 本地校验)
    tir numeric,                   -- % in 3.9-7.8 mmol/L
    tar numeric,                   -- % above 7.8
    tbr numeric,                   -- % below 3.9
    tar_high numeric,              -- % very high (>10.0)
    tbr_low numeric,               -- % very low (<3.0)

    -- 统计指标 (从 pointList 计算)
    mean_glucose numeric,          -- mmol/L
    min_glucose numeric,
    max_glucose numeric,
    std_glucose numeric,
    cv_glucose numeric,            -- coefficient of variation %
    gmi numeric,                   -- Glucose Management Indicator %

    -- 模式检测
    hypo_events int DEFAULT 0,     -- 低血糖事件数 (< 3.9 持续 >= 15min)
    dawn_effect boolean DEFAULT false,
    dawn_mean_glucose numeric,     -- 03:00-06:00 平均血糖

    -- 数据质量
    data_points int,
    data_completeness numeric,     -- points / 480 * 100

    -- 原始响应
    raw_day jsonb,

    synced_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (owner, day)
);

CREATE INDEX IF NOT EXISTS idx_cgm_daily_owner_day
    ON health.cgm_daily(owner, day DESC);

-- 同步状态
CREATE TABLE IF NOT EXISTS health.cgm_sync_state (
    owner text PRIMARY KEY,
    sino_user_id text,
    last_synced_day date,
    last_run_at timestamptz NOT NULL DEFAULT now(),
    last_error text
);
