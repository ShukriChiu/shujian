-- Initial schema for shujian-backend.
--
-- Multi-tenant control plane:
--   tenants     organisations / companies / clients
--   users       human (or service) identities. Login candidates.
--   memberships M:N between users and tenants, carries role
--   sessions    opaque-token sessions. Token is sha256-hashed before storage,
--               so a DB leak doesn't yield usable tokens.
--
-- All ids are UUIDv7 generated app-side so we can avoid the uuid-ossp
-- extension and keep migrations portable.

CREATE TABLE tenants (
    id              uuid PRIMARY KEY,
    slug            text UNIQUE NOT NULL,
    name            text NOT NULL,
    display_name    text,
    status          text NOT NULL DEFAULT 'active',
    metadata        jsonb NOT NULL DEFAULT '{}'::jsonb,
    created_at      timestamptz NOT NULL DEFAULT now(),
    updated_at      timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT tenants_slug_lowercase CHECK (slug = lower(slug)),
    CONSTRAINT tenants_status_valid   CHECK (status IN ('active', 'suspended', 'archived'))
);

CREATE TABLE users (
    id              uuid PRIMARY KEY,
    -- "identifier" is what the user types into the login form. Often an
    -- email but we don't enforce email shape — `admin` works.
    identifier      text UNIQUE NOT NULL,
    password_hash   text NOT NULL,        -- argon2id PHC string
    display_name    text,
    status          text NOT NULL DEFAULT 'active',
    is_superuser    boolean NOT NULL DEFAULT false,
    last_login_at   timestamptz,
    metadata        jsonb NOT NULL DEFAULT '{}'::jsonb,
    created_at      timestamptz NOT NULL DEFAULT now(),
    updated_at      timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT users_identifier_lowercase CHECK (identifier = lower(identifier)),
    CONSTRAINT users_status_valid CHECK (status IN ('active', 'suspended', 'archived'))
);

CREATE TABLE memberships (
    tenant_id       uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    user_id         uuid NOT NULL REFERENCES users(id)   ON DELETE CASCADE,
    role            text NOT NULL DEFAULT 'member',
    created_at      timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (tenant_id, user_id),
    CONSTRAINT memberships_role_valid CHECK (role IN ('owner', 'admin', 'member', 'viewer'))
);

CREATE INDEX memberships_user_idx ON memberships(user_id);

CREATE TABLE sessions (
    id              uuid PRIMARY KEY,
    user_id         uuid NOT NULL REFERENCES users(id)   ON DELETE CASCADE,
    -- The current tenant for this session. NULL = no tenant context yet
    -- (caller hasn't picked one). Switching tenant updates this in place.
    tenant_id       uuid REFERENCES tenants(id) ON DELETE SET NULL,
    -- Hex of sha256(raw_token). Raw token is given to the client once at
    -- login. Anyone with DB read can't impersonate.
    token_hash      text UNIQUE NOT NULL,
    user_agent      text,
    client_ip       inet,
    expires_at      timestamptz NOT NULL,
    last_active_at  timestamptz NOT NULL DEFAULT now(),
    created_at      timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX sessions_user_idx          ON sessions(user_id);
CREATE INDEX sessions_expires_at_idx    ON sessions(expires_at);
