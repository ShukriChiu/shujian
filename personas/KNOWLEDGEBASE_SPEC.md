# Knowledgebase Spec v1

> Cloud agents 在 shujian dashboard 里被创建时，会绑定一个 GitHub 仓库（**只读**）+ 一个 vault（envVars 注入）。
>
> 仓库里的 markdown 提供"业务上下文"，vault 提供"可信凭证"（多半是数据库只读连接 + 业务 API token）。本 spec 规定这种 **knowledgebase 仓库的目录约定**，让 agent 一进 sandbox 就知道该读什么、能查什么。

样板实现：[`onion-knowledgebase`](https://github.com/ShukriChiu/onion-knowledgebase)。

---

## 1. 仓库约束

只读：knowledgebase 仓库不会被 agent commit / push / 开 PR（dashboard 创建时 `autoCreatePR = false` 写死，cursor cloud agent 跑完即丢分支）。仓库内容只用于"灌业务上下文"。

每个 knowledgebase 仓库 root 必须有：

```
<company>-knowledgebase/
├── AGENTS.md                # 必填 · 入口 + L1-L4 加载协议 + 文档索引
├── DATABASE.md              # 必填 · 数据库 schema + 业务问题 → 表索引
├── 公司概览.md               # 必填 · 公司、品牌、组织、术语表
├── 数据与对象命名.md         # 必填 · 跨端稳定语义（不是 DDL）
├── 业务流程-*.md             # 必填 · 至少一个业务域文档
├── QUERIES.md               # 可选 · 经典 SQL 查询集合
├── 通知矩阵.md / 测试账号.md  # 可选
└── 知识缺口与商业洞察.md      # 可选 · AI 看不到的盲区清单
```

文件名可以中英文，但**这五个是必填**：`AGENTS.md` / `DATABASE.md` / `公司概览.md` / `数据与对象命名.md` / 至少一份 `业务流程-*.md`。

## 2. AGENTS.md 必备元素

`AGENTS.md` 是 agent 在 sandbox 里第一个读到的文件（cursor cloud agent 默认行为）。它必须：

- frontmatter 标 `alwaysApply: true`，让 cursor 在每条消息都加载
- 一句话定位"本仓库是什么 / 谁的业务知识库"
- L1-L4 加载协议表，告诉 agent 什么时候该读哪一层
- "文档索引"段：每个文件一行 `[name](path) | 一句话说明`

模板：

```markdown
---
description: <公司名> 业务知识库 — 业务规则与领域知识的唯一权威源
alwaysApply: true
---

# <公司名> 业务知识库

## 本仓库是什么
…一句话…

## L1-L4 加载协议
| 层级 | 内容 | 位置 | 加载时机 |
|------|------|------|----------|
| L1 | 热启动内核 | AGENTS.md | 进入仓库时自动 |
| L2 | 领域索引 / 对象语义 | 数据与对象命名.md / DATABASE.md §1 | 不确定该读哪里时 |
| L3 | 业务权威：流程 / 状态机 | 业务流程-*.md | 修改业务逻辑或文案口径 |
| L4 | 冷技术细节 | DATABASE.md §4 / docs/ | 触碰具体实现 |

## 文档索引
| 文件 | 内容 |
|------|------|
| [DATABASE.md](DATABASE.md) | 数据库 schema + 业务问题 → 表速查 |
| [公司概览.md](公司概览.md) | 公司结构 / 品牌 / 组织 / 术语 |
| [数据与对象命名.md](数据与对象命名.md) | 跨端稳定对象语义 |
| [业务流程-X.md](业务流程-X.md) | … |
```

## 3. DATABASE.md 标准结构

> 这是 agent 回答"经营数据问题"时的核心入口。结构必须严格按下面四段，agent prompt 才能稳定 routing。

### §0 连接

告诉 agent 怎么连 DB：

```markdown
## 0. 连接

- 环境变量：`<COMPANY>_READONLY_DATABASE_URL`（vault 注入，**只读账号**）
- 推荐工具：`psql "$<COMPANY>_READONLY_DATABASE_URL" -c "..."`
- DB 引擎：Postgres 16 / Supabase
- ⚠️ 严禁 `INSERT/UPDATE/DELETE/TRUNCATE/DROP/ALTER` —— 只读账号会拒绝，但 agent 也不要尝试
- ⚠️ 单查询超过 5 万行结果时先 `LIMIT` 再聚合，避免拖垮在线库
```

### §1 业务问题速查

把"老板会问的问题"做成路由表，agent 读到这一段就知道该 JOIN 哪几张表、过滤哪些口径：

```markdown
## 1. 业务问题速查

| 问题模板 | 主表 | 关键列 | 过滤口径 | SQL 模板 |
|---------|------|-------|---------|----------|
| 今天试课多少 / 转化多少 | `fe_trial_lessons` | `trial_date`, `status`, `brand` | 排除 `student_id IS NULL` 的加课试课 | `QUERIES.md#today-trials` |
| 本月营收 | `fe_deals` | `deal_date`, `amount`, `brand` | `status='active'` | `QUERIES.md#monthly-revenue` |
| 老师课酬 | `fe_lesson_records` | `hours_used`, `subject_hourly_rate` | `amount = hours_used × subject_hourly_rate` | … |
| 课时桶余量 | `fe_student_hours` | `remaining_hours`, `subject` | `subject='预留'` 是已收款未分配 | … |
```

每行的"过滤口径"必须显式写业务约束（哪些值要排除、哪些列只能用作展示），这是 agent 不会幻觉编 SQL 的关键。

### §2 业务域 → 表族

按业务域归类表族，避免一上来就把所有表 dump 给 agent：

```markdown
## 2. 业务域 → 表族

### 2.1 老师域
- 主表：`fe_teachers`（uuid 主键，`phone + company` 业务唯一）
- 关联：`fe_teacher_bank_accounts`（收款卡）, `fe_lesson_records`（课酬）, `fe_student_hours`（带教桶）
- 详细 schema → §4

### 2.2 学生 / 课时域
…

### 2.3 成交 / 退费域
…
```

### §3 跨表口径与陷阱

显式列出 AI 容易翻车的口径，**每条都从一次真实 incident 提炼**：

```markdown
## 3. 跨表口径与陷阱（防 AI 幻觉）

- `fe_students` **没有 `brand` 列**，品牌通过 `fe_teachers.brand` 或 `fe_student_hours.brand` 判断
- `fe_teachers.brand` 仅是展示标签，**不可用作业务过滤**——见《数据与对象命名.md》"老师身份"
- `recipient_id` 是 text，兼容员工 UUID 和老师手机号
- 时间统一用 `now_cn()`，不要 `now()`（带 UTC 偏差）
- `numeric` 列读出来是 Decimal，序列化前必须 `float()`
```

### §4 表 schema 字典

完整 DDL 字典，列名 + 类型 + 说明 + 是否可空。这一段可以很长，但 §0–§3 必须放在它前面，AI 读到第一页就有 routing。

```markdown
## 4. 表 schema 字典

### fe_teachers
| 列名 | 类型 | 空 | 说明 |
| teacher_id | uuid | NOT NULL | 主键 |
…
```

## 4. Vault 命名约定

vault（在 dashboard `/vaults` 配置）注入到 cloud agent 的 envVars。命名必须能让 AI 一看就懂：

| 命名模式 | 用途 | 例 |
|---------|------|-----|
| `<COMPANY>_READONLY_DATABASE_URL` | 只读 DB 连接 | `ONION_READONLY_DATABASE_URL` |
| `<COMPANY>_API_BASE_URL` | 业务 API 根 | `ONION_API_BASE_URL` |
| `<COMPANY>_API_TOKEN` | API 鉴权 | `ONION_API_TOKEN` |
| `<COMPANY>_DOCS_URL` | knowledgebase 公网地址（agent 自检/给链接用） | `https://github.com/ShukriChiu/onion-knowledgebase` |

vault 必须**只塞只读凭证**：写权限的 service_role key 不要直接发给 agent。建议 DB 单建一个 `ro_agent` role，API 单签一个 read-only token。

## 5. agent 启动语义

dashboard 创建 cloud agent 时：

1. 选 **knowledgebase 仓库**（`repoUrl`）
2. 选 **vault**（注入 envVars）
3. dashboard 自动设置 `autoCreatePR = false`（只读模式）
4. cursor cloud sandbox 启动 → 自动加载 `AGENTS.md`（L1）
5. 用户问"本月营收多少" → AI 读 `DATABASE.md §1` 找模板 → `psql $ONION_READONLY_DATABASE_URL -c "..."` 跑出来 → 回答 + 数据

## 6. 演进规则

- 新业务规则 → 进对应业务流程文档
- 新跨端对象语义 → 进 `数据与对象命名.md`
- 新表 / 新列 → 进 `DATABASE.md §4`
- 新业务问题模板 → 进 `DATABASE.md §1`
- 新口径陷阱（出过事的）→ 进 `DATABASE.md §3`
- 新 vault key → 通知 dashboard 维护者更新 vault；agent 那边只关心 envVar 名字
