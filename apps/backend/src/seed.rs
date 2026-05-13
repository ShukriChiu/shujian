use anyhow::Result;
use sqlx::PgPool;
use uuid::Uuid;

use crate::config::Config;
use crate::handlers::auth::create_user;

/// Idempotent bootstrap: ensures the seed tenant + admin exist.
///
/// Re-running is safe — existing rows are not touched. The only mutation
/// is when no tenant matching `seed_tenant_slug` exists yet — we create
/// the tenant, the admin user, and link them as `owner`.
///
/// The admin's password is **only** set on first creation. Re-running
/// with a different `SEED_ADMIN_PASSWORD` env will not rotate the
/// password. Use `/v1/auth/...` endpoints (or a future password-reset
/// flow) to change credentials in place.
pub async fn ensure_seed(db: &PgPool, cfg: &Config) -> Result<()> {
    let existing: Option<Uuid> = sqlx::query_scalar("SELECT id FROM tenants WHERE slug = $1")
        .bind(&cfg.seed_tenant_slug)
        .fetch_optional(db)
        .await?;

    if existing.is_some() {
        tracing::info!(
            slug = %cfg.seed_tenant_slug,
            "seed tenant already present, skipping bootstrap"
        );
        return Ok(());
    }

    tracing::warn!(
        slug = %cfg.seed_tenant_slug,
        admin = %cfg.seed_admin_identifier,
        "seeding tenant + admin (first boot)"
    );

    // Reuse the admin if it happens to exist (e.g. someone imported users
    // before the first tenant existed). Otherwise create fresh.
    let existing_admin: Option<Uuid> =
        sqlx::query_scalar("SELECT id FROM users WHERE identifier = $1")
            .bind(cfg.seed_admin_identifier.to_lowercase())
            .fetch_optional(db)
            .await?;

    let admin_id = match existing_admin {
        Some(id) => {
            tracing::info!(user_id = %id, "seed admin already exists, linking only");
            id
        }
        None => {
            let user = create_user(
                db,
                &cfg.seed_admin_identifier,
                &cfg.seed_admin_password,
                Some("管理员"),
                true,
            )
            .await
            .map_err(|e| anyhow::anyhow!(e.to_string()))?;
            user.id
        }
    };

    let mut tx = db.begin().await?;

    let tenant_id = Uuid::now_v7();
    sqlx::query(
        r#"
        INSERT INTO tenants (id, slug, name, display_name)
        VALUES ($1, $2, $3, $4)
        "#,
    )
    .bind(tenant_id)
    .bind(&cfg.seed_tenant_slug)
    .bind(&cfg.seed_tenant_name)
    .bind(Some(cfg.seed_tenant_display_name.as_str()))
    .execute(&mut *tx)
    .await?;

    sqlx::query(
        r#"
        INSERT INTO memberships (tenant_id, user_id, role)
        VALUES ($1, $2, 'owner')
        ON CONFLICT (tenant_id, user_id) DO NOTHING
        "#,
    )
    .bind(tenant_id)
    .bind(admin_id)
    .execute(&mut *tx)
    .await?;

    tx.commit().await?;

    tracing::warn!(
        tenant = %cfg.seed_tenant_display_name,
        slug = %cfg.seed_tenant_slug,
        admin = %cfg.seed_admin_identifier,
        "seed bootstrap complete — change the default password ASAP"
    );
    Ok(())
}
