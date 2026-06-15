-- 健管师多用户名册：manager（健管师 = shujian-agent 登录用户）→ 多个 patient（被监测用户）
-- CGM 数据表（cgm_daily/cgm_readings/cgm_sync_state）继续按 owner 隔离，
-- 这里令 owner = patient 的 sino_user_id（patient-as-owner），名册控制可见性。

CREATE SCHEMA IF NOT EXISTS health;

CREATE TABLE IF NOT EXISTS health.patients (
    id           text PRIMARY KEY,          -- surrogate key（预留 patient 自助登录）
    manager      text NOT NULL,             -- 健管师 id（shujian-agent JWT owner）
    sino_user_id text,                       -- 三诺 iCan userId（CGM owner）
    phone        text,                       -- 添加时输入的手机号（明文）
    display_name text,
    enabled      boolean NOT NULL DEFAULT true,
    created_at   timestamptz NOT NULL DEFAULT now(),
    updated_at   timestamptz NOT NULL DEFAULT now(),
    UNIQUE (manager, sino_user_id)
);

CREATE INDEX IF NOT EXISTS idx_patients_manager ON health.patients(manager);
CREATE INDEX IF NOT EXISTS idx_patients_enabled ON health.patients(manager, enabled) WHERE enabled = true;
