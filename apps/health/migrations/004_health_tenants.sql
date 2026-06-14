-- Multi-tenant registry + service-level SINO OAuth cache (survives Railway redeploys)

CREATE TABLE IF NOT EXISTS health.tenants (
    owner text PRIMARY KEY,
    sino_user_id text,
    oura_pat text,
    display_name text,
    enabled boolean NOT NULL DEFAULT true,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_tenants_enabled ON health.tenants(enabled) WHERE enabled = true;

-- Singleton row (id='default'): shared OAuth token for all CGM pulls
CREATE TABLE IF NOT EXISTS health.sino_oauth (
    id text PRIMARY KEY DEFAULT 'default',
    access_token text NOT NULL,
    refresh_token text NOT NULL,
    expires_at timestamptz NOT NULL,
    username text NOT NULL,
    real_name text,
    updated_at timestamptz NOT NULL DEFAULT now()
);
