-- shujian-health: Oura Ring 数据存档
-- 由 shujian-health skill 的 sync 命令消费
--
-- 设计思路：
--   - 每日聚合放 health.oura_daily，按 (owner, day) 唯一。最常查的指标提到顶层列（sleep_score/hrv/rhr 等），其余存 raw jsonb。
--   - 事件类（workout/session/enhanced_tag）放 health.oura_events，按 external_id 去重。
--   - 分钟级心率数据量大，单独一张 health.oura_heartrate，可选 sync。
--   - 所有表都带 owner 字段，配合 BRAIN_PROFILE 做多人隔离。

CREATE SCHEMA IF NOT EXISTS health;

-- ─── 每日聚合 ───
CREATE TABLE IF NOT EXISTS health.oura_daily (
    owner text NOT NULL,
    day date NOT NULL,

    -- Sleep（来自 daily_sleep + sleep 主睡眠段）
    sleep_score int,
    total_sleep_seconds int,
    deep_sleep_seconds int,
    rem_sleep_seconds int,
    light_sleep_seconds int,
    sleep_efficiency int,
    sleep_latency_seconds int,
    bedtime_start timestamptz,
    bedtime_end timestamptz,
    hrv_avg numeric,
    rhr_avg numeric,
    respiratory_rate numeric,

    -- Readiness
    readiness_score int,
    readiness_temperature_deviation numeric,
    readiness_temperature_trend_deviation numeric,

    -- Activity
    activity_score int,
    steps int,
    active_calories int,
    total_calories int,
    equivalent_walking_distance_m int,
    high_activity_seconds int,
    medium_activity_seconds int,
    low_activity_seconds int,
    sedentary_seconds int,

    -- 其他每日指标
    stress_day_summary text,     -- restored / normal / stressful
    stress_high_seconds int,
    stress_recovery_seconds int,
    spo2_avg numeric,
    resilience_level text,       -- limited / adequate / solid / strong / exceptional
    cardiovascular_age int,

    -- 原始数据，保留完整响应方便以后加列
    raw_daily_sleep jsonb,
    raw_sleep jsonb,
    raw_readiness jsonb,
    raw_activity jsonb,
    raw_stress jsonb,
    raw_spo2 jsonb,
    raw_resilience jsonb,
    raw_cardio_age jsonb,

    synced_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (owner, day)
);

CREATE INDEX IF NOT EXISTS idx_oura_daily_owner_day ON health.oura_daily(owner, day DESC);

-- ─── 事件类（workout / session / tag）───
CREATE TABLE IF NOT EXISTS health.oura_events (
    owner text NOT NULL,
    kind text NOT NULL,          -- workout | session | enhanced_tag | vo2_max
    external_id text NOT NULL,   -- Oura 返回的 id
    day date,
    start_time timestamptz,
    end_time timestamptz,
    label text,                  -- activity/session 类型或 tag 名称
    raw jsonb NOT NULL,
    synced_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (owner, kind, external_id)
);

CREATE INDEX IF NOT EXISTS idx_oura_events_owner_day ON health.oura_events(owner, day DESC);
CREATE INDEX IF NOT EXISTS idx_oura_events_kind ON health.oura_events(owner, kind, start_time DESC);

-- ─── 分钟级心率（可选，数据量大）───
CREATE TABLE IF NOT EXISTS health.oura_heartrate (
    owner text NOT NULL,
    ts timestamptz NOT NULL,
    bpm int NOT NULL,
    source text,                 -- awake / rest / sleep / workout / live
    PRIMARY KEY (owner, ts)
);

CREATE INDEX IF NOT EXISTS idx_oura_hr_owner_ts ON health.oura_heartrate(owner, ts DESC);

-- ─── Personal Info（单例快照）───
CREATE TABLE IF NOT EXISTS health.oura_personal_info (
    owner text PRIMARY KEY,
    oura_user_id text,
    age int,
    weight numeric,
    height numeric,
    biological_sex text,
    email text,
    raw jsonb,
    synced_at timestamptz NOT NULL DEFAULT now()
);

-- ─── 同步状态（断点续传）───
CREATE TABLE IF NOT EXISTS health.oura_sync_state (
    owner text NOT NULL,
    resource text NOT NULL,      -- daily_sleep / sleep / daily_readiness / ...
    last_synced_day date,
    last_run_at timestamptz NOT NULL DEFAULT now(),
    last_error text,
    PRIMARY KEY (owner, resource)
);
