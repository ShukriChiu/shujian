-- Future redesign: WarRoom (admin-curated talent pool) → Intake CRM
-- (public survey link → admin reviews → assigns to projects → tracks growth).
--
-- The 0005 schema modeled students/projects/squads/feedback as if an
-- admin manually populated them. The new model is built around an
-- inbound application funnel:
--
--   future_share_links       per-tenant public token + label
--   future_students          intake fields + admin-managed status/tags
--   future_resumes           1:1 BYTEA, separate so list queries stay fast
--   future_projects          name / status / dates only (was over-modeled)
--   future_assignments       student ↔ project, role, dates, status
--   future_notes             freeform timeline entries on a student
--
-- The previous future_* tables are dropped: data was empty in production
-- and the new model is a clean break (status enums, ID strategy, FK shape
-- all change). See AGENTS.md "Cross-app changes" rule — the matching
-- handlers and frontend client land in the same commit.

DROP TABLE IF EXISTS future_feedback;
DROP TABLE IF EXISTS future_squads;
DROP TABLE IF EXISTS future_projects;
DROP TABLE IF EXISTS future_students;

-- ── share links ────────────────────────────────────────────────────────
-- One public submission token per tenant. Rotating the token is the
-- "shut the link off" mechanism (we generate a new one and stop honoring
-- the old one). Future cohort-style multi-link support is purely additive.

CREATE TABLE future_share_links (
    tenant_id    uuid PRIMARY KEY REFERENCES tenants(id) ON DELETE CASCADE,
    token        text UNIQUE NOT NULL,
    label        text NOT NULL DEFAULT '招募中',
    is_open      boolean NOT NULL DEFAULT true,
    created_at   timestamptz NOT NULL DEFAULT now(),
    updated_at   timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT future_share_links_token_min_len CHECK (length(token) >= 16)
);

-- ── students (intake + admin) ──────────────────────────────────────────
-- ID strategy: server-generated UUID. The frontend never minted student
-- IDs in the new model — students arrive via public submit, so client
-- IDs would be untrusted. Composite (tenant_id, id) PK keeps physical
-- isolation (a row literally cannot belong to two tenants) and matches
-- the rest of the app's pattern.

CREATE TABLE future_students (
    tenant_id          uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    id                 uuid NOT NULL,

    -- intake (student-submitted)
    full_name          text NOT NULL,
    wechat_id          text NOT NULL DEFAULT '',
    wechat_nickname    text NOT NULL DEFAULT '',
    email              text NOT NULL DEFAULT '',
    phone              text NOT NULL DEFAULT '',
    university         text NOT NULL DEFAULT '',
    major              text NOT NULL DEFAULT '',
    grade_year         text NOT NULL DEFAULT 'other',
    ai_understanding   text NOT NULL DEFAULT '',
    ai_experience      text NOT NULL DEFAULT '',
    past_projects      text NOT NULL DEFAULT '',
    motivation         text NOT NULL DEFAULT '',
    has_resume         boolean NOT NULL DEFAULT false,

    -- admin-managed
    status             text NOT NULL DEFAULT 'new',
    admin_notes        text NOT NULL DEFAULT '',
    tags               text[] NOT NULL DEFAULT ARRAY[]::text[],

    -- audit
    submitted_at       timestamptz NOT NULL DEFAULT now(),
    updated_at         timestamptz NOT NULL DEFAULT now(),
    reviewed_at        timestamptz,
    reviewed_by_user_id uuid REFERENCES users(id) ON DELETE SET NULL,

    PRIMARY KEY (tenant_id, id),
    CONSTRAINT future_students_full_name_nonempty
        CHECK (length(btrim(full_name)) > 0),
    CONSTRAINT future_students_status_valid CHECK (status IN (
        'new',         -- 刚提交，等审阅
        'reviewing',   -- 在看
        'interview',   -- 安排面谈
        'accepted',    -- 通过
        'rejected',    -- 不通过
        'in_project',  -- 在项目里
        'alumni',      -- 毕业 / 离开
        'archived'     -- 软删
    )),
    CONSTRAINT future_students_grade_year_valid CHECK (grade_year IN (
        'freshman', 'sophomore', 'junior', 'senior',
        'master_1', 'master_2', 'master_3',
        'phd', 'alumni', 'other'
    ))
);

CREATE INDEX future_students_status_idx
    ON future_students(tenant_id, status, submitted_at DESC);
CREATE INDEX future_students_submitted_idx
    ON future_students(tenant_id, submitted_at DESC);

-- ── resumes (1:1, BYTEA) ───────────────────────────────────────────────
-- Separated from future_students so list queries don't drag megabytes
-- of bytea through Postgres. SELECT * FROM future_students stays cheap.
-- 5 MB hard cap enforced both at the API (multipart limit) and here.

CREATE TABLE future_resumes (
    tenant_id   uuid NOT NULL,
    student_id  uuid NOT NULL,
    filename    text NOT NULL,
    mime        text NOT NULL,
    size_bytes  integer NOT NULL,
    data        bytea NOT NULL,
    uploaded_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (tenant_id, student_id),
    FOREIGN KEY (tenant_id, student_id)
        REFERENCES future_students(tenant_id, id) ON DELETE CASCADE,
    CONSTRAINT future_resumes_size_cap CHECK (size_bytes BETWEEN 1 AND 5242880),
    CONSTRAINT future_resumes_filename_nonempty CHECK (length(btrim(filename)) > 0)
);

-- ── projects ───────────────────────────────────────────────────────────
-- Slimmer than 0005's projects: this app's v2 isn't in the business of
-- modeling milestones / perks / skill-needs in DB. Projects are mostly a
-- bucket students get attached to; richer fields can be added later as
-- columns or as a JSONB blob.

CREATE TABLE future_projects (
    tenant_id    uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    id           uuid NOT NULL,
    name         text NOT NULL,
    summary      text NOT NULL DEFAULT '',
    status       text NOT NULL DEFAULT 'planning',
    started_at   date,
    ended_at     date,
    created_at   timestamptz NOT NULL DEFAULT now(),
    updated_at   timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (tenant_id, id),
    CONSTRAINT future_projects_name_nonempty CHECK (length(btrim(name)) > 0),
    CONSTRAINT future_projects_status_valid CHECK (status IN (
        'planning', 'active', 'paused', 'completed', 'archived'
    ))
);

CREATE INDEX future_projects_status_idx
    ON future_projects(tenant_id, status, created_at DESC);

-- ── assignments (student ↔ project) ────────────────────────────────────
-- The growth-tracking primitive. A student can be on multiple projects;
-- a project can host multiple students. role + status + dates capture the
-- common case ("designer, active, joined 5/13") without a heavy schema.

CREATE TABLE future_assignments (
    tenant_id   uuid NOT NULL,
    student_id  uuid NOT NULL,
    project_id  uuid NOT NULL,
    role        text NOT NULL DEFAULT '队员',
    status      text NOT NULL DEFAULT 'active',
    joined_at   date NOT NULL DEFAULT current_date,
    left_at     date,
    notes       text NOT NULL DEFAULT '',
    created_at  timestamptz NOT NULL DEFAULT now(),
    updated_at  timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (tenant_id, student_id, project_id),
    FOREIGN KEY (tenant_id, student_id)
        REFERENCES future_students(tenant_id, id) ON DELETE CASCADE,
    FOREIGN KEY (tenant_id, project_id)
        REFERENCES future_projects(tenant_id, id) ON DELETE CASCADE,
    CONSTRAINT future_assignments_status_valid CHECK (status IN (
        'active', 'completed', 'left'
    ))
);

CREATE INDEX future_assignments_project_idx
    ON future_assignments(tenant_id, project_id);
CREATE INDEX future_assignments_student_idx
    ON future_assignments(tenant_id, student_id);

-- ── notes (timeline) ───────────────────────────────────────────────────
-- Replaces the rigid "feedback signal" enum from 0005 with freeform
-- timeline entries. `kind` keeps optional structure so the UI can color
-- intake/interview/checkin/milestone differently.

CREATE TABLE future_notes (
    tenant_id   uuid NOT NULL,
    id          uuid NOT NULL,
    student_id  uuid NOT NULL,
    project_id  uuid,                          -- optional link to a project
    kind        text NOT NULL DEFAULT 'general',
    body        text NOT NULL,
    author_user_id uuid REFERENCES users(id) ON DELETE SET NULL,
    created_at  timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (tenant_id, id),
    FOREIGN KEY (tenant_id, student_id)
        REFERENCES future_students(tenant_id, id) ON DELETE CASCADE,
    FOREIGN KEY (tenant_id, project_id)
        REFERENCES future_projects(tenant_id, id) ON DELETE SET NULL,
    CONSTRAINT future_notes_body_nonempty CHECK (length(btrim(body)) > 0),
    CONSTRAINT future_notes_kind_valid CHECK (kind IN (
        'general', 'intake', 'interview', 'checkin', 'milestone', 'concern'
    ))
);

CREATE INDEX future_notes_student_idx
    ON future_notes(tenant_id, student_id, created_at DESC);
