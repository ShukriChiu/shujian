use anyhow::{Context, Result};
use std::io::{self, BufRead, Write};
use std::sync::Arc;

use crate::config::AppConfig;
use crate::llm::{self, Message};
use crate::runtime::context::build_system_prompt;
use crate::runtime::engine::AgentEngine;
use crate::tools::{ToolContext, ToolRegistry};
use crate::workspace::WorkspaceManager;

pub async fn run_interactive(config: &AppConfig, agent_name: Option<&str>) -> Result<()> {
    let agent_config = if let Some(name) = agent_name {
        config.get_agent(name)
            .with_context(|| format!("未找到 Agent: {}。可用: {}", name,
                config.agents.iter().map(|a| a.name.as_str()).collect::<Vec<_>>().join(", ")))?
    } else {
        config.default_agent()
            .context("配置中没有定义任何 Agent")?
    };

    let resolved = config.resolve_llm(agent_config);
    let api_key = config.resolve_api_key(&resolved.api_key_env, &resolved.provider)?;
    let llm_config = resolved.to_llm_config();
    let llm = llm::client::create_llm_client(&llm_config, &api_key);

    let workspace = Arc::new(WorkspaceManager::new(
        std::path::PathBuf::from(&agent_config.workspace),
    ));
    workspace.ensure_structure()?;

    let mut tools = ToolRegistry::new();
    if let Some(tool_list) = &agent_config.tools {
        tools.register_selected(tool_list);
    } else {
        tools.register_defaults();
    }

    let tool_ctx = ToolContext {
        workspace_root: std::path::PathBuf::from(&agent_config.workspace),
        supabase_url: config.supabase_url().ok(),
        supabase_key: config.supabase_key().ok(),
        union_agent_url: config.union_agent.base_url.clone(),
    };

    let triggers: Vec<&crate::config::TriggerConfig> =
        config.triggers_for_agent(&agent_config.name);
    let tool_defs = tools.definitions();
    let system = build_system_prompt(
        &agent_config.name,
        &workspace,
        &triggers,
        &tool_defs,
        None,
        &agent_config.discipline,
    );
    let mut messages = vec![Message::System { content: system }];

    let engine = AgentEngine::new(resolved.max_rounds)
        .with_discipline(agent_config.discipline.clone())
        .with_workspace(workspace);

    println!(
        "\n🤖 {} 已就绪（模型类别: {}）。输入消息开始对话，输入 /quit 退出。\n",
        agent_config.name,
        agent_config.model_category.as_deref().unwrap_or("default"),
    );

    let stdin = io::stdin();
    loop {
        print!("你> ");
        io::stdout().flush()?;

        let mut input = String::new();
        stdin.lock().read_line(&mut input)?;
        let input = input.trim();

        if input.is_empty() {
            continue;
        }
        if input == "/quit" || input == "/exit" {
            println!("再见！");
            break;
        }

        messages.push(Message::User {
            content: input.to_string(),
        });

        print!("\n{}> ", agent_config.name);
        io::stdout().flush()?;

        let result = engine
            .run(llm.as_ref(), &mut messages, &tools, &tool_ctx, true)
            .await?;

        if !result.is_empty() {
            println!();
        }
        println!();
    }

    Ok(())
}
