# Vault 与 Persona 注入架构

> 控制平面的"凭证 + 身份"子系统。把租户的 .env 收编进 backend，按 persona（AI 角色）注入到 cursor agent 的 envVars，让 AI 永远拿不到原始 DB 密码 / R2 写 key / 钉钉 secret，只拿到一个绑到 onion 影子员工身份的短时 JWT。

最后更新：2026-05

---

## 0. 起点 / 背景

`onion-agent`（趣学洋葱的业务后端）的 .env 装了四类东西：

1. **数据通道**：`DATABASE_URL`（Railway PG）、Supabase 遗留、R2 七件套（4 个 bucket 的 access key + 自定义域名）
2. **业务系统出口**：钉钉 OAuth（`DINGTALK_*`）+ 多个机器人 webhook、聚合数据银行卡三要素
3. **AI 模型出口**：OpenRouter / Sophnet / Langfuse
4. **Onion 自己的 API 钥匙**：`ONION_API_KEY`

直接把这些 env dump 给 AI agent = 一个跑飞的 LLM 拿到 DB 主库密码、R2 写权限、所有钉钉密钥。**不可接受**。

但 onion-agent 已经替我们做对了一件事：所有写接口都强制 `operator_id` / `operator_name`，业务规则（"档案 brand ∪ 桶 brand ∪ 试课 brand 并集"等）按真实身份过滤。也就是说**"这条数据谁能看 / 谁能改"已经在 onion-agent 里解决了**——只要请求带对了身份。

所以方案是：**AI 不碰原始 secret，AI 只拿一个绑到某个 operator 身份的短时 JWT，然后调 onion-agent 的 HTTP 接口**。RBAC 沿用现有的，零重写。

---

## 1. 三层结构

```
┌────────────────────────────────────────────────────────────────┐
│ Layer A · Vault Store                                          │
│   AES-256-GCM 加密的 secret 单元，KEK 在 backend 进程外（早期 │
│   Railway env，后续可换 AWS KMS / 1Password Connect / HSM），  │
│   DEK 每行一份并由 KEK 包裹。租户隔离。                       │
├────────────────────────────────────────────────────────────────┤
│ Layer B · Scope                                                │
│   把若干 secret 翻译成"AI 能用的形式"。四种 binding：           │
│     • passthrough  — 原值塞 env（仅 LLM key 等不可避免的）       │
│     • static       — 写死的常量（API base 等）                  │
│     • onion_jwt    — 临时 mint 一个绑 operator 的 JWT (核心)    │
│     • r2_presigned — 临时签 bucket+verb+ttl URL                  │
├────────────────────────────────────────────────────────────────┤
│ Layer C · Persona                                              │
│   "这个 AI 是谁"。绑定一组 scope + cursor 启动参数              │
│   (permission_mode / 工具白名单 / model / 预算)。              │
└────────────────────────────────────────────────────────────────┘
```

### 1.1 关键不变量

- AI agent 跑起来后看到的 env **永远不包含** 原始 `DATABASE_URL` / `R2_SECRET_ACCESS_KEY` / `DINGTALK_CLIENT_SECRET`。
- AI 想读业务数据 → 只能 `fetch(${ONION_API_BASE}/api/...)`，带上 `Authorization: Bearer ${ONION_API_TOKEN}`，让 onion-agent 用现有 RBAC 过滤。
- 每次启动 AI 都新 mint JWT，jti 写 `vault_issuance_log`，agent 销毁 / 用户主动撤销时 backend 调 onion `/api/internal/revoke-token` 把 jti 拉黑。
- KEK 永远不进 PG。早期阶段从 Railway env (`SHUJIAN_VAULT_KEK_B64`) 启动加载，将来可平滑换到 AWS KMS Decrypt API（永远不出 HSM）。详见 §5。

---

## 2. 数据模型

详见 `apps/backend/migrations/0002_vault.sql`。要点：

```
vault_kek_versions(version, fingerprint, source, activated_at, deprecated_at)
  ─ 当前/历史 KEK 版本表，方便轮换时知道哪条 row 用哪个 KEK 包的 DEK
  ─ source 自由文本：'env_prod' / 'env_dev' / 'kms:arn:...' / '1password://...'
    用于将来切 provider 时不动 schema

vault_secrets(id, tenant_id, name, kind, ciphertext, nonce, dek_wrapped,
              kek_version, metadata, created_at, rotated_at)
  ─ 加密落库的 secret 单元；UNIQUE(tenant_id, name)

vault_operator_refs(id, tenant_id, system, operator_id, operator_name,
                    is_shadow, role_hint)
  ─ "这个 AI persona 在 onion 里是谁"。is_shadow=true 表示是新建的影子员工

vault_scopes(id, tenant_id, name, description, bindings, operator_ref_id)
  ─ bindings JSONB，详见 §3

agent_personas(id, tenant_id, slug, display_name, description,
               system_prompt, allowed_scopes uuid[], cursor_settings,
               created_by, created_at)

vault_issuance_log(id, tenant_id, persona_id, issued_to_user, bridge_name,
                   cursor_agent_id, cursor_run_id, scope_ids uuid[],
                   env_keys text[], onion_jti, expires_at, revoked_at,
                   created_at)
  ─ 审计：谁 / 何时 / 把哪些 scope 注入给哪个 cursor agent；
    env_keys 只记 key 名，不记值
```

---

## 3. Scope binding 规范

`vault_scopes.bindings` 是一个 JSONB 数组，每条形如：

### 3.1 `passthrough` — 原值塞 env

```json
{ "kind": "passthrough", "secret_id": "<uuid>", "env": "OPENROUTER_API_KEY" }
```

*用法*：仅给 AI 直接调用第三方 API 必需的 key（OpenRouter / Sophnet）。

### 3.2 `static` — 写死的常量

```json
{ "kind": "static", "value": "https://onion-agent.shujian.art", "env": "ONION_API_BASE" }
```

*用法*：API base、bucket public URL 等不需保密的常量。

### 3.3 `onion_jwt` — mint 短时 JWT（**核心**）

```json
{
  "kind": "onion_jwt",
  "operator_ref_id": "<uuid of vault_operator_refs>",
  "env": "ONION_API_TOKEN",
  "ttl_seconds": 3600,
  "readonly": true
}
```

*流程*：
1. backend 解出 `operator_id` / `operator_name` from `vault_operator_refs`
2. 调 onion-agent `POST /api/internal/mint-token`（内网 + `X-Backend-Secret` 头）
3. onion-agent 用 `ONION_API_KEY` 作为 HS256 secret 签 JWT，claims = `{ sub, persona_id, scope_id, jti, exp, readonly, kind: "ai_persona" }`
4. backend 把 JWT 当作 `ONION_API_TOKEN` 注入；jti 落 `vault_issuance_log`

*onion-agent 的中间件**新增**`require_operator()` 的 JWT 路径*：
- 识别 `Authorization: Bearer <jwt>` → verify → 注入 `operator_id` / `operator_name`
- if `claims.kind == "ai_persona"` 且 `claims.readonly == true` → 当前路由方法必须是 GET / HEAD / OPTIONS，否则 `403 ai_persona_readonly_violation`
- 现有 `check_all_permissions_cached(employee_id)` 等无变化

### 3.4 `r2_presigned` — 临时签 R2 URL

```json
{
  "kind": "r2_presigned",
  "secret_id": "<r2 access key secret>",
  "bucket": "lesson",
  "perms": ["get"],
  "key_prefix": "lesson-records/2026/",
  "ttl_seconds": 600,
  "env": "R2_LESSON_GET_URL"
}
```

*P0 不实现，留待第二期*。

---

## 4. 注入流程（dashboard 点"启动 persona"那一刻）

```
[Dashboard]            [shujian-backend]            [onion-agent]            [bridge]              [Cursor SDK]
POST /v1/personas/
  :id/launch ────────>│
                      │ 1. 鉴权：caller 是该 tenant 的 admin/owner
                      │ 2. load persona + allowed_scopes (检查 ⊆ tenant)
                      │ 3. 解所有 scope.bindings:
                      │    a. passthrough → AES-GCM decrypt → env
                      │    b. static      → 直接 env
                      │    c. onion_jwt   ──────────────>│ POST /api/internal/mint-token
                      │                                   │  body: { operator_id, persona_id, scope_id, ttl, readonly }
                      │                                   │ ← { token, jti, expires_at }
                      │ 4. 拼 envVars:
                      │    {
                      │      ONION_API_BASE,
                      │      ONION_API_TOKEN: <jwt>,
                      │      OPENROUTER_API_KEY,
                      │      ...
                      │    }
                      │ 5. 拼 cursor 启动参数:
                      │    {
                      │      runtime, model,
                      │      permission_mode: 'plan',
                      │      disallowed_tools: ['shell_exec','write_file'],
                      │      settingSources, envVars
                      │    } ──────────────────────────────────────────────>│ POST /agents
                      │                                                      │ Agent.create({...})───>│
                      │                                                      │ ← { agentId }          │
                      │ 6. INSERT vault_issuance_log(env_keys=[...], onion_jti, expires_at)
  ← { agent_id,        │
      run_url,
      expires_at } ───│
```

---

## 5. KEK 管理

### 5.1 为什么 KEK 要放进程外

把"加密的钥匙"和"加密的数据"拆到不同信任域。攻击者拖到 PG 备份只能看到密文 + 包裹后的 DEK，没有 KEK 解不出来。**所以 KEK 必须不在 PG 里**——至于放在哪个进程外的位置，是工程取舍：

| 选项 | 隔离强度 | 工程量 | 适合阶段 |
|------|---------|-------|---------|
| Railway env (`SHUJIAN_VAULT_KEK_B64`) | 中：Railway 项目权限 | 5 分钟 | **早期 / solo（当前）** |
| AWS KMS / GCP KMS | 高：HSM、KEK 永不出来、每次调用审计 | ~2 小时联调 | 客户问 SOC2 时 |
| 1Password Connect | 高：自部署 + audit log | ~1 天 | 已经是 1Password 客户 |
| Cloudflare Secrets Store | ❌ 不适用 | — | 该产品是 Worker binding，无 REST 读 API |

### 5.2 当前实现：Railway env

- backend 启动时从 `SHUJIAN_VAULT_KEK_B64` 读 32 字节 KEK，base64 解码后放入进程内存
- KEK **不在 PG**、不在 docker image、不在 git。Railway 项目权限决定谁能看到
- 拉不到 KEK → vault 端点全部返 503，但 auth / tenants / health 等其它端点不受影响（健康检查不挂）
- 启动 banner 区分 prod vs dev：
  - `SHUJIAN_VAULT_KEK_B64` 设了 → `vault KEK loaded from SHUJIAN_VAULT_KEK_B64 (production env)`
  - 只有 `SHUJIAN_VAULT_DEV_KEK_B64` → `DO NOT USE IN PROD` 大字警告
- `vault_kek_versions.source` 列记录当前 KEK 是从哪个 env 加载的（`env_prod` / `env_dev`），dashboard 上能看出 prod 模式跑了 dev key 的事故

### 5.3 轮换流程（env 模式）

1. 生成新 KEK：`openssl rand -base64 32`
2. 在 Railway 加 env `SHUJIAN_VAULT_KEK_B64_V2=<new>`，**不要**先删旧的
3. backend 调 `POST /v1/vault/_admin/rotate?to_version=2`（superuser only）
4. 后台任务遍历 `vault_secrets`，每条 row：
   - 用 v1 KEK unwrap 出明文 DEK
   - 用 v2 KEK 重新 wrap
   - `UPDATE dek_wrapped + kek_version=2`
5. 全表完成后 `INSERT vault_kek_versions(2, fingerprint, source='env_prod', now())`，把 v1 标记 `deprecated_at`
6. 把 Railway env 改成：`SHUJIAN_VAULT_KEK_B64=<v2 value>`，删 `_V2` 后缀那个临时 env，重启 backend

### 5.4 本地开发回退

`SHUJIAN_VAULT_DEV_KEK_B64=$(openssl rand -base64 32)` 跑 backend 即可。启动日志会打印 `DEV KEK active — DO NOT USE IN PROD`。如果同时设了 prod 和 dev，prod 优先。

### 5.5 将来切 KMS

`KekProvider::fetch_material` 是唯一需要改的地方：把"读 env"换成"调 AWS KMS Decrypt API（送进 wrapped DEK，拿回明文 DEK）"。`vault_kek_versions.source` 列从 `env_prod` 改成 `kms:arn:aws:kms:...`。Schema 不动，业务代码不动。

---

## 6. Persona 范例

### 6.1 趣学洋葱老板·经营分析师

```yaml
slug: onion_boss_analyst
display_name: 洋葱老板·经营分析师
description: 给老板看的只读分析师，专做经营数据图表 + 决策建议
system_prompt: |
  你是趣学洋葱的经营分析师，服务对象：公司创始人。
  你的边界：
    - 只读数据 + 出图 + 给决策建议
    - 不修改任何业务数据，不调写接口，不改代码
    - 数据全部来自 ONION_API_BASE 的只读端点
  风格：克制、数据驱动、先大趋势后细节、不卖术语。
  决策建议必须挂到具体数字（"过去 30 天试课转化率 18% → 22%"），
  不允许凭空臆测；没数据就明确说"目前数据不足以判断"。

allowed_scopes:
  - onion.readonly_business      # binding: onion_jwt → operator=ai_boss_analyst (shadow, readonly=true)
  - onion.llm_openrouter         # binding: passthrough OPENROUTER_API_KEY
  - onion.api_base               # binding: static ONION_API_BASE

cursor_settings:
  runtime: cloud
  model: composer-2
  permission_mode: plan          # Cursor SDK 原生只读模式
  tools_whitelist: [http_fetch, read_file]
  tools_blacklist: [shell_exec, write_file]
  setting_sources: [user]
  max_budget_usd: 0.50
  effort: high
```

对应在 onion-agent 一次性创建的 shadow employee：

```sql
INSERT INTO employees (id, name, nickname, status, is_ai_persona, persona_role, ...)
VALUES (gen_random_uuid(), 'AI·老板分析师', 'AI·老板分析师', '在职',
        true, 'analyst_readonly', ...);
-- 然后在 employee_permissions 表给它授权（全 brand 只读）
```

### 6.2 采购计划员（对比，证明同架构能升级）

```yaml
slug: onion_procurement_planner
allowed_scopes:
  - onion.fulfillment_rw          # binding: onion_jwt → 真实采购员 operator_id
  - onion.dingtalk_procurement    # binding: passthrough DINGTALK_BOT_PROCUREMENT_WEBHOOK
cursor_settings:
  permission_mode: default        # 写动作走权限审批 → 推到 dashboard 待审
  tools_blacklist: [shell_exec]
  max_budget_usd: 2.00
```

---

## 7. API 端点总表

### 7.1 backend (`shujian/apps/backend`)

```
=== Vault Store (P0) ===
POST   /v1/vault/secrets                  创建/更新 secret（加密落库）
GET    /v1/vault/secrets                  列出（不返 ciphertext，只返 metadata）
GET    /v1/vault/secrets/{name}           取 metadata（不返值）
DELETE /v1/vault/secrets/{name}           删除

=== Operator Refs (P0) ===
POST   /v1/vault/operator-refs            注册一个 onion 影子/真实 operator
GET    /v1/vault/operator-refs
DELETE /v1/vault/operator-refs/{id}

=== Scopes (P1) ===
POST   /v1/vault/scopes
GET    /v1/vault/scopes
PUT    /v1/vault/scopes/{name}
DELETE /v1/vault/scopes/{name}

=== Personas (P3) ===
POST   /v1/personas
GET    /v1/personas
PUT    /v1/personas/{slug}
DELETE /v1/personas/{slug}
POST   /v1/personas/{slug}/launch         核心：解 scope + mint JWT + 调 bridge
POST   /v1/personas/{slug}/runs/{agent_id}/revoke   关 bridge agent + revoke jti

=== KEK 管理 (admin) ===
GET    /v1/vault/_admin/kek               当前 KEK 版本
POST   /v1/vault/_admin/rotate            后台任务，重新 wrap 全表 DEK
```

### 7.2 onion-agent

```
POST   /api/internal/mint-token           内网 + X-Backend-Secret 鉴权
POST   /api/internal/revoke-token         同上
GET    /api/internal/whoami                JWT 自检（返回 claims）
```

中间件改造：`require_operator()` 增加 `Authorization: Bearer <jwt>` 路径，readonly persona 写动作直接 403。

### 7.3 bridge

无新端点。`POST /agents` 已经支持 `envVars`，需要新增对 `cursor_settings.permission_mode` / `cursor_settings.tools` 透传给 SDK。

---

## 8. 安全模型

### 8.1 信任边界

| 层 | 信任级别 | 失陷影响 |
|----|---------|----------|
| KEK 来源（Railway env / 未来 KMS） | 最高 | 失陷 → 拿到 KEK → 全 vault 解密。需要立即轮换 KEK（§5.3）+ 通知所有租户。Railway env 模式下，"失陷"≈ 整个 Railway 项目权限失陷。 |
| backend Postgres (`vault_secrets.ciphertext`) | 中 | 失陷但拿不到 KEK → 无法解密 |
| backend 进程内存 | 高 | 启动后缓存了 KEK 5min、active session 期间持有解密 secret。需要禁止 core dump、定期重启。 |
| onion-agent JWT secret (`ONION_API_KEY`) | 中 | 失陷 → 任何人能签 ai_persona JWT → 拿到该 persona 的 RBAC 权限。需要轮换 `ONION_API_KEY`，所有现存 jti 自动失效。 |
| AI agent 进程 (cursor cloud) | 低 | 失陷 → 拿到 envVars 里的内容（短时 JWT + LLM key + presigned URL）。这就是为什么 vault binding 默认 mint 短时 token。 |

### 8.2 审计

- `vault_issuance_log` 记录每一次"凭证下发"事件，env_keys 只记 key 名
- `vault_secrets.metadata` 可记录"上次被哪个 persona 用过"
- onion-agent 现有 `ai_usage_logs` / `notifications` 等审计表，operator_id 自然就是 shadow employee uuid，一看 `is_ai_persona=true` 就知道是 AI 干的

### 8.3 默认安全

- KEK 不存任何 .env
- secret 写入 → 立即加密，不在内存里逗留
- secret API 不返回 ciphertext / 解密值。要拿到值只有一条路：`POST /v1/personas/:slug/launch`
- ai_persona 默认 readonly=true；写动作必须显式声明 `readonly=false` 且 caller 是 owner

---

## 9. 实施进度

| Phase | 范围 | 状态 |
|-------|------|------|
| P0 | `vault_kek_versions` + `vault_secrets` + AES-GCM crypto + KEK client + `POST/GET/DELETE /v1/vault/secrets` | ✅ |
| P0.5 | `vault_operator_refs` 表 + 端点 | ✅ |
| P1 | `vault_scopes` + `passthrough` / `static` 两种 binding 解析 | ✅ schema 就位 |
| P2 | onion-agent `mint-token` / `revoke-token` + JWT 中间件 + `revoked_jtis` 表 + `employees.is_ai_persona` 列 | ✅ |
| P3 | `agent_personas` + `POST /v1/personas/:slug/launch` 调 bridge | ✅ schema 就位（launch endpoint 留待与 bridge 联调一起做） |
| P4 | bridge 透传 `permission_mode` / 工具白名单 | 留待 launch 联调 |
| P5 | dashboard `/vaults` 新建/列表服务端 vault | ✅ |
| P6 | dashboard `/personas` 列表 + 启动 | 留待 launch 联调 |
| P7 | `r2_presigned` binding | 后期 |

---

## 10. FAQ

**Q: 为什么不直接给 AI agent 一个 onion 真实员工的 token？**
A: 审计混乱。AI 误删了一条数据，日志里看到的是真员工 ID，要花时间区分人/AI。shadow operator 让"AI 干的事"在所有审计表里天然分流。

**Q: shadow operator 怎么发权限？**
A: 沿用 onion-agent 现有的 `employee_permissions` / `position_permissions` 表，给 shadow employee 单独建一份"全 brand 只读"权限。无需新表。

**Q: KEK 拿不到 backend 还能跑吗？**
A: 能。健康检查不依赖 KEK。Vault 端点会返 503，其它端点（auth、tenants、健康检查）正常。这避免 KEK 来源出事故时整个 dashboard 瘫掉。

**Q: 如果租户想自己看 secret 原文（紧急排查）？**
A: 不允许。设计上 `vault_secrets` 是 write-only API。要看原文只能租户自己留底（但他们不应该留底，不然就是新的攻击面）。

**Q: 为什么不用 Cloudflare Secrets Store？我看到名字像 KMS。**
A: Cloudflare Secrets Store 是给 Cloudflare Workers 用的——值通过 Worker binding (`await env.MY_SECRET.get()`) 读出来，**没有公开的 REST API 让外部 Rust backend 拉取**。要用它必须额外部署一个代理 Worker，那个 Worker 的 bearer token 就成了新的"真 KEK"，只是把边界搬了一下，没解决问题。早期阶段用 Railway env，等需要 HSM 级别隔离时直接上 AWS KMS。

**Q: 怎么防 backend 进程被攻陷后 dump 内存拿到 KEK？**
A: 进程级缓存 5min；定期滚动重启清缓存；生产关 core dump；后期可考虑用 enclave / TEE。但更现实的护栏是"假设进程会被攻陷 → 让攻陷代价 = 5min 窗口的 secret"。

