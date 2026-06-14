-- shujian-health CF Worker: OAuth + Webhook 扩展表
-- 配合 /cf-worker/shujian-health/ 使用
--
-- 设计：
--   oauth_tokens        — 存每个 owner 的 access/refresh token + expires
--   webhook_events      — 原始事件日志（无损保留，便于回放）
--   webhook_subscriptions — Oura 返回的订阅 id，方便 renew/delete

CREATE TABLE IF NOT EXISTS health.oura_oauth_tokens (
    owner text PRIMARY KEY,
    access_token text NOT NULL,
    refresh_token text,
    token_type text DEFAULT 'Bearer',
    expires_at timestamptz NOT NULL,
    scopes text[],
    oura_user_id text,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS health.oura_webhook_events (
    id bigserial PRIMARY KEY,
    owner text,
    event_type text,          -- create / update / delete
    data_type text,           -- sleep / daily_activity / daily_readiness / ...
    object_id text,
    event_time timestamptz,
    user_id text,             -- Oura user id
    processed boolean NOT NULL DEFAULT false,
    process_error text,
    raw jsonb NOT NULL,
    received_at timestamptz NOT NULL DEFAULT now(),
    processed_at timestamptz
);

CREATE INDEX IF NOT EXISTS idx_oura_wh_events_owner ON health.oura_webhook_events(owner, received_at DESC);
CREATE INDEX IF NOT EXISTS idx_oura_wh_events_processed ON health.oura_webhook_events(processed) WHERE processed = false;

CREATE TABLE IF NOT EXISTS health.oura_webhook_subscriptions (
    id text PRIMARY KEY,           -- Oura 返回的 subscription id
    owner text NOT NULL,
    callback_url text NOT NULL,
    event_type text NOT NULL,
    data_type text NOT NULL,
    expiration_time timestamptz,   -- Oura 订阅 90 天过期，需要 renew
    raw jsonb NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_oura_wh_subs_owner ON health.oura_webhook_subscriptions(owner);
