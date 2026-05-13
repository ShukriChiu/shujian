-- Future: AI 学生实战人才池管理台.
--
-- All tables are namespaced with `future_` prefix to keep `apps/future`
-- isolated from other apps that share this backend (dashboard, etc.).
-- See AGENTS.md and backend's main.rs `nest("/v1/future", ...)`.
--
-- Tenant scoping is enforced at the row level: every business row carries
-- `tenant_id` and the API extracts it from `AuthContext.session.tenant_id`.
--
-- ID strategy: text PRIMARY KEY (composite with tenant_id). Frontend
-- generates IDs like `stu-{base36}-{random}` via `safeId()` and the server
-- just stores them. Uniqueness is per-tenant, not global, so two tenants
-- can both have a student with id 'stu-foo' without colliding.
--
-- Composite FKs from squads/feedback include `tenant_id` so a squad row
-- physically cannot reference a student in another tenant.

CREATE TABLE future_students (
    tenant_id     uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    id            text NOT NULL,
    name          text NOT NULL,
    alias         text,
    initial       text NOT NULL,
    background    text NOT NULL,
    school        text NOT NULL,
    major         text NOT NULL,
    grade         text NOT NULL,
    skills        jsonb NOT NULL DEFAULT '{}'::jsonb,
    availability  text NOT NULL DEFAULT '',
    status        text NOT NULL DEFAULT 'active',
    intro         text NOT NULL DEFAULT '',
    -- joined_at is a YYYY-MM-DD string in the frontend; keeping it as text
    -- preserves round-trip fidelity (frontend never owned a real timestamp).
    joined_at     text NOT NULL,
    created_at    timestamptz NOT NULL DEFAULT now(),
    updated_at    timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (tenant_id, id),
    CONSTRAINT future_students_id_nonempty CHECK (length(btrim(id)) > 0),
    CONSTRAINT future_students_status_valid
        CHECK (status IN ('active', 'spotlight', 'pending', 'paused')),
    CONSTRAINT future_students_skills_object
        CHECK (jsonb_typeof(skills) = 'object')
);

CREATE TABLE future_projects (
    tenant_id       uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    id              text NOT NULL,
    name            text NOT NULL,
    codename        text NOT NULL DEFAULT '',
    -- "趣学洋葱 / 三诺 / 友联 / 个人实验室 / 外部合作". Free-form so adding
    -- a new partner doesn't require a migration.
    source          text NOT NULL,
    difficulty      smallint NOT NULL DEFAULT 1,
    skill_needs     jsonb NOT NULL DEFAULT '{}'::jsonb,
    team_size       smallint NOT NULL DEFAULT 1,
    status          text NOT NULL DEFAULT 'recruiting',
    brief           text NOT NULL DEFAULT '',
    next_milestone  text NOT NULL DEFAULT '',
    started_at      text NOT NULL,
    created_at      timestamptz NOT NULL DEFAULT now(),
    updated_at      timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (tenant_id, id),
    CONSTRAINT future_projects_id_nonempty CHECK (length(btrim(id)) > 0),
    CONSTRAINT future_projects_status_valid
        CHECK (status IN ('recruiting', 'sailing', 'docked', 'shipped')),
    CONSTRAINT future_projects_difficulty_valid
        CHECK (difficulty BETWEEN 1 AND 3),
    CONSTRAINT future_projects_team_size_valid
        CHECK (team_size BETWEEN 1 AND 32),
    CONSTRAINT future_projects_skill_needs_object
        CHECK (jsonb_typeof(skill_needs) = 'object')
);

-- Squads are the M:N matching between students and projects. Composite
-- key prevents the same student from joining the same project twice; the
-- API also enforces team_size at write time.
CREATE TABLE future_squads (
    tenant_id   uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    student_id  text NOT NULL,
    project_id  text NOT NULL,
    role        text NOT NULL DEFAULT '队员',
    joined_at   text NOT NULL,
    created_at  timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (tenant_id, student_id, project_id),
    FOREIGN KEY (tenant_id, student_id)
        REFERENCES future_students(tenant_id, id) ON DELETE CASCADE,
    FOREIGN KEY (tenant_id, project_id)
        REFERENCES future_projects(tenant_id, id) ON DELETE CASCADE
);

CREATE INDEX future_squads_project_idx
    ON future_squads(tenant_id, project_id);

CREATE TABLE future_feedback (
    tenant_id   uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    id          text NOT NULL,
    student_id  text NOT NULL,
    -- project_id is nullable: feedback can be tied to a project or be
    -- "general" feedback on the student outside any squad.
    project_id  text,
    date        text NOT NULL,
    signal      text NOT NULL,
    notes       text NOT NULL DEFAULT '',
    created_at  timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (tenant_id, id),
    FOREIGN KEY (tenant_id, student_id)
        REFERENCES future_students(tenant_id, id) ON DELETE CASCADE,
    FOREIGN KEY (tenant_id, project_id)
        REFERENCES future_projects(tenant_id, id) ON DELETE SET NULL,
    CONSTRAINT future_feedback_id_nonempty CHECK (length(btrim(id)) > 0),
    CONSTRAINT future_feedback_signal_valid
        CHECK (signal IN ('shipping', 'learning', 'breakthrough', 'needs_followup'))
);

CREATE INDEX future_feedback_student_idx
    ON future_feedback(tenant_id, student_id);
CREATE INDEX future_feedback_project_idx
    ON future_feedback(tenant_id, project_id);
