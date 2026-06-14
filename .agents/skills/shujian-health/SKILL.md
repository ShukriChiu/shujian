---
name: shujian-health
description: 书剑个人健康数据——从 Oura Ring 拉取睡眠/HRV/活动数据，从三诺 CGM 拉取连续血糖数据，统一存入 Railway Postgres（health schema），用于健康故事线（五层根因分析 + 跨源关联 + 干预方案）。当用户提到"睡眠""HRV""血糖""TIR""CGM""Oura""身体状态""最近累""健康分析""根因""故事线""黎明现象""血糖波动"等话题时使用。
---

# shujian-health / 健康数据中枢 + 故事线分析

## 定位

健康数据在 **shujian monorepo** 的 [`apps/health`](../../../apps/health) Python 服务，**多租户**设计。

**数据层**：
- `health oura` — Oura Ring（每租户独立 `oura_pat`）
- `health cgm` — 三诺 CGM（服务级 OAuth + 每租户 `sino_user_id`）

**分析层**（`health storyline`）：五层健康故事线

**数据库**：Railway Postgres，`health` schema；租户表 `health.tenants`，OAuth 缓存 `health.sino_oauth`

## 多租户

```bash
uv run health tenant add --owner shujian --sino-user-id <id> --oura-pat <pat>
uv run health tenant list
uv run health oura sync --all
uv run health cgm sync --all
uv run health storyline --owner shujian --days 14
```

`HEALTH_OWNER` + env 里的 `OURA_PAT`/`SINO_USER_ID` 会在 `health init` 时种子写入默认租户。

## 前置

`apps/health/.env`：

- `DATABASE_URL` — Railway Postgres
- **CGM OAuth（服务级）**：`SINO_CLIENT_ID` + `SINO_CLIENT_SECRET` + `ICAN_USERNAME` + `ICAN_PASSWORD`
- **租户级**：`health tenant add` 或 `health.tenants` 表

生成 `.env`：

```bash
cd apps/health
python3 scripts/write_env.py
uv sync
uv run health init
```

Token 状态：`GET /api/health/auth` 或本地 `uv run health serve` 后查看。

## CLI（日常命令）

```bash
uv run health init
uv run health tenant list

uv run health oura sync --days 7
uv run health oura sync --all
uv run health oura today --owner shujian

uv run health cgm sync --days 7
uv run health cgm sync --all
uv run health cgm today

uv run health storyline --days 14
uv run health serve
```

## HTTP API

| 端点 | 说明 |
|------|------|
| `GET /healthz` | 存活检查 |
| `GET /api/health/auth` | SINO token 模式/过期（无密钥） |
| `GET/POST /api/health/tenants` | 租户管理 |
| `POST /api/health/sync` | 同步；body 可设 `all_tenants: true` |
| `GET /api/health/today?owner=` | 今日简报 |
| `GET /api/health/trend?source=oura\|cgm&owner=` | 趋势 |
| `GET /api/health/storyline?days=14&owner=` | 故事线 |
| `GET /api/health/stats?owner=` | 各表行数 |

Railway 定时任务默认 `--all` 同步所有 enabled 租户。

## 何时主动跑

1. 先 `today`；`synced_at` 超过 6 小时则 `sync --days 2`
2. 问睡眠/HRV → `oura today/trend`
3. 问血糖/TIR → `cgm today/trend`
4. 「帮我分析健康」→ `storyline --days 14`
5. CGM 401 → 查 `/api/health/auth`，确认 OAuth 环境变量

## 和 brain-memory 的配合

- **客观指标** → `health.*` 表
- **主观感受** → `brain.entries`（brain-memory，Supabase）

## 常见坑

- Oura 延迟：App 同步后等 30 分钟再 pull
- CGM：一个 OAuth 账号可拉多个 `sino_user_id`，不要每人配一套 client secret
- Railway：`DATABASE_URL=${{Postgres.DATABASE_URL}}`；OAuth 变量放服务级 env，租户 secret 放 DB

详细 Oura 字段见 [`references/api.md`](references/api.md)。
