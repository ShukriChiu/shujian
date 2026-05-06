use crate::types::agent::*;
use crate::types::permission::PermissionMode;

pub fn explorer_agent() -> AgentDefinition {
    AgentDefinition {
        agent_type: "explorer".into(),
        display_name: "探索者".into(),
        description: "快速探索数据和代码，回答问题。只读，不修改任何东西。".into(),
        source: AgentSource::BuiltIn,
        model: None,
        model_category: Some("fast".into()),
        tools: Some(vec![
            "read_file".into(),
            "list_files".into(),
            "query_supabase".into(),
            "http_fetch".into(),
        ]),
        disallowed_tools: None,
        skills: None,
        permission_mode: PermissionMode::Plan,
        max_turns: Some(10),
        max_budget_usd: Some(0.10),
        effort: EffortLevel::Low,
        memory_scope: MemoryScope::None,
        background: false,
        isolation: IsolationMode::None,
        color: Some(AgentColor::Cyan),
        domain: None,
        department: None,
        role_level: RoleLevel::Operator,
        workspace_path: None,
        hooks: None,
        system_prompt_fn: None,
    }
}

pub fn worker_agent() -> AgentDefinition {
    AgentDefinition {
        agent_type: "worker".into(),
        display_name: "执行者".into(),
        description: "执行具体操作任务，Coordinator 的主力。拥有全部工具权限。".into(),
        source: AgentSource::BuiltIn,
        model: None,
        model_category: Some("reasoning".into()),
        tools: None,
        disallowed_tools: Some(vec!["spawn_worker".into()]),
        skills: None,
        permission_mode: PermissionMode::Default,
        max_turns: Some(30),
        max_budget_usd: Some(1.00),
        effort: EffortLevel::High,
        memory_scope: MemoryScope::Local,
        background: false,
        isolation: IsolationMode::None,
        color: Some(AgentColor::Blue),
        domain: None,
        department: None,
        role_level: RoleLevel::Operator,
        workspace_path: None,
        hooks: None,
        system_prompt_fn: None,
    }
}

pub fn planner_agent() -> AgentDefinition {
    AgentDefinition {
        agent_type: "planner".into(),
        display_name: "规划者".into(),
        description: "分析复杂问题，制定行动计划。只出方案不动手。".into(),
        source: AgentSource::BuiltIn,
        model: None,
        model_category: Some("reasoning".into()),
        tools: Some(vec![
            "read_file".into(),
            "query_supabase".into(),
            "http_fetch".into(),
        ]),
        disallowed_tools: None,
        skills: None,
        permission_mode: PermissionMode::Plan,
        max_turns: Some(15),
        max_budget_usd: Some(0.50),
        effort: EffortLevel::High,
        memory_scope: MemoryScope::Project,
        background: false,
        isolation: IsolationMode::None,
        color: Some(AgentColor::Violet),
        domain: None,
        department: None,
        role_level: RoleLevel::Analyst,
        workspace_path: None,
        hooks: None,
        system_prompt_fn: None,
    }
}

pub fn verifier_agent() -> AgentDefinition {
    AgentDefinition {
        agent_type: "verifier".into(),
        display_name: "验证者".into(),
        description: "独立验证其他 Agent 的工作成果，提供新鲜视角。".into(),
        source: AgentSource::BuiltIn,
        model: None,
        model_category: Some("reasoning".into()),
        tools: Some(vec![
            "read_file".into(),
            "list_files".into(),
            "shell_exec".into(),
            "query_supabase".into(),
        ]),
        disallowed_tools: None,
        skills: None,
        permission_mode: PermissionMode::Plan,
        max_turns: Some(10),
        max_budget_usd: Some(0.30),
        effort: EffortLevel::Medium,
        memory_scope: MemoryScope::None,
        background: false,
        isolation: IsolationMode::None,
        color: Some(AgentColor::Green),
        domain: None,
        department: None,
        role_level: RoleLevel::Analyst,
        workspace_path: None,
        hooks: None,
        system_prompt_fn: None,
    }
}

pub fn dream_agent() -> AgentDefinition {
    AgentDefinition {
        agent_type: "dream".into(),
        display_name: "记忆整合者".into(),
        description: "后台整合会话记忆，提炼经验教训。".into(),
        source: AgentSource::BuiltIn,
        model: None,
        model_category: Some("fast".into()),
        tools: Some(vec!["read_file".into(), "write_file".into()]),
        disallowed_tools: None,
        skills: None,
        permission_mode: PermissionMode::AcceptEdits,
        max_turns: Some(5),
        max_budget_usd: Some(0.20),
        effort: EffortLevel::Medium,
        memory_scope: MemoryScope::Project,
        background: true,
        isolation: IsolationMode::None,
        color: Some(AgentColor::Purple),
        domain: None,
        department: None,
        role_level: RoleLevel::Operator,
        workspace_path: None,
        hooks: None,
        system_prompt_fn: None,
    }
}

pub fn get_built_in_agents() -> Vec<AgentDefinition> {
    vec![
        explorer_agent(),
        worker_agent(),
        planner_agent(),
        verifier_agent(),
        dream_agent(),
    ]
}
