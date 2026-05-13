use anyhow::Result;
use std::sync::Arc;
use tokio::sync::{Mutex, Semaphore};
use tower_http::cors::{Any, CorsLayer};
use tracing::info;

use crate::agent::orchestrator::{Orchestrator, OrchestratorConfig};
use crate::audit::logger::AuditLogger;
use crate::audit::profile::ProfileStore;
use crate::compaction::engine::CompactionEngine;
use crate::compaction::types::ContextBudget;
use crate::config::AppConfig;
use crate::cost::budget::BudgetEnforcer;
use crate::cost::report::CostReporter;
use crate::cost::types::{BudgetConfig, GlobalBudget};
use crate::hitl::manager::HitlManager;
use crate::hitl::types::HitlConfig;
use crate::hooks::registry::HookRegistry;
use crate::mcp::manager::McpManager;
use crate::permissions::engine::PermissionEngine;
use crate::permissions::types::PermissionConfig;
use crate::server::api::{self, AppState, DaemonStatus};
use crate::server::unified::{self, UnifiedState};
use crate::skills::loader::SkillLoader;
use crate::skills::resolver::SkillResolver;
use crate::streaming::sse::SseBroadcaster;
use crate::tools::ToolContext;
use crate::types::state::AppStateStore;

pub async fn run_daemon(config: &AppConfig) -> Result<()> {
    let tool_ctx = Arc::new(ToolContext {
        workspace_root: config.workspace_path(),
        supabase_url: config.supabase_url().ok(),
        supabase_key: config.supabase_key().ok(),
        union_agent_url: config.union_agent.base_url.clone(),
    });

    let state = AppState {
        config: Arc::new(config.clone()),
        tool_ctx: tool_ctx.clone(),
        status: Arc::new(Mutex::new(DaemonStatus::default())),
        semaphore: Arc::new(Semaphore::new(config.server.max_concurrent_tasks)),
        start_time: std::time::Instant::now(),
    };

    let app_store = AppStateStore::new();

    let skill_loader = SkillLoader::new(&config.workspace_path());
    let discovered_skills = skill_loader.discover_all();
    let skill_count = discovered_skills.len();
    let skill_resolver = Arc::new(SkillResolver::new(discovered_skills));

    let hook_registry = Arc::new(HookRegistry::new());

    let audit_logger = Arc::new(AuditLogger::new(&config.workspace_path()));
    let profile_store = Arc::new(ProfileStore::new());

    let mcp_manager = Arc::new(McpManager::new());
    if let Err(e) = mcp_manager
        .load_from_project(&config.workspace_path())
        .await
    {
        tracing::warn!("MCP project config load failed: {}", e);
    }

    let compaction_engine = Arc::new(CompactionEngine::new(
        &config.workspace_path(),
        ContextBudget::default(),
    ));

    let permission_engine = Arc::new(PermissionEngine::new(PermissionConfig::default()));

    let broadcaster = Arc::new(SseBroadcaster::new(1024));
    crate::streaming::sse::spawn_heartbeat(broadcaster.clone(), std::time::Duration::from_secs(30));

    let budget_enforcer = Arc::new(BudgetEnforcer::new(
        BudgetConfig::default(),
        GlobalBudget::default(),
    ));
    let cost_reporter = Arc::new(CostReporter::new(&config.workspace_path()));

    let hitl_manager = Arc::new(HitlManager::new(HitlConfig::default(), broadcaster.clone()));

    let orchestrator = Arc::new(Orchestrator::new(
        OrchestratorConfig::default(),
        broadcaster.clone(),
    ));

    let unified_state = UnifiedState {
        store: app_store.clone(),
        mcp: mcp_manager.clone(),
        skills: skill_resolver,
        hooks: hook_registry,
        audit: audit_logger,
        profiles: profile_store,
        compaction: compaction_engine,
        permissions: permission_engine,
        broadcaster: broadcaster.clone(),
        budget: budget_enforcer,
        cost_reporter,
        hitl: hitl_manager,
        orchestrator,
    };

    let bind = config.server.bind.clone();

    let legacy_router = api::create_router(state.clone());
    let v2_router = unified::unified_router(unified_state);
    let cors = CorsLayer::new()
        .allow_origin(Any)
        .allow_methods(Any)
        .allow_headers(Any);
    let combined_router = legacy_router.merge(v2_router).layer(cors);

    let trigger_config = config.clone();
    let trigger_ctx = tool_ctx.clone();
    let trigger_state = state.clone();

    let trigger_handle = tokio::spawn(async move {
        run_all_triggers(&trigger_config, &trigger_ctx, &trigger_state).await;
    });

    info!("shujian-agent daemon 启动");
    info!("   HTTP: http://{}", bind);
    info!("   API v1: /api/health, /api/task, /api/task/sync");
    info!("   API v2: /api/v2/status, /api/v2/agents, /api/v2/tasks, ...");
    info!(
        "   Agents: {}",
        config
            .agents
            .iter()
            .map(|a| a.name.as_str())
            .collect::<Vec<_>>()
            .join(", ")
    );
    info!("   Skills: {} loaded", skill_count);
    info!("   触发器: {} 个", config.triggers.len());
    info!("   最大并发: {}", config.server.max_concurrent_tasks);

    let listener = tokio::net::TcpListener::bind(&bind).await?;
    let server_handle = tokio::spawn(async move {
        axum::serve(listener, combined_router).await.unwrap();
    });

    tokio::select! {
        _ = trigger_handle => {}
        r = server_handle => {
            if let Err(e) = r {
                tracing::error!("HTTP 服务退出: {}", e);
            }
        }
    }

    mcp_manager.shutdown_all().await?;

    Ok(())
}

async fn run_all_triggers(config: &AppConfig, tool_ctx: &ToolContext, state: &AppState) {
    use crate::llm;
    use crate::runtime::context::{build_system_prompt, build_trigger_wakeup_prompt};
    use crate::runtime::engine::AgentEngine;
    use crate::tools::ToolRegistry;
    use crate::workspace::WorkspaceManager;
    use chrono::Local;
    use cron::Schedule;
    use std::str::FromStr;
    use std::time::Duration;
    use tracing::{error, warn};

    if config.triggers.is_empty() {
        info!("无触发器配置，守护进程空转");
        loop {
            tokio::time::sleep(Duration::from_secs(60)).await;
        }
    }

    let mut last_fired: Vec<Option<chrono::DateTime<Local>>> = vec![None; config.triggers.len()];

    info!("触发器守护进程启动，{} 个触发器", config.triggers.len());

    loop {
        let now = Local::now();

        for (i, trigger) in config.triggers.iter().enumerate() {
            let should_fire = match trigger.trigger_type.as_str() {
                "cron" => {
                    if let Some(expr) = &trigger.expr {
                        let expr_with_secs = if expr.split_whitespace().count() == 5 {
                            format!("0 {}", expr)
                        } else {
                            expr.clone()
                        };
                        match Schedule::from_str(&expr_with_secs) {
                            Ok(schedule) => {
                                let upcoming = schedule.upcoming(chrono::Utc).take(1).next();
                                if let Some(next) = upcoming {
                                    let next_local = next.with_timezone(&Local);
                                    let diff = (next_local - now).num_seconds().abs();
                                    diff < 15
                                        && last_fired[i]
                                            .map(|lf| (now - lf).num_seconds() > 60)
                                            .unwrap_or(true)
                                } else {
                                    false
                                }
                            }
                            Err(e) => {
                                error!("无效 cron 表达式 '{}': {}", expr, e);
                                false
                            }
                        }
                    } else {
                        false
                    }
                }
                "interval" => {
                    if let Some(minutes) = trigger.minutes {
                        last_fired[i]
                            .map(|lf| (now - lf).num_minutes() >= minutes as i64)
                            .unwrap_or(true)
                    } else {
                        false
                    }
                }
                _ => false,
            };

            if should_fire {
                info!("触发器触发: {} — {}", trigger.name, trigger.reason);
                last_fired[i] = Some(now);

                let agent_name = trigger.agent.clone().unwrap_or_else(|| {
                    config
                        .default_agent()
                        .map(|a| a.name.clone())
                        .unwrap_or_default()
                });

                let agent_config = match config.get_agent(&agent_name) {
                    Some(a) => a.clone(),
                    None => {
                        warn!("触发器 {} 指向未知 Agent: {}", trigger.name, agent_name);
                        continue;
                    }
                };

                let cfg = config.clone();
                let trigger_name = trigger.name.clone();
                let trigger_reason = trigger.reason.clone();
                let sem = state.semaphore.clone();
                let supa_url = tool_ctx.supabase_url.clone();
                let supa_key = tool_ctx.supabase_key.clone();
                let ua_url = tool_ctx.union_agent_url.clone();

                tokio::spawn(async move {
                    let _permit = sem.acquire().await;

                    let resolved = cfg.resolve_llm(&agent_config);
                    let api_key =
                        match cfg.resolve_api_key(&resolved.api_key_env, &resolved.provider) {
                            Ok(k) => k,
                            Err(e) => {
                                error!("触发器 [{}] API key 获取失败: {}", trigger_name, e);
                                return;
                            }
                        };
                    let llm_config = resolved.to_llm_config();
                    let llm_client = llm::client::create_llm_client(&llm_config, &api_key);

                    let ws = std::sync::Arc::new(WorkspaceManager::new(std::path::PathBuf::from(
                        &agent_config.workspace,
                    )));
                    if let Err(e) = ws.ensure_structure() {
                        error!("触发器 [{}] workspace 初始化失败: {}", trigger_name, e);
                        return;
                    }

                    let mut tools = ToolRegistry::new();
                    if let Some(tool_list) = &agent_config.tools {
                        tools.register_selected(tool_list);
                    } else {
                        tools.register_defaults();
                    }

                    let ctx = ToolContext {
                        workspace_root: std::path::PathBuf::from(&agent_config.workspace),
                        supabase_url: supa_url,
                        supabase_key: supa_key,
                        union_agent_url: ua_url,
                    };

                    let triggers_ref: Vec<&crate::config::TriggerConfig> =
                        cfg.triggers_for_agent(&agent_config.name);
                    let tool_defs = tools.definitions();
                    let system = build_system_prompt(
                        &agent_config.name,
                        &ws,
                        &triggers_ref,
                        &tool_defs,
                        None,
                        &agent_config.discipline,
                    );
                    let user_msg = build_trigger_wakeup_prompt(&trigger_name, &trigger_reason);

                    let mut messages = vec![
                        crate::llm::Message::System { content: system },
                        crate::llm::Message::User { content: user_msg },
                    ];

                    let engine = AgentEngine::new(resolved.max_rounds)
                        .with_discipline(agent_config.discipline.clone())
                        .with_workspace(ws);

                    match engine
                        .run(llm_client.as_ref(), &mut messages, &tools, &ctx, false)
                        .await
                    {
                        Ok(result) => {
                            info!("触发器 [{}] 完成: {} 字节", trigger_name, result.len());
                        }
                        Err(e) => {
                            error!("触发器 [{}] 失败: {}", trigger_name, e);
                        }
                    }
                });
            }
        }

        tokio::time::sleep(Duration::from_secs(15)).await;
    }
}
