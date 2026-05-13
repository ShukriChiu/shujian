use crate::config::{DisciplineConfig, TriggerConfig};
use crate::llm::ToolDefinition;
use crate::workspace::WorkspaceManager;

#[derive(Debug, Clone)]
pub struct AgentMode {
    pub name: String,
    pub description: String,
}

impl AgentMode {
    pub fn build() -> Self {
        Self {
            name: "build".into(),
            description: "完整工具访问，可执行所有操作".into(),
        }
    }

    pub fn plan() -> Self {
        Self {
            name: "plan".into(),
            description: "只读模式，只能查询和分析，不能修改文件或执行命令".into(),
        }
    }

    pub fn explore() -> Self {
        Self {
            name: "explore".into(),
            description: "探索模式，只能读取文件和查询数据".into(),
        }
    }
}

pub fn build_system_prompt(
    agent_name: &str,
    workspace: &WorkspaceManager,
    triggers: &[&TriggerConfig],
    tools: &[ToolDefinition],
    mode: Option<&AgentMode>,
    discipline: &DisciplineConfig,
) -> String {
    let now = chrono::Local::now()
        .format("%Y-%m-%d %H:%M:%S %Z")
        .to_string();
    let os = std::env::consts::OS;
    let arch = std::env::consts::ARCH;

    let mut prompt = format!(
        "你是 {agent_name}，友联商业帝国的数字员工。\n\
         当前时间：{now}\n\
         运行环境：{os}/{arch}\n\
         工作空间：{workspace_path}\n\n",
        workspace_path = workspace.root().display()
    );

    if let Some(m) = mode {
        prompt.push_str(&format!("## 当前模式：{}\n{}\n\n", m.name, m.description));
    }

    if let Some(soul) = workspace.read_soul() {
        prompt.push_str(&format!("## 人格\n{}\n\n", soul));
    }

    if let Some(memory) = workspace.read_memory() {
        prompt.push_str(&format!("## 记忆\n{}\n\n", memory));
    }

    if let Some(wisdom) = workspace.read_wisdom()
        && !wisdom
            .trim()
            .ends_with("(跨任务经验沉淀，由 Agent 自动维护)")
    {
        prompt.push_str(&format!("## 经验\n{}\n\n", wisdom));
    }

    let skills = workspace.list_skills();
    if !skills.is_empty() {
        prompt.push_str("## 技能（需要时用 read_file 加载详情）\n");
        prompt.push_str("| 技能 | 描述 |\n|------|------|\n");
        for (name, desc) in &skills {
            prompt.push_str(&format!("| {} | {} |\n", name, desc));
        }
        prompt.push('\n');
    }

    if let Some(focus) = workspace.read_focus() {
        prompt.push_str(&format!("## 当前关注\n{}\n\n", focus));
    }

    if !triggers.is_empty() {
        prompt.push_str("## 活跃触发器\n");
        for t in triggers {
            let schedule = t.expr.as_deref().unwrap_or("interval");
            prompt.push_str(&format!(
                "- {} ({}: {}) — {}\n",
                t.name, t.trigger_type, schedule, t.reason
            ));
        }
        prompt.push('\n');
    }

    if !tools.is_empty() {
        prompt.push_str("## 可用工具\n");
        for tool in tools {
            prompt.push_str(&format!("- `{}`: {}\n", tool.name, tool.description));
        }
        prompt.push('\n');
    }

    prompt.push_str(WORKSPACE_CONVENTIONS);

    if discipline.enforce_todo {
        prompt.push_str(DISCIPLINE_RULES);
    }

    if discipline.accumulate_wisdom {
        prompt.push_str(WISDOM_RULES);
    }

    prompt
}

pub fn build_trigger_wakeup_prompt(trigger_name: &str, reason: &str) -> String {
    format!(
        "你被触发器唤醒了。\n\
         触发器：{trigger_name}\n\
         原因：{reason}\n\n\
         请根据上述原因执行任务。先用 read_file 检查 focus.md 了解当前工作状态，然后开始工作。\
         完成后更新 focus.md 标记已完成的项目。"
    )
}

pub fn build_continuation_prompt(incomplete_todos: &[String]) -> String {
    let mut prompt = String::from("⚠️ **任务未完成**。focus.md 中仍有未完成的待办事项：\n\n");
    for todo in incomplete_todos {
        prompt.push_str(&format!("{}\n", todo));
    }
    prompt.push_str(
        "\n请继续执行这些待办事项。完成一项就立即用 write_file 更新 focus.md 标记为 [x]。\
         所有待办完成后再给出最终回复。",
    );
    prompt
}

pub fn build_wisdom_prompt() -> String {
    "任务已完成。请回顾本次执行过程，如果有值得记录的经验或发现（如数据规律、异常模式、优化建议），\
     请用 write_file 追加到 memory/wisdom.md。格式：\n\
     ```\n### YYYY-MM-DD 经验标题\n- 发现内容\n```\n\
     如果没有新的经验，直接给出最终回复即可。"
        .into()
}

const WORKSPACE_CONVENTIONS: &str = r#"## 工作空间约定

**文件结构**
- `soul.md` — 你的人格定义（只读）
- `memory/memory.md` — 长期记忆（你可以读写，记录重要发现和经验）
- `memory/wisdom.md` — 跨任务经验沉淀（每次任务完成后总结有价值的发现）
- `focus.md` — 工作记忆和关注项（checklist 格式，你应该主动维护）
- `skills/` — 技能文件（用 read_file 按需加载完整指令）
- `workspace/` — 工作文件存放区（报告、分析结果等）

**Focus 格式**（必须遵守）
```
- [ ] task_id: 待办任务描述
- [/] task_id: 进行中的任务
- [x] task_id: 已完成的任务
```

**工具使用原则**
1. 优先用 `batch` 并行执行多个独立操作（如同时读取多个文件）
2. 大输出会被自动截断并保存到文件，用 `read_file` 查看完整内容
3. 不要重复调用相同工具和参数，连续 3 次相同调用会被自动阻止
4. `query_supabase` 只支持 SELECT/WITH 查询
5. 完成任务后更新 `focus.md` 和 `memory/memory.md`
"#;

const DISCIPLINE_RULES: &str = r#"
## 纪律规则（DISCIPLINE — 你必须遵守）

**不完成不放手。** 这是你的核心原则。

1. 每次接到任务，先在 focus.md 里拆分为具体的待办事项（`- [ ]` 格式）
2. 逐项执行，完成一项立即标记为 `- [x]`
3. 如果某项遇到阻碍，标记为 `- [/]` 并记录原因，然后继续下一项
4. **所有待办必须处理完才能结束**——不要在还有 `- [ ]` 或 `- [/]` 时停止
5. 如果系统提示"任务未完成"，立即继续执行剩余项目
6. 每轮工具调用都要推进至少一个待办事项的进度
"#;

const WISDOM_RULES: &str = r#"
## 经验积累

每次任务完成后，如果有值得记录的发现（数据异常、效率技巧、业务规律），
追加到 `memory/wisdom.md`。格式：`### YYYY-MM-DD 标题` + 要点列表。
这些经验会在未来任务中自动加载，帮助你做得更好。
"#;
