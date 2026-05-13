//! `apps/future` — AI 学生实战人才池管理台.
//!
//! V1 ships a single composite endpoint per tenant:
//!
//!   GET  /v1/future/state   → returns the full WarRoomData for the active tenant
//!   PUT  /v1/future/state   → atomically replaces the entire state for the tenant
//!
//! This shape mirrors the localStorage blob the frontend used to keep
//! locally, so the WarRoom component doesn't have to be rewritten around
//! per-entity mutations on day one. The relational tables underneath
//! (`future_students`, `future_projects`, `future_squads`, `future_feedback`)
//! are properly normalized, so adding per-entity REST endpoints later
//! is purely additive.
//!
//! The PUT replaces all four entity types in one transaction: any row not
//! present in the payload is deleted. That matches "save the whole world"
//! semantics with last-write-wins, which is correct for the current
//! single-editor-per-tenant usage pattern.

use axum::Json;
use axum::extract::State;
use serde::{Deserialize, Serialize};
use uuid::Uuid;

use crate::error::{AppError, AppResult};
use crate::middleware::AuthContext;
use crate::state::AppState;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Student {
    pub id: String,
    pub name: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub alias: Option<String>,
    pub initial: String,
    pub background: String,
    pub school: String,
    pub major: String,
    pub grade: String,
    #[serde(default)]
    pub skills: serde_json::Value,
    #[serde(default)]
    pub availability: String,
    pub status: String,
    #[serde(default)]
    pub intro: String,
    pub joined_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Project {
    pub id: String,
    pub name: String,
    #[serde(default)]
    pub codename: String,
    pub source: String,
    pub difficulty: i16,
    #[serde(default)]
    pub skill_needs: serde_json::Value,
    pub team_size: i16,
    pub status: String,
    #[serde(default)]
    pub brief: String,
    #[serde(default)]
    pub next_milestone: String,
    pub started_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Squad {
    pub student_id: String,
    pub project_id: String,
    pub role: String,
    pub joined_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Feedback {
    pub id: String,
    pub student_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub project_id: Option<String>,
    pub date: String,
    pub signal: String,
    #[serde(default)]
    pub notes: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct WarRoomData {
    #[serde(default)]
    pub students: Vec<Student>,
    #[serde(default)]
    pub projects: Vec<Project>,
    #[serde(default)]
    pub squads: Vec<Squad>,
    #[serde(default)]
    pub feedback: Vec<Feedback>,
}

/// Resolves the active tenant for this caller. The future API is a pure
/// tenant-scoped resource — no tenant means "no workspace selected", which
/// is a 400 (the dashboard's tenant-switcher should run before any future
/// request hits us).
fn require_tenant(auth: &AuthContext) -> AppResult<Uuid> {
    auth.session.tenant_id.ok_or_else(|| {
        AppError::bad_request("no active tenant; pick one via /v1/auth/switch-tenant")
    })
}

pub async fn get_state(
    State(state): State<AppState>,
    auth: AuthContext,
) -> AppResult<Json<WarRoomData>> {
    let tenant_id = require_tenant(&auth)?;

    let students = sqlx::query_as::<_, StudentRow>(
        r#"
        SELECT id, name, alias, initial, background, school, major, grade,
               skills, availability, status, intro, joined_at
        FROM future_students
        WHERE tenant_id = $1
        ORDER BY joined_at DESC, id
        "#,
    )
    .bind(tenant_id)
    .fetch_all(&state.db)
    .await?;

    let projects = sqlx::query_as::<_, ProjectRow>(
        r#"
        SELECT id, name, codename, source, difficulty, skill_needs,
               team_size, status, brief, next_milestone, started_at
        FROM future_projects
        WHERE tenant_id = $1
        ORDER BY started_at, id
        "#,
    )
    .bind(tenant_id)
    .fetch_all(&state.db)
    .await?;

    let squads = sqlx::query_as::<_, SquadRow>(
        r#"
        SELECT student_id, project_id, role, joined_at
        FROM future_squads
        WHERE tenant_id = $1
        ORDER BY created_at
        "#,
    )
    .bind(tenant_id)
    .fetch_all(&state.db)
    .await?;

    let feedback = sqlx::query_as::<_, FeedbackRow>(
        r#"
        SELECT id, student_id, project_id, date, signal, notes
        FROM future_feedback
        WHERE tenant_id = $1
        ORDER BY date DESC, id
        "#,
    )
    .bind(tenant_id)
    .fetch_all(&state.db)
    .await?;

    Ok(Json(WarRoomData {
        students: students.into_iter().map(Student::from).collect(),
        projects: projects.into_iter().map(Project::from).collect(),
        squads: squads.into_iter().map(Squad::from).collect(),
        feedback: feedback.into_iter().map(Feedback::from).collect(),
    }))
}

pub async fn put_state(
    State(state): State<AppState>,
    auth: AuthContext,
    Json(body): Json<WarRoomData>,
) -> AppResult<Json<WarRoomData>> {
    let tenant_id = require_tenant(&auth)?;

    validate_payload(&body)?;

    let mut tx = state.db.begin().await?;

    // Order matters: feedback and squads have FKs into students/projects,
    // so wipe the dependents first. With ON DELETE CASCADE we could also
    // get away with just deleting students/projects, but explicit deletes
    // make the intent (and any future trigger work) obvious.
    sqlx::query("DELETE FROM future_feedback WHERE tenant_id = $1")
        .bind(tenant_id)
        .execute(&mut *tx)
        .await?;
    sqlx::query("DELETE FROM future_squads WHERE tenant_id = $1")
        .bind(tenant_id)
        .execute(&mut *tx)
        .await?;
    sqlx::query("DELETE FROM future_projects WHERE tenant_id = $1")
        .bind(tenant_id)
        .execute(&mut *tx)
        .await?;
    sqlx::query("DELETE FROM future_students WHERE tenant_id = $1")
        .bind(tenant_id)
        .execute(&mut *tx)
        .await?;

    for s in &body.students {
        sqlx::query(
            r#"
            INSERT INTO future_students
                (tenant_id, id, name, alias, initial, background, school, major,
                 grade, skills, availability, status, intro, joined_at)
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8,
                    $9, $10, $11, $12, $13, $14)
            "#,
        )
        .bind(tenant_id)
        .bind(&s.id)
        .bind(&s.name)
        .bind(&s.alias)
        .bind(&s.initial)
        .bind(&s.background)
        .bind(&s.school)
        .bind(&s.major)
        .bind(&s.grade)
        .bind(&s.skills)
        .bind(&s.availability)
        .bind(&s.status)
        .bind(&s.intro)
        .bind(&s.joined_at)
        .execute(&mut *tx)
        .await?;
    }

    for p in &body.projects {
        sqlx::query(
            r#"
            INSERT INTO future_projects
                (tenant_id, id, name, codename, source, difficulty, skill_needs,
                 team_size, status, brief, next_milestone, started_at)
            VALUES ($1, $2, $3, $4, $5, $6, $7,
                    $8, $9, $10, $11, $12)
            "#,
        )
        .bind(tenant_id)
        .bind(&p.id)
        .bind(&p.name)
        .bind(&p.codename)
        .bind(&p.source)
        .bind(p.difficulty)
        .bind(&p.skill_needs)
        .bind(p.team_size)
        .bind(&p.status)
        .bind(&p.brief)
        .bind(&p.next_milestone)
        .bind(&p.started_at)
        .execute(&mut *tx)
        .await?;
    }

    for sq in &body.squads {
        sqlx::query(
            r#"
            INSERT INTO future_squads (tenant_id, student_id, project_id, role, joined_at)
            VALUES ($1, $2, $3, $4, $5)
            ON CONFLICT (tenant_id, student_id, project_id) DO UPDATE
                SET role = EXCLUDED.role,
                    joined_at = EXCLUDED.joined_at
            "#,
        )
        .bind(tenant_id)
        .bind(&sq.student_id)
        .bind(&sq.project_id)
        .bind(&sq.role)
        .bind(&sq.joined_at)
        .execute(&mut *tx)
        .await?;
    }

    for f in &body.feedback {
        sqlx::query(
            r#"
            INSERT INTO future_feedback
                (tenant_id, id, student_id, project_id, date, signal, notes)
            VALUES ($1, $2, $3, $4, $5, $6, $7)
            "#,
        )
        .bind(tenant_id)
        .bind(&f.id)
        .bind(&f.student_id)
        .bind(&f.project_id)
        .bind(&f.date)
        .bind(&f.signal)
        .bind(&f.notes)
        .execute(&mut *tx)
        .await?;
    }

    tx.commit().await?;

    // Re-read so the response reflects whatever the DB normalized
    // (defaults, server-generated timestamps if we add them later, etc.)
    get_state(State(state), auth).await
}

/// Cross-row checks that aren't expressible as single-column CHECK
/// constraints in the schema. Keeps the DB free of orphan refs and
/// over-full squads even when a buggy client tries to write garbage.
fn validate_payload(d: &WarRoomData) -> AppResult<()> {
    use std::collections::{HashMap, HashSet};

    let mut student_ids: HashSet<&str> = HashSet::with_capacity(d.students.len());
    for s in &d.students {
        if !student_ids.insert(s.id.as_str()) {
            return Err(AppError::bad_request(format!(
                "duplicate student id: {}",
                s.id
            )));
        }
    }

    let mut project_ids: HashSet<&str> = HashSet::with_capacity(d.projects.len());
    let mut team_sizes: HashMap<&str, i16> = HashMap::with_capacity(d.projects.len());
    for p in &d.projects {
        if !project_ids.insert(p.id.as_str()) {
            return Err(AppError::bad_request(format!(
                "duplicate project id: {}",
                p.id
            )));
        }
        team_sizes.insert(p.id.as_str(), p.team_size);
    }

    let mut squad_counts: HashMap<&str, i16> = HashMap::with_capacity(d.projects.len());
    let mut squad_keys: HashSet<(&str, &str)> = HashSet::with_capacity(d.squads.len());
    for sq in &d.squads {
        if !student_ids.contains(sq.student_id.as_str()) {
            return Err(AppError::bad_request(format!(
                "squad references unknown student: {}",
                sq.student_id
            )));
        }
        if !project_ids.contains(sq.project_id.as_str()) {
            return Err(AppError::bad_request(format!(
                "squad references unknown project: {}",
                sq.project_id
            )));
        }
        let key = (sq.student_id.as_str(), sq.project_id.as_str());
        if !squad_keys.insert(key) {
            return Err(AppError::bad_request(format!(
                "duplicate squad: student {} on project {}",
                sq.student_id, sq.project_id
            )));
        }
        let count = squad_counts.entry(sq.project_id.as_str()).or_insert(0);
        *count += 1;
        if let Some(cap) = team_sizes.get(sq.project_id.as_str())
            && *count > *cap
        {
            return Err(AppError::bad_request(format!(
                "project {} is over team size ({} > {})",
                sq.project_id, count, cap
            )));
        }
    }

    let mut feedback_ids: HashSet<&str> = HashSet::with_capacity(d.feedback.len());
    for f in &d.feedback {
        if !feedback_ids.insert(f.id.as_str()) {
            return Err(AppError::bad_request(format!(
                "duplicate feedback id: {}",
                f.id
            )));
        }
        if !student_ids.contains(f.student_id.as_str()) {
            return Err(AppError::bad_request(format!(
                "feedback references unknown student: {}",
                f.student_id
            )));
        }
        if let Some(pid) = &f.project_id
            && !project_ids.contains(pid.as_str())
        {
            return Err(AppError::bad_request(format!(
                "feedback references unknown project: {pid}"
            )));
        }
    }

    Ok(())
}

// Row types for sqlx::FromRow. Kept private to this module; the public
// API types above use camelCase serde so the frontend can stay camelCase.

#[derive(sqlx::FromRow)]
struct StudentRow {
    id: String,
    name: String,
    alias: Option<String>,
    initial: String,
    background: String,
    school: String,
    major: String,
    grade: String,
    skills: serde_json::Value,
    availability: String,
    status: String,
    intro: String,
    joined_at: String,
}

impl From<StudentRow> for Student {
    fn from(r: StudentRow) -> Self {
        Self {
            id: r.id,
            name: r.name,
            alias: r.alias,
            initial: r.initial,
            background: r.background,
            school: r.school,
            major: r.major,
            grade: r.grade,
            skills: r.skills,
            availability: r.availability,
            status: r.status,
            intro: r.intro,
            joined_at: r.joined_at,
        }
    }
}

#[derive(sqlx::FromRow)]
struct ProjectRow {
    id: String,
    name: String,
    codename: String,
    source: String,
    difficulty: i16,
    skill_needs: serde_json::Value,
    team_size: i16,
    status: String,
    brief: String,
    next_milestone: String,
    started_at: String,
}

impl From<ProjectRow> for Project {
    fn from(r: ProjectRow) -> Self {
        Self {
            id: r.id,
            name: r.name,
            codename: r.codename,
            source: r.source,
            difficulty: r.difficulty,
            skill_needs: r.skill_needs,
            team_size: r.team_size,
            status: r.status,
            brief: r.brief,
            next_milestone: r.next_milestone,
            started_at: r.started_at,
        }
    }
}

#[derive(sqlx::FromRow)]
struct SquadRow {
    student_id: String,
    project_id: String,
    role: String,
    joined_at: String,
}

impl From<SquadRow> for Squad {
    fn from(r: SquadRow) -> Self {
        Self {
            student_id: r.student_id,
            project_id: r.project_id,
            role: r.role,
            joined_at: r.joined_at,
        }
    }
}

#[derive(sqlx::FromRow)]
struct FeedbackRow {
    id: String,
    student_id: String,
    project_id: Option<String>,
    date: String,
    signal: String,
    notes: String,
}

impl From<FeedbackRow> for Feedback {
    fn from(r: FeedbackRow) -> Self {
        Self {
            id: r.id,
            student_id: r.student_id,
            project_id: r.project_id,
            date: r.date,
            signal: r.signal,
            notes: r.notes,
        }
    }
}
