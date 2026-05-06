# Shujian Agent — 企业级 AI 军团运行时架构

> 从 Claude Code 泄露源码中提炼的全部核心设计模式，重新设计为 Rust 原生、企业级、领域无关的 AI Agent 运行时。
> 目标：在 Dashboard 中可视化管理一支虚拟 AI 军团，执行电商/健康管理/供应链等任意业务。

> **Repo 位置**: 本文档描述的是 [`apps/agent`](apps/agent) 这个 Rust daemon 的内部架构。文中提到的 `src/`、`agents/`、`config.toml` 等相对路径，均以 `apps/agent/` 为根。Dashboard 与 Bridge 的实现见 [`apps/dashboard`](apps/dashboard) 和 [`apps/bridge`](apps/bridge)。

---

## 0. 设计哲学

| 原则 | Claude Code 的做法 | 我们的做法 |
|------|-------------------|-----------|
| **运行时** | TypeScript + Bun，单体进程 | **Rust + Tokio**，可嵌入、可独立部署 |
| **UI** | React + Ink 终端 UI | **HTTP API + SSE/WebSocket → Dashboard 前端渲染** |
| **Agent 定义** | Markdown frontmatter + TypeScript 代码 | **TOML/YAML 声明式 + Rust trait 扩展** |
| **状态管理** | React-style immer store | **Arc<RwLock<AppState>>，事件驱动广播** |
| **多 Agent** | Coordinator + Worker 进程内 | **Coordinator + Worker 线程/进程，共享状态** |
| **权限** | 6 种模式 + 分类器 | **5 种模式 + 规则引擎（无 LLM 分类器依赖）** |
| **领域** | 编程任务专用 | **领域无关：通过 Agent 定义注入业务知识** |

---

## 1. 核心类型系统

### 1.1 Task（任务——一切执行的原子单位）

**灵感来源**: Claude Code 的 `Task.ts` 定义了 7 种任务类型 + 5 种状态，每个任务有独立的输出文件、超时、通知机制。

```
TaskType:
  shell       — 执行 shell 命令
  agent       — 启动子 agent（本地）
  remote      — 远程 agent 执行
  workflow    — 多步编排工作流
  dream       — 记忆整合（后台）
  monitor     — 持续监控任务
  scheduled   — 定时触发任务

TaskStatus:
  pending → running → completed | failed | killed | paused

TaskState:
  id:            String (前缀标识类型: b=shell, a=agent, r=remote, w=workflow, d=dream, m=monitor, s=scheduled)
  task_type:     TaskType
  status:        TaskStatus
  description:   String
  agent_id:      Option<AgentId>       // 执行者
  parent_id:     Option<String>        // 父任务 (Coordinator → Worker)
  started_at:    Instant
  ended_at:      Option<Instant>
  output_file:   PathBuf               // 持久化输出
  output_offset: u64                   // 流式读取偏移
  token_usage:   TokenUsage            // 累计 token 消耗
  cost_usd:      f64                   // 累计成本
  notified:      bool                  // 已通知完成
  error:         Option<String>
  metadata:      HashMap<String, Value> // 扩展字段
```

**Task ID 生成**: 类型前缀 + 8 位 base36 随机字符 (如 `a3k7m9x2p1`)。
碰撞概率 ≈ 1/2.8万亿，安全。

### 1.2 Agent Definition（Agent 声明——谁、做什么、怎么做）

**灵感来源**: Claude Code 的 `loadAgentsDir.ts` 支持 built-in/custom/plugin 三种来源，每种 Agent 有独立的 model、tools、permissions、skills、memory scope、isolation mode。

```
AgentDefinition:
  agent_type:    String                 // 唯一标识 (如 "procurement_planner")
  display_name:  String                 // 显示名 (如 "采购计划员")
  description:   String                 // 何时使用
  source:        AgentSource            // BuiltIn | Custom | Plugin { plugin_name }

  // 能力配置
  model:         Option<String>         // 覆盖默认模型 ("inherit" = 继承父级)
  tools:         Option<Vec<String>>    // 允许的工具白名单 (None = 全部)
  disallowed_tools: Option<Vec<String>> // 工具黑名单
  skills:        Option<Vec<String>>    // 预加载的技能

  // 行为配置
  permission_mode: PermissionMode       // 权限模式
  max_turns:     Option<u32>            // 最大轮次
  max_budget_usd: Option<f64>          // 预算上限
  effort:        EffortLevel            // 执行力度 (min/low/medium/high/max)

  // 系统 Prompt
  system_prompt: PromptSource           // Static(String) | File(PathBuf) | Dynamic(fn)

  // 记忆配置
  memory_scope:  MemoryScope            // User | Project | Local | None
  
  // 运行配置
  background:    bool                   // 默认后台执行
  isolation:     IsolationMode          // None | Worktree | Container
  color:         Option<AgentColor>     // UI 显示颜色

  // 钩子
  hooks:         Option<HooksConfig>    // pre_tool / post_tool / session_start / session_end
  
  // 业务域标签（企业化扩展）
  domain:        Option<String>         // "ecommerce" | "healthcare" | "supply_chain" | ...
  department:    Option<String>         // "procurement" | "sales" | "quality" | ...
  role_level:    RoleLevel              // Operator | Analyst | Manager | Director
```

**AgentSource** 三来源：
- **BuiltIn**: 编译进二进制，如 Explorer、Planner、Worker
- **Custom**: 从 `agents/` 目录的 TOML/YAML/Markdown 加载
- **Plugin**: 从插件系统动态加载

### 1.3 Tool（工具——Agent 的手和脚）

**灵感来源**: Claude Code 的 `Tool.ts` 定义了 40+ 方法的 Tool 接口，包含权限检查、并发安全、破坏性标记、进度报告、UI 渲染。

```
Tool trait:
  // 基础
  fn name(&self) -> &str
  fn description(&self) -> &str
  fn parameters_schema(&self) -> JsonSchema
  async fn execute(&self, input: Value, ctx: &ToolContext) -> Result<ToolResult>

  // 权限（默认实现可覆盖）
  fn is_read_only(&self, input: &Value) -> bool          { false }
  fn is_destructive(&self, input: &Value) -> bool         { false }
  fn is_concurrency_safe(&self, input: &Value) -> bool    { false }
  fn is_enabled(&self) -> bool                            { true }
  async fn validate_input(&self, input: &Value, ctx: &ToolContext) -> ValidationResult { Ok(()) }
  async fn check_permissions(&self, input: &Value, ctx: &ToolContext) -> PermissionResult { Allow }

  // 元数据
  fn search_hint(&self) -> Option<&str>                   { None }  // 工具搜索关键词
  fn max_result_size(&self) -> usize                      { 50_000 }
  fn interrupt_behavior(&self) -> InterruptBehavior       { Block }  // Cancel | Block

  // 进度
  fn supports_progress(&self) -> bool                     { false }

ToolResult:
  data:          String                 // 工具输出
  new_messages:  Vec<Message>           // 附加消息
  metadata:      Option<HashMap<String, Value>>

ToolContext (增强版):
  workspace_root:   PathBuf
  agent_id:         AgentId
  task_id:          String
  permission_ctx:   PermissionContext
  state:            Arc<RwLock<AppState>>
  event_tx:         broadcast::Sender<AppEvent>
  supabase_url:     Option<String>
  supabase_key:     Option<String>
  external_apis:    HashMap<String, ApiConfig>   // 可扩展的外部 API 配置
```

### 1.4 Permission（权限——安全的三道锁）

**灵感来源**: Claude Code 有 6 种权限模式 + 多源规则 + LLM 分类器。我们简化为 5 种模式 + 纯规则引擎（无 LLM 依赖，确定性检查）。

```
PermissionMode:
  Default       — 危险操作需审批
  Plan          — 只读，不允许任何写操作
  AcceptEdits   — 自动接受文件编辑，其余需审批
  Auto          — 全部自动通过（需管理员授权开启）
  Supervised    — 所有操作都需人工审批

PermissionBehavior: Allow | Deny | Ask

PermissionRule:
  source:     RuleSource     // UserConfig | ProjectConfig | AgentDef | Session | CLI
  behavior:   PermissionBehavior
  tool_name:  String         // 支持 glob: "shell_*", "*"
  pattern:    Option<String> // 参数匹配: "git *", "rm -rf *"

PermissionResult:
  Allow { updated_input, reason }
  Deny  { message, reason }
  Ask   { message, suggestions }

检查链路:
  1. Agent 定义的 permission_mode
  2. 规则匹配 (last-match-wins)
  3. Tool 自身的 check_permissions
  4. 如果 Ask → 推送到 Dashboard 审批队列 → 人工决策
```

### 1.5 AppState（全局状态——一切的单一真相源）

**灵感来源**: Claude Code 的 `AppStateStore.ts` 是一个巨大的类型，包含 60+ 字段，涵盖任务、Agent 注册、MCP、插件、通知、权限等。

```
AppState:
  // === 核心 ===
  tasks:              HashMap<String, TaskState>
  agent_registry:     HashMap<AgentId, AgentRuntime>
  agent_name_map:     HashMap<String, AgentId>        // name → id 快速查找
  
  // === 配置 ===
  agent_definitions:  Vec<AgentDefinition>
  global_permission:  PermissionContext
  settings:           Settings
  
  // === 通信 ===
  inbox:              HashMap<AgentId, Vec<InboxMessage>>
  notifications:      VecDeque<Notification>
  
  // === 监控 ===
  token_usage_total:  TokenUsage
  cost_total_usd:     f64
  uptime_started:     Instant
  active_task_count:  u32
  completed_count:    u64
  failed_count:       u64
  
  // === Coordinator ===
  coordinator_state:  Option<CoordinatorState>
  scratchpad_dir:     Option<PathBuf>                  // 跨 Worker 共享目录
  
  // === Memory ===
  memory_state:       MemoryState
  last_dream_at:      Option<DateTime<Utc>>
  dream_lock:         bool
  
  // === Dashboard 连接 ===
  connected_clients:  u32                              // WebSocket 客户端数
```

**事件驱动**: 状态变更通过 `broadcast::Sender<AppEvent>` 广播，Dashboard 通过 SSE/WebSocket 订阅。

```
AppEvent:
  TaskCreated(TaskState)
  TaskUpdated { task_id, status, output_delta }
  TaskCompleted { task_id, result }
  AgentSpawned { agent_id, agent_type, task_id }
  AgentMessage { from, to, content }
  PermissionRequest { request_id, agent_id, tool_name, input_summary }
  PermissionResponse { request_id, decision }
  MemoryUpdated { scope, path }
  TokenUsage { agent_id, task_id, usage }
  Notification { level, title, body }
  DreamStarted { task_id }
  DreamCompleted { task_id, files_updated }
```

---

## 2. Coordinator 模式（AI 军团的指挥链）

**灵感来源**: Claude Code 的 `coordinatorMode.ts` 实现了完整的 Coordinator/Worker 模式，包括系统 Prompt、工具限制、消息路由、任务生命周期。

### 2.1 角色分工

```
Coordinator (指挥官):
  职责: 分析任务 → 拆解子任务 → 派发 Worker → 汇总结果 → 与用户沟通
  可用工具: spawn_worker, send_message, stop_task, 查询工具
  不可用: 直接执行 shell、编辑文件（必须委托给 Worker）

Worker (执行者):
  职责: 接收具体任务 → 自主执行 → 报告结果
  可用工具: shell_exec, read_file, write_file, http_fetch, query_supabase, ...
  不可用: spawn_worker（Worker 不能再派生 Worker）
```

### 2.2 通信协议

```
Worker 完成 → 自动生成结果消息:

<agent_result>
  <agent_id>{id}</agent_id>
  <status>completed|failed|killed</status>
  <summary>{人类可读摘要}</summary>
  <result>{Agent 最终输出}</result>
  <usage>
    <input_tokens>N</input_tokens>
    <output_tokens>N</output_tokens>
    <cost_usd>0.xx</cost_usd>
  </usage>
</agent_result>

Coordinator 收到后:
  1. 汇总结果给用户
  2. 决定是否继续该 Worker (SendMessage) 或启动新 Worker
  3. 继续 vs 新建的决策依据：上下文重叠度
```

### 2.3 Scratchpad（共享白板）

跨 Worker 的持久化知识共享目录。所有 Worker 可读写，无需权限审批。

```
{workspace}/.scratchpad/
├── findings.md          # 研究发现
├── implementation.md    # 实现方案
└── ...                  # Worker 自由组织
```

### 2.4 任务工作流范式

```
Phase 1: Research (并行)
  → Worker A: 调查问题 A
  → Worker B: 调查问题 B
  → Worker C: 收集数据 C

Phase 2: Synthesis (Coordinator)
  ← 收到所有研究结果
  → 整合分析，生成实施方案

Phase 3: Implementation (串行或分区并行)
  → Worker D: 按方案实施 (带完整上下文)

Phase 4: Verification (新 Worker)
  → Worker E: 独立验证 (新鲜视角)
```

---

## 3. Memory 系统（记忆——Agent 的大脑）

**灵感来源**: Claude Code 的 `memdir/` 系统 + `autoDream/` 自动记忆整合 + `extractMemories` 后台提取。

### 3.1 三层记忆

```
Layer 1: Working Memory (工作记忆)
  位置: 对话上下文 (messages 数组)
  生命周期: 单次任务
  容量: LLM 上下文窗口
  管理: compact_history 自动压缩

Layer 2: Session Memory (会话记忆)
  位置: {workspace}/memory/
  ├── memory.md       — 结构化知识
  ├── wisdom.md       — 经验教训
  └── logs/YYYY/MM/DD.md  — 每日日志（新增）
  生命周期: 跨任务持久
  管理: Agent 主动写入 + Auto Dream 整合

Layer 3: Shared Memory (共享记忆)
  位置: {global_config}/memory/
  ├── MEMORY.md       — 全局索引
  ├── topics/         — 按主题组织
  └── agents/         — 按 Agent 类型组织
  生命周期: 跨 Agent 持久
  管理: Auto Dream 整合 + 人工审核
```

### 3.2 Auto Dream（自动记忆整合）

**灵感来源**: Claude Code 的 `autoDream.ts` 用三层门控（时间/会话数/锁）控制何时触发。

```
触发条件（三层门控，最便宜的先检查）:
  1. Time Gate:     距上次整合 >= N 小时 (默认 8h)
  2. Session Gate:  自上次整合以来有 >= M 个新会话 (默认 3)
  3. Lock Gate:     无其他 Dream 进程在运行

执行流程:
  1. Fork 一个 Dream 子 Agent (后台，不占用主对话)
  2. Dream Agent 读取近期所有会话日志
  3. 四阶段整合:
     Phase A: Orient   — 读取现有 MEMORY.md，了解已有知识
     Phase B: Gather   — 扫描新日志，提取有价值的信号
     Phase C: Merge    — 合并新旧知识，去重，更新主题文件
     Phase D: Prune    — 清理过时信息，重建索引
  4. 写入更新后的记忆文件
  5. 记录整合时间戳
```

### 3.3 记忆提取（Extract Memories）

每次 Agent 会话结束后，后台提取有价值的信息：

```
触发: 每次 Agent 任务完成时（后台异步）
提取目标:
  - 新发现的业务规则
  - 重要的数据点
  - 成功的操作模式
  - 失败的教训
存储: 追加到 {workspace}/memory/logs/YYYY/MM/DD.md
```

---

## 4. Server API（Dashboard 的接口层）

### 4.1 RESTful API

```
=== 系统 ===
GET  /api/health                     — 健康检查
GET  /api/status                     — 运行状态概览

=== Agent 管理 ===
GET  /api/agents                     — 所有 Agent 定义列表
GET  /api/agents/:type               — 单个 Agent 定义详情
POST /api/agents                     — 创建自定义 Agent 定义
PUT  /api/agents/:type               — 更新 Agent 定义
DELETE /api/agents/:type             — 删除自定义 Agent

=== Task 执行 ===
POST /api/tasks                      — 创建并启动任务
GET  /api/tasks                      — 任务列表（支持筛选/分页）
GET  /api/tasks/:id                  — 任务详情（含输出）
GET  /api/tasks/:id/output           — 任务输出流（SSE）
POST /api/tasks/:id/stop             — 停止任务
POST /api/tasks/:id/resume           — 恢复暂停的任务
POST /api/tasks/sync                 — 同步执行（等待完成）

=== Coordinator ===
POST /api/coordinate                 — 启动 Coordinator 模式任务
GET  /api/coordinate/:id/workers     — 查看 Coordinator 下的所有 Worker

=== 消息 ===
POST /api/messages                   — 向 Agent 发送消息
GET  /api/messages/:agent_id         — Agent 收件箱

=== 权限审批 ===
GET  /api/permissions/pending        — 待审批列表
POST /api/permissions/:id/approve    — 批准
POST /api/permissions/:id/deny       — 拒绝

=== 记忆 ===
GET  /api/memory/:agent_type         — Agent 记忆内容
POST /api/memory/dream               — 手动触发 Dream 整合
GET  /api/memory/shared              — 共享记忆索引

=== 监控 ===
GET  /api/metrics                    — token 用量、成本、任务统计
GET  /api/metrics/agents             — 按 Agent 维度的指标
```

### 4.2 实时推送

```
SSE:  GET /api/events               — 服务端事件流（所有 AppEvent）
WebSocket: /ws                      — 双向通信（Dashboard ↔ Runtime）

事件格式:
{
  "event": "task_updated",
  "data": {
    "task_id": "a3k7m9x2p1",
    "status": "running",
    "description": "分析三诺易巧近30天销售趋势",
    "agent_type": "sales_analyst",
    "output_delta": "正在查询 ods_wdt_sales_outstock...",
    "token_usage": { "input": 2340, "output": 156 },
    "cost_usd": 0.0034
  },
  "timestamp": "2026-03-31T10:23:45Z"
}
```

### 4.3 Dashboard 专用聚合端点

```
GET /api/dashboard/overview
{
  "agents": {
    "total_defined": 12,
    "active": 4,
    "idle": 8,
    "agents": [
      {
        "type": "procurement_planner",
        "display_name": "采购计划员",
        "status": "running",
        "current_task": "生成倍适威下周采购计划",
        "tasks_completed_24h": 7,
        "cost_24h_usd": 0.45,
        "domain": "supply_chain",
        "department": "procurement",
        "color": "#4F46E5"
      }
    ]
  },
  "tasks": {
    "active": 4,
    "completed_24h": 23,
    "failed_24h": 1,
    "total_cost_24h_usd": 2.34
  },
  "permissions": {
    "pending_count": 2
  },
  "memory": {
    "last_dream_at": "2026-03-31T02:00:00Z",
    "total_entries": 156
  }
}
```

---

## 5. Agent 定义规范（企业级扩展）

### 5.1 TOML 声明式 Agent（推荐）

```toml
# agents/procurement_planner/agent.toml

[agent]
type = "procurement_planner"
display_name = "采购计划员"
description = "根据销售趋势、库存水平和供应商情况，生成智能采购建议"
domain = "supply_chain"
department = "procurement"
role_level = "analyst"

[agent.model]
category = "reasoning"      # 引用 model_categories

[agent.capabilities]
tools = ["query_supabase", "http_fetch", "read_file", "write_file"]
disallowed_tools = ["shell_exec"]
skills = ["procurement_analysis", "inventory_optimization"]
max_turns = 20
max_budget_usd = 0.50

[agent.permissions]
mode = "default"             # default | plan | accept_edits | auto | supervised

[agent.memory]
scope = "project"            # user | project | local | none

[agent.behavior]
background = false
isolation = "none"           # none | worktree | container
color = "indigo"
effort = "high"              # min | low | medium | high | max
```

### 5.2 内置 Agent（编译进二进制）

```
Explorer (探索者):
  职责: 快速探索代码库/数据，回答问题
  工具: read_file, query_supabase, http_fetch
  权限: Plan (只读)
  记忆: None
  特点: 轻量、快速、不修改任何东西

Worker (执行者):
  职责: 执行具体的操作任务
  工具: 全部
  权限: Default
  记忆: Local
  特点: Coordinator 的主力执行者

Planner (规划者):
  职责: 分析复杂问题，制定行动计划
  工具: read_file, query_supabase (只读)
  权限: Plan
  记忆: Project
  特点: 只出方案不动手

Verifier (验证者):
  职责: 独立验证其他 Agent 的工作成果
  工具: read_file, shell_exec (只读命令), query_supabase
  权限: Plan
  记忆: None
  特点: 新鲜视角，不带执行者的假设

Dream Agent (记忆整合者):
  职责: 后台整合会话记忆
  工具: read_file, write_file (仅 memory 目录)
  权限: AcceptEdits (仅 memory 目录)
  记忆: Shared
  特点: 自动触发，不干扰主流程
```

### 5.3 Workspace 结构

```
agents/{agent_type}/
├── agent.toml              — Agent 定义（见 5.1）
├── soul.md                 — 人格/领域知识/行为准则
├── focus.md                — 当前任务清单
├── memory/
│   ├── memory.md           — 结构化知识
│   ├── wisdom.md           — 经验教训
│   └── logs/               — 每日日志
│       └── 2026/03/31.md
├── skills/
│   ├── data_analysis.md    — 技能描述
│   └── report_generation.md
├── workspace/              — 工作产出
│   └── archived/
└── .scratchpad/            — Coordinator 共享白板
```

---

## 6. 模块边界（Rust crate 内部模块）

```
shujian-agent/src/
├── main.rs                 — CLI 入口 (clap)
├── config.rs               — 配置加载 (AppConfig, AgentConfig, ...)
│
├── types/                  — 所有核心类型定义
│   ├── mod.rs
│   ├── task.rs             — TaskType, TaskStatus, TaskState, TaskHandle
│   ├── agent.rs            — AgentDefinition, AgentSource, AgentId
│   ├── tool.rs             — ToolResult, ToolContext, ToolProgress
│   ├── message.rs          — Message, InboxMessage, AgentResult
│   ├── permission.rs       — PermissionMode, PermissionRule, PermissionResult
│   ├── event.rs            — AppEvent (所有事件枚举)
│   └── state.rs            — AppState
│
├── agent/                  — Agent 定义加载与管理
│   ├── mod.rs
│   ├── loader.rs           — 从 TOML/目录加载 AgentDefinition
│   ├── built_in.rs         — 内置 Agent (Explorer, Worker, Planner, Verifier, Dream)
│   └── registry.rs         — Agent 注册表
│
├── tools/                  — Tool trait + 实现
│   ├── mod.rs              — Tool trait, ToolRegistry
│   ├── shell.rs
│   ├── file.rs
│   ├── http_fetch.rs
│   ├── supabase.rs
│   ├── batch.rs
│   ├── spawn_worker.rs     — Coordinator 专用: 启动 Worker
│   ├── send_message.rs     — Coordinator 专用: 向 Worker 发消息
│   └── stop_task.rs        — Coordinator 专用: 停止 Worker
│
├── runtime/                — Agent 执行引擎
│   ├── mod.rs
│   ├── engine.rs           — AgentEngine (主循环)
│   ├── coordinator.rs      — Coordinator 模式逻辑
│   ├── context.rs          — 系统 Prompt 构建
│   ├── guard.rs            — LoopDetector, OutputTruncator, ToolNameRepair
│   └── trigger.rs          — Cron/Interval 触发器
│
├── permission/             — 权限系统
│   ├── mod.rs
│   ├── mode.rs             — PermissionMode 配置
│   ├── rules.rs            — PermissionRule 匹配引擎
│   └── checker.rs          — PermissionChecker (串联检查链)
│
├── memory/                 — 记忆系统
│   ├── mod.rs
│   ├── workspace.rs        — WorkspaceManager (增强)
│   ├── auto_dream.rs       — Auto Dream 三层门控 + 执行
│   ├── extract.rs          — 会话结束后自动提取
│   └── consolidation.rs    — 记忆整合 Prompt
│
├── state/                  — 全局状态管理
│   ├── mod.rs
│   ├── store.rs            — AppStateStore (Arc<RwLock> + broadcast)
│   └── events.rs           — 事件处理与广播
│
├── server/                 — HTTP API
│   ├── mod.rs
│   ├── api.rs              — Axum 路由注册
│   ├── handlers/           — 按模块分的 handler
│   │   ├── tasks.rs
│   │   ├── agents.rs
│   │   ├── coordinator.rs
│   │   ├── permissions.rs
│   │   ├── memory.rs
│   │   ├── messages.rs
│   │   ├── metrics.rs
│   │   └── dashboard.rs    — Dashboard 专用聚合端点
│   ├── sse.rs              — SSE 事件推送
│   └── ws.rs               — WebSocket 双向通信
│
├── llm/                    — LLM 客户端 (保留现有)
│   ├── mod.rs
│   ├── types.rs
│   ├── client.rs
│   ├── openai.rs
│   └── anthropic.rs
│
├── cli/                    — CLI 命令
│   ├── mod.rs
│   ├── agent.rs            — 交互式 Agent REPL
│   ├── daemon.rs           — 后台守护进程
│   ├── status.rs           — 运行状态查询
│   └── list.rs             — 列出 Agents/Tasks
│
└── inbox/                  — Agent 间消息
    ├── mod.rs
    └── router.rs           — 消息路由 (name → AgentId → inbox)
```

---

## 7. Dashboard 集成设计

### 7.1 前端页面规划 (union-dashboard)

```
/army                      — AI 军团总览
├── Agent 卡片网格 (每个 Agent 一张卡片，实时状态)
├── 全局指标 (活跃/空闲/总任务/总成本)
└── 权限审批通知

/army/tasks                — 任务中心
├── 任务列表 (筛选: 状态/Agent/时间)
├── 任务详情 (实时输出流)
└── Coordinator 视图 (Worker 关系图)

/army/agents/:type         — Agent 详情
├── Agent 配置面板
├── 历史任务列表
├── 记忆浏览器 (soul/memory/wisdom/skills)
├── 成本分析图表
└── 对话界面 (与 Agent 直接交互)

/army/memory               — 记忆中心
├── 共享知识索引
├── Dream 整合历史
└── 知识搜索

/army/permissions          — 权限管理
├── 待审批队列
├── 审批历史
└── 规则配置

/army/metrics              — 监控面板
├── Token 用量趋势
├── 成本分布 (按 Agent/按 Domain)
├── 任务成功率
└── 响应时间分布
```

### 7.2 实时交互流程

```
用户在 Dashboard 点击 "新建任务"
  → POST /api/tasks { agent_type, prompt, context }
  → Runtime 创建 TaskState，广播 TaskCreated 事件
  → Dashboard SSE 收到事件，显示新任务卡片

Agent 执行过程中
  → 每次 LLM 响应/工具调用，广播 TaskUpdated 事件
  → Dashboard 实时更新输出流

Agent 需要权限审批
  → 广播 PermissionRequest 事件
  → Dashboard 显示审批弹窗
  → 用户点击 批准/拒绝
  → POST /api/permissions/:id/approve
  → Runtime 收到决策，继续执行

Agent 完成
  → 广播 TaskCompleted 事件
  → Dashboard 更新状态为 "完成"
  → 后台触发 Extract Memories
```

---

## 8. 企业化扩展点

### 8.1 领域无关设计

Agent 运行时本身不包含任何业务逻辑。业务知识通过以下方式注入：

```
1. soul.md          — Agent 的领域知识和行为准则
2. skills/*.md      — 可复用的操作技能
3. tools 配置       — 允许使用哪些工具
4. external_apis    — 对接哪些外部系统 (金蝶/旺店通/mini橙/...)
5. domain 标签      — 分类管理
```

### 8.2 多业务域示例

```
电商域:
  - inventory_monitor   (库存监控员)  → domain: ecommerce
  - pricing_analyst     (定价分析师)  → domain: ecommerce
  - listing_manager     (上架管理员)  → domain: ecommerce

供应链域:
  - procurement_planner (采购计划员)  → domain: supply_chain
  - supplier_auditor    (供应商审计)  → domain: supply_chain
  - quality_inspector   (质量检查员)  → domain: supply_chain

健康管理域:
  - health_advisor      (健康顾问)    → domain: healthcare
  - medication_tracker  (用药追踪)    → domain: healthcare
  - appointment_mgr     (预约管理)    → domain: healthcare

通用域:
  - data_analyst        (数据分析师)  → domain: general
  - report_generator    (报告生成器)  → domain: general
  - notification_agent  (通知推送员)  → domain: general
```

### 8.3 安全与合规

```
审计日志:
  - 所有工具调用记录 (谁/什么时候/调了什么/参数/结果)
  - 所有权限决策记录
  - 所有记忆变更记录
  - 所有 token 消耗和成本记录

数据隔离:
  - 不同 domain 的 Agent 不能访问彼此的 workspace
  - 共享记忆需要显式配置
  - 外部 API 凭证按 Agent 隔离

成本控制:
  - 每个 Agent 独立预算限制
  - 全局成本上限
  - 实时成本预警 (推送到 Dashboard)
```

---

## 9. 实施路线

### Phase 1: 核心类型 + Task 系统 (本次)
- [ ] `types/` 模块: 所有核心类型定义
- [ ] `state/` 模块: AppStateStore + 事件广播
- [ ] `task/` 系统集成到 engine

### Phase 2: Agent 定义 + 权限
- [ ] `agent/loader.rs`: TOML Agent 定义加载
- [ ] `agent/built_in.rs`: 5 个内置 Agent
- [ ] `permission/`: 完整权限检查链

### Phase 3: Tool 增强 + Coordinator
- [ ] Tool trait 增强 (权限/并发/进度)
- [ ] `tools/spawn_worker.rs`, `send_message.rs`, `stop_task.rs`
- [ ] `runtime/coordinator.rs`

### Phase 4: Server API + SSE
- [ ] 新的 handler 体系
- [ ] SSE 事件推送
- [ ] Dashboard 聚合端点

### Phase 5: Memory 系统
- [ ] Auto Dream 三层门控
- [ ] Extract Memories 后台提取
- [ ] 共享记忆索引

### Phase 6: Dashboard 前端 (union-dashboard)
- [ ] `/army` 页面: Agent 军团总览
- [ ] `/army/tasks` 页面: 任务中心
- [ ] `/army/agents/:type` 页面: Agent 详情 + 对话

---

## 10. 与 Claude Code 的差异总结

| 设计点 | Claude Code | Shujian Agent | 理由 |
|--------|------------|---------------|------|
| 语言 | TypeScript | Rust | 性能、安全、可嵌入 |
| UI | 终端 (React Ink) | Web Dashboard | 企业用户需要图形界面 |
| Agent 定义 | Markdown + TS | TOML 声明式 | 非开发者也能配置 |
| 权限分类器 | LLM-based | 规则引擎 | 确定性、低成本、无延迟 |
| 状态管理 | immer store | Arc<RwLock> + broadcast | Rust 原生并发安全 |
| 进程模型 | 单进程多线程 | 单进程多线程 (可选多进程) | 先简单后扩展 |
| 记忆整合 | Auto Dream (forked agent) | Auto Dream (background task) | 相同模式 |
| 领域 | 编程任务 | 领域无关 | 企业化需求 |
| 成本追踪 | 有 (analytics) | 有 (per-agent, per-task) | 企业预算管理 |
| AI Buddy | 有 (彩蛋) | 无 | 非核心功能，可后期加 |
| Ultraplan | 有 (远程规划) | 无 (可扩展) | 依赖云服务，先不做 |
| Bridge | 有 (IDE ↔ Web) | 不需要 | Dashboard 即 Web |
