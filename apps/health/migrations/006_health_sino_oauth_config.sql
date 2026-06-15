-- 三诺 OAuth 应用凭证（服务级 singleton；UI 配置后写入，health serve 启动时与 .env 合并）

CREATE TABLE IF NOT EXISTS health.sino_oauth_config (
    id                  text PRIMARY KEY DEFAULT 'default',
    sino_client_id      text,
    sino_client_secret  text,
    sino_client_basic   text,
    ican_username       text,
    ican_password       text,
    updated_at          timestamptz NOT NULL DEFAULT now()
);
