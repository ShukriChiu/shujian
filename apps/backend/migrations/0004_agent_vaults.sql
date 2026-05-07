-- Agent vaults: named bundles of envVars that the dashboard injects into
-- a Cursor cloud agent's sandbox at launch time.
--
-- Different from `vault_secrets` in 0002: vault_secrets are individual
-- encrypted entries owned by tenant admins, intended to be composed via
-- `vault_scopes` into AI-safe persona launches. `agent_vaults` are the
-- cheap-and-cheerful "bag of envs" the user names like a folder
-- ("stripe-prod", "onion-readonly") and picks at agent launch time. The
-- intent matches the original localStorage `lib/vaults.ts` model — moved
-- to the server so users get cross-device sync.
--
-- Per-(tenant, user) ownership: vaults belong to the user that created
-- them within the active tenant. This keeps accidental cross-tenant leaks
-- impossible (you only see your own vaults inside the tenant you're in)
-- and lets us add explicit `agent_vault_shares` later without rewriting.
--
-- Encryption uses the same DEK envelope as vault_secrets:
--   envs_ciphertext  = AES-256-GCM(envs_dek, JSON.stringify(envs))
--   envs_dek_wrapped = AES-256-GCM(active_kek, envs_dek, AAD=(tenant_id, vault_id))
-- See `vault/crypto.rs` for the exact format.

CREATE TABLE agent_vaults (
    id              uuid PRIMARY KEY,
    tenant_id       uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    user_id         uuid NOT NULL REFERENCES users(id)   ON DELETE CASCADE,

    name            text NOT NULL,                -- "stripe-prod", display label
    description     text NOT NULL DEFAULT '',
    tags            jsonb NOT NULL DEFAULT '[]'::jsonb, -- text[] really, but jsonb keeps the list ordering

    -- AES-256-GCM(envs_dek, json_bytes(envs))
    envs_ciphertext bytea NOT NULL,
    envs_nonce      bytea NOT NULL,               -- 12 bytes
    envs_auth_tag   bytea NOT NULL,               -- 16 bytes

    -- AES-256-GCM(active_kek, envs_dek, AAD = tenant_id || 0x00 || vault_id)
    envs_dek_wrapped bytea NOT NULL,
    envs_dek_nonce   bytea NOT NULL,              -- 12 bytes
    envs_kek_version int  NOT NULL REFERENCES vault_kek_versions(version),

    -- Cached metadata so the list endpoint doesn't have to decrypt every
    -- row just to render the count column.
    env_keys        text[] NOT NULL DEFAULT '{}',
    env_count       int    NOT NULL DEFAULT 0,

    created_at      timestamptz NOT NULL DEFAULT now(),
    updated_at      timestamptz NOT NULL DEFAULT now(),

    CONSTRAINT agent_vaults_unique_name        UNIQUE (tenant_id, user_id, name),
    CONSTRAINT agent_vaults_nonce_len          CHECK (octet_length(envs_nonce) = 12),
    CONSTRAINT agent_vaults_auth_tag_len       CHECK (octet_length(envs_auth_tag) = 16),
    CONSTRAINT agent_vaults_dek_nonce_len      CHECK (octet_length(envs_dek_nonce) = 12),
    CONSTRAINT agent_vaults_name_nonempty      CHECK (length(btrim(name)) > 0)
);

CREATE INDEX agent_vaults_tenant_user_idx ON agent_vaults (tenant_id, user_id, updated_at DESC);
