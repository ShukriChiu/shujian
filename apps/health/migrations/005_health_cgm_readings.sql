-- 分钟级 CGM 原始读数（支持餐后曲线/峰值等细粒度问答）。
-- 与 cgm_daily 互补：daily 存聚合，readings 存每个采样点。

CREATE SCHEMA IF NOT EXISTS health;

CREATE TABLE IF NOT EXISTS health.cgm_readings (
    owner   text NOT NULL,
    ts      timestamptz NOT NULL,   -- 采样时间（三诺 dataTime）
    glucose numeric NOT NULL,       -- mmol/L
    day     date NOT NULL,          -- 归属日（便于按天查询）
    PRIMARY KEY (owner, ts)
);

CREATE INDEX IF NOT EXISTS idx_cgm_readings_owner_day ON health.cgm_readings(owner, day);
CREATE INDEX IF NOT EXISTS idx_cgm_readings_owner_ts ON health.cgm_readings(owner, ts);
