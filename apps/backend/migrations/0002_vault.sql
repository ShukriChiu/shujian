-- Vault & Persona schema.
--
-- See ARCHITECTURE_VAULT.md for the full design. Quick recap:
--   vault_kek_versions   tracks which KEK version wrapped which row's DEK.
--                        Lets us rotate KEK by re-wrapping rows in the bg.
--   vault_secrets        AES-256-GCM ciphertext + per-row DEK, wrapped by
--                        the current KEK loaded at boot from Railway env
--                        (SHUJIAN_VAULT_KEK_B64). UNIQUE(tenant_id, name).
--   vault_operator_refs  "this AI persona is which operator in the
--                        downstream system (onion-agent / others)".
--                        is_shadow=true means a synthetic AI employee.
--   vault_scopes         JSONB array of bindings ({ kind, ... }) that turns
--                        secrets into AI-safe envVars at launch time.
--   agent_personas       "who this AI is": system_prompt + allowed_scopes +
--                        cursor_settings (permission_mode / tools / model).
--   vault_issuance_log   audit: who issued which env_keys to which agent
--                        run, what JWT jti was minted, when it expires.
--
-- All ids are UUIDv7 generated app-side (matches 0001_init style).
-- Tenant scoping is enforced at the table level via FK + UNIQUE(tenant_id, ...).

CREATE TABLE vault_kek_versions (
    version         int PRIMARY KEY,
    fingerprint     text NOT NULL,
    -- Where this KEK material lives. Free-form so we can swap providers
    -- later without a schema migration:
    --   'env_prod'  → SHUJIAN_VAULT_KEK_B64 (Railway / equivalent)
    --   'env_dev'   → SHUJIAN_VAULT_DEV_KEK_B64 (local dev fallback)
    --   'kms:arn:aws:kms:...' → AWS KMS unwrap-only key (future)
    --   '1password://vaults/.../items/...' → 1Password Connect (future)
    source          text NOT NULL,
    activated_at    timestamptz NOT NULL DEFAULT now(),
    deprecated_at   timestamptz,
    notes           text
);

-- Each secret is encrypted with a per-row 256-bit DEK; the DEK itself is
-- wrapped by the active KEK. Re-wrapping during KEK rotation only touches
-- dek_wrapped + kek_version, never the ciphertext.
CREATE TABLE vault_secrets (
    id              uuid PRIMARY KEY,
    tenant_id       uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    name            text NOT NULL,                -- 'onion.database_url'
    kind            text NOT NULL DEFAULT 'env',  -- 'env' | 'jwt_signing' | 'webhook' | 'oauth' | 'r2_secret'
    description     text,
    -- AES-256-GCM
    ciphertext      bytea NOT NULL,
    nonce           bytea NOT NULL,               -- 12 bytes
    auth_tag        bytea NOT NULL,               -- 16 bytes (separated for clarity; some libs glue it onto ciphertext)
    -- DEK wrapped by KEK using AES-256-GCM-SIV (or plain GCM with a fixed AAD).
    dek_wrapped     bytea NOT NULL,
    dek_nonce       bytea NOT NULL,
    kek_version     int NOT NULL REFERENCES vault_kek_versions(version),
    metadata        jsonb NOT NULL DEFAULT '{}'::jsonb,
    created_by      uuid REFERENCES users(id) ON DELETE SET NULL,
    created_at      timestamptz NOT NULL DEFAULT now(),
    rotated_at      timestamptz,
    last_used_at    timestamptz,
    UNIQUE (tenant_id, name),
    CONSTRAINT vault_secrets_kind_valid
        CHECK (kind IN ('env', 'jwt_signing', 'webhook', 'oauth', 'r2_secret', 'misc')),
    CONSTRAINT vault_secrets_name_lowercase
        CHECK (name = lower(name)),
    CONSTRAINT vault_secrets_nonce_size CHECK (octet_length(nonce) = 12),
    CONSTRAINT vault_secrets_auth_tag_size CHECK (octet_length(auth_tag) = 16)
);

CREATE INDEX vault_secrets_tenant_kind_idx ON vault_secrets(tenant_id, kind);

-- "AI persona X 在 onion-agent 里是哪个 operator". Shadow operators
-- (is_shadow=true) are synthetic AI employees we created in the downstream
-- system. Real ones reuse a human's identity and lose audit clarity, so we
-- recommend shadow.
CREATE TABLE vault_operator_refs (
    id              uuid PRIMARY KEY,
    tenant_id       uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    system          text NOT NULL,                -- 'onion'
    operator_id     text NOT NULL,                -- onion employees.id (uuid as text)
    operator_name   text NOT NULL,                -- 'AI·老板分析师'
    is_shadow       boolean NOT NULL DEFAULT true,
    role_hint       text,                         -- 'analyst_readonly' / 'procurement' / ...
    metadata        jsonb NOT NULL DEFAULT '{}'::jsonb,
    created_by      uuid REFERENCES users(id) ON DELETE SET NULL,
    created_at      timestamptz NOT NULL DEFAULT now(),
    UNIQUE (tenant_id, system, operator_id)
);

CREATE INDEX vault_operator_refs_tenant_idx ON vault_operator_refs(tenant_id);

-- A scope packages secrets into "what does the AI actually see in env".
-- bindings JSONB schema:
--   [
--     { "kind": "passthrough",  "secret_name": "openrouter_api_key", "env": "OPENROUTER_API_KEY" },
--     { "kind": "static",       "value": "https://onion-agent.shujian.art", "env": "ONION_API_BASE" },
--     { "kind": "onion_jwt",    "operator_ref_id": "<uuid>", "env": "ONION_API_TOKEN",
--       "ttl_seconds": 3600, "readonly": true },
--     { "kind": "r2_presigned", "secret_name": "onion.r2.secret_access_key",
--       "bucket": "lesson", "perms": ["get"], "key_prefix": "...",
--       "ttl_seconds": 600, "env": "R2_LESSON_GET_URL" }
--   ]
CREATE TABLE vault_scopes (
    id              uuid PRIMARY KEY,
    tenant_id       uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    name            text NOT NULL,                -- 'onion.readonly_business'
    description     text,
    bindings        jsonb NOT NULL,
    -- Optional convenience pointer when the scope is dominated by one
    -- onion_jwt binding. UI uses this for grouping; not enforced.
    primary_operator_ref_id uuid REFERENCES vault_operator_refs(id) ON DELETE SET NULL,
    created_by      uuid REFERENCES users(id) ON DELETE SET NULL,
    created_at      timestamptz NOT NULL DEFAULT now(),
    updated_at      timestamptz NOT NULL DEFAULT now(),
    UNIQUE (tenant_id, name),
    CONSTRAINT vault_scopes_name_lowercase
        CHECK (name = lower(name)),
    CONSTRAINT vault_scopes_bindings_array
        CHECK (jsonb_typeof(bindings) = 'array')
);

CREATE INDEX vault_scopes_tenant_idx ON vault_scopes(tenant_id);

-- An AI persona = "who this AI is". Bound to a set of scopes plus the
-- cursor SDK launch settings.
--
-- cursor_settings JSONB schema (all optional except runtime/model):
--   {
--     "runtime": "cloud" | "local",
--     "model": "composer-2",
--     "permission_mode": "plan" | "default" | "accept_edits" | "auto" | "supervised",
--     "tools_whitelist": ["http_fetch", "read_file"],
--     "tools_blacklist": ["shell_exec", "write_file"],
--     "setting_sources": ["project", "user"],
--     "max_budget_usd": 0.50,
--     "effort": "min" | "low" | "medium" | "high" | "max",
--     "max_turns": 20,
--     "auto_create_pr": false,
--     "repo_url": "...", "starting_ref": "..."
--   }
CREATE TABLE agent_personas (
    id              uuid PRIMARY KEY,
    tenant_id       uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    slug            text NOT NULL,                -- 'onion_boss_analyst'
    display_name    text NOT NULL,                -- '洋葱老板·经营分析师'
    description     text,
    system_prompt   text NOT NULL,
    allowed_scopes  uuid[] NOT NULL DEFAULT '{}', -- ⊆ vault_scopes(id)
    cursor_settings jsonb NOT NULL DEFAULT '{}'::jsonb,
    domain          text,                         -- free-form tag, e.g. 'analytics'
    created_by      uuid REFERENCES users(id) ON DELETE SET NULL,
    created_at      timestamptz NOT NULL DEFAULT now(),
    updated_at      timestamptz NOT NULL DEFAULT now(),
    UNIQUE (tenant_id, slug),
    CONSTRAINT agent_personas_slug_lowercase
        CHECK (slug = lower(slug)),
    CONSTRAINT agent_personas_settings_object
        CHECK (jsonb_typeof(cursor_settings) = 'object')
);

CREATE INDEX agent_personas_tenant_idx ON agent_personas(tenant_id);

-- Audit log: every persona launch records what was injected (key names
-- only, never values), and which JWT jti was minted so we can revoke.
CREATE TABLE vault_issuance_log (
    id              uuid PRIMARY KEY,
    tenant_id       uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    persona_id      uuid REFERENCES agent_personas(id) ON DELETE SET NULL,
    issued_to_user  uuid REFERENCES users(id) ON DELETE SET NULL,  -- who clicked launch
    bridge_name     text,                                          -- 'mac-mini-studio' / 'cloud'
    cursor_agent_id text,
    cursor_run_id   text,
    scope_ids       uuid[] NOT NULL DEFAULT '{}',
    env_keys        text[] NOT NULL DEFAULT '{}',                  -- key names only
    onion_jti       text,                                          -- jti to revoke if needed
    expires_at      timestamptz,
    revoked_at      timestamptz,
    created_at      timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX vault_issuance_log_tenant_created_idx
    ON vault_issuance_log(tenant_id, created_at DESC);
CREATE INDEX vault_issuance_log_persona_idx
    ON vault_issuance_log(persona_id);

-- Convenience: the bg job that re-wraps DEKs during KEK rotation needs
-- this often, plus the launch handler walks all secrets in a scope.
CREATE INDEX vault_secrets_kek_version_idx ON vault_secrets(kek_version);

-- Bump updated_at automatically. Standard trigger pattern.
CREATE OR REPLACE FUNCTION vault_touch_updated_at()
RETURNS trigger AS $$
BEGIN
    NEW.updated_at = now();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER vault_scopes_touch_updated_at
    BEFORE UPDATE ON vault_scopes
    FOR EACH ROW EXECUTE FUNCTION vault_touch_updated_at();

CREATE TRIGGER agent_personas_touch_updated_at
    BEFORE UPDATE ON agent_personas
    FOR EACH ROW EXECUTE FUNCTION vault_touch_updated_at();
