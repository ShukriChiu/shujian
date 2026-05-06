# shujian-dashboard

> 本地 AI 数字员工 + Cursor agent 的统一控制台。

把两类执行体一屏管完：

- **shujian-agent** (Rust, 端口 `:8002`) — 业务用数字员工（document_clerk、inventory_watcher、kingdee_operator、data_analyst …），由 `config.toml` 声明，按 cron / interval 触发。
- **cursor-bridge** (Node + `@cursor/sdk`, 端口 `:8003`) — Cursor 本地或云端 agent，能直接动 IDE / 仓库 / 开 PR。

## 快速开始

```bash
# 1. Rust runtime
cd shujian-agent
cargo run -- daemon                   # → :8002

# 2. Cursor SDK 边车
cd shujian-agent/cursor-bridge
cp .env.example .env                  # 填 CURSOR_API_KEY
bun install && bun run dev            # → :8003

# 3. 这个 dashboard
cd shujian-dashboard
bun install && bun run dev            # → http://localhost:5273
```

## 页面

| Tab | 干啥 |
|-----|-----|
| **总览** | 实时活跃任务、cron 触发器、Cursor agent 列表、最佳实践卡 |
| **本地 Agents** | 选一个 Rust agent，同步派单（POST `/api/task/sync`），看回执 |
| **Cursor Agents** | 创建 local/cloud Cursor agent，发送消息，SSE 实时看 SDKMessage 流 |
| **设置** | 三个进程的连通性 / API key / 架构图 / 启动命令 |

## 设计语言

参考 onion-dashboard 的 PRODUCT.md（Stripe / Linear / Vercel 同条轴）：

- 高密度、克制、可预期；不饱和大按钮、不渐变玻璃拟态。
- 状态即颜色：violet 强调 / emerald 成功 / red 失败 / amber 进行中 / blue 信息。
- 字体走 Inter + 英文等宽，中文回退 PingFang / Noto Sans SC。

## 技术栈

Bun + Vite 8 + React 19 + TypeScript + Tailwind 3 + TanStack Query + lucide-react。
路由用 React state 管 4 个 tab，刻意不上 react-router——整个面板就一屏。
