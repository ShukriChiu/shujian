-- Persona Spec v1 support + persona launch pipeline.
--
-- Two changes, both additive:
--
--   1. agent_personas:
--        + spec_version text  — pinning to PERSONA_SPEC.md version, lets
--                               the backend reject unknown majors later.
--        + capabilities jsonb — opaque manifest the dashboard renders.
--                               Backend NEVER inspects it; treated like
--                               cursor_settings (validated as array).
--
--   2. vault_issuance_log:
--        + onion_jtis text[]  — a launch can mint multiple JWTs (one per
--                               onion_jwt binding); we keep them all so
--                               revoke can hit every one.
--        existing `onion_jti` stays as the "primary" jti for the audit
--        UI and for back-compat — populated from onion_jtis[1].
--
-- See personas/PERSONA_SPEC.md for the manifest schema.

ALTER TABLE agent_personas
    ADD COLUMN IF NOT EXISTS spec_version text NOT NULL DEFAULT '1.0',
    ADD COLUMN IF NOT EXISTS capabilities jsonb NOT NULL DEFAULT '[]'::jsonb;

ALTER TABLE agent_personas
    ADD CONSTRAINT agent_personas_capabilities_array
        CHECK (jsonb_typeof(capabilities) = 'array');

ALTER TABLE vault_issuance_log
    ADD COLUMN IF NOT EXISTS onion_jtis text[] NOT NULL DEFAULT '{}',
    -- Free-form per-launch metadata: stash error context, partial
    -- failures, the raw cursor_settings snapshot we issued under, etc.
    ADD COLUMN IF NOT EXISTS metadata jsonb NOT NULL DEFAULT '{}'::jsonb;
