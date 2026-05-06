# shujian-agent-bridge

把 [`@cursor/sdk`](https://cursor.com/cn/docs/sdk/typescript) 包成 **HTTP + SSE** 的轻量边车，让任何宿主（Rust 后端、React dashboard、远端 Mac mini、Cloud Agent…）都能用统一接口驱动 Cursor Agent。

> **定位**：一个 bridge = 一台“Cursor 工位”，绑一把 Cursor API key，对外暴露固定 HTTP 接口。  
> 多个 bridge 串起来 = 一个**分布式 Cursor agent 农场**。

---

## 架构

```
┌─────────────── shujian-dashboard (React) ───────────────┐
│  Bridge registry (localStorage):                         │
│    • local        http://localhost:8003                  │
│    • macmini-1    https://mac1.tunnel.example.com        │
│    • macmini-2    https://mac2.tunnel.example.com        │
│    • cloud-pool   https://cloud-bridge.example.com       │
└────────────┬───────────────┬────────────────┬────────────┘
             │ HTTP/SSE      │ HTTP/SSE       │ HTTP/SSE
             ▼               ▼                ▼
   ┌──────────────┐  ┌──────────────┐  ┌──────────────┐
   │ bridge :8003 │  │ bridge :8003 │  │ bridge :8003 │
   │ + Cursor SDK │  │ + Cursor SDK │  │ + Cursor SDK │
   │ KEY = crsr_A │  │ KEY = crsr_B │  │ KEY = crsr_C │
   └──────┬───────┘  └──────┬───────┘  └──────┬───────┘
          │                  │                  │
   local agents        local agents      cloud agents only
   + cloud agents      + cloud agents    (无本地工作目录)
```

每个 bridge 独立持有：

- 自己的 `CURSOR_API_KEY`（不同账号 / 不同 quota / 不同模型权限）
- 自己的本地工作目录（`DEFAULT_CWD`）
- 自己的 skills 目录（`~/.cursor/skills/`）

dashboard 只挑“去哪个 bridge 派活”。

---

## HTTP 接口

| Method | Path                                       | 用途                                                |
| ------ | ------------------------------------------ | --------------------------------------------------- |
| GET    | `/health`                                  | 探活，返回 `{ name, version, uptime }`              |
| GET    | `/me`                                      | 当前 API key 信息                                   |
| GET    | `/models`                                  | 可用模型列表                                        |
| GET    | `/usage`                                   | 计费 / 配额（rich 数据需要 session token）          |
| POST   | `/agents`                                  | 创建 agent (`{ source: 'local' \| 'cloud', ... }`) |
| GET    | `/agents`                                  | 列活跃 agents                                       |
| DELETE | `/agents/:id`                              | 释放 agent                                          |
| POST   | `/agents/:id/messages`                     | 发消息（同步等结果）                                |
| GET    | `/agents/:id/messages/:runId/stream`       | SSE 实时事件流                                      |

请求头（dashboard 自动注入）：

```
X-Cursor-Api-Key:        crsr_...           # 必填，覆盖 .env
X-Cursor-Session-Token:  user_xxx::eyJ...   # 可选，用于 /usage 拉账单
```

> 不在服务端持久化任何 key —— 浏览器 `localStorage` 是唯一真相源。

---

## 启动

### 本地（Mac 上一台）

```bash
bun install
cp .env.example .env       # 改 PORT / BRIDGE_NAME
bun run dev                # 默认 :8003
```

### 多台 Mac mini + Cloudflare Tunnel

让每台 Mac mini 跑一个 bridge，再用 [`cloudflared`](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/) 把 `:8003` 暴露到 `https://mac-name.tunnel.example.com`。

每台 Mac mini 上：

```bash
# 1. 启 bridge
git clone https://github.com/ShukriChiu/shujian-agent-bridge.git
cd shujian-agent-bridge && bun install
BRIDGE_NAME=mac-mini-studio PORT=8003 bun run start &

# 2. 起 tunnel
cloudflared tunnel login
cloudflared tunnel create mac-mini-studio
cloudflared tunnel route dns mac-mini-studio mac-studio.tunnel.example.com

cat > ~/.cloudflared/config.yml <<EOF
tunnel: mac-mini-studio
credentials-file: /Users/you/.cloudflared/<tunnel-uuid>.json
ingress:
  - hostname: mac-studio.tunnel.example.com
    service: http://localhost:8003
  - service: http_status:404
EOF

cloudflared tunnel run mac-mini-studio
```

之后在 dashboard 的「Bridges」面板里加一行：

```
name      = mac-mini-studio
endpoint  = https://mac-studio.tunnel.example.com
api_key   = crsr_xxx (this mac mini's own key)
```

dashboard 派活时会把 `X-Cursor-Api-Key` 注到对应请求里，bridge 永远不见明文 key 的持久副本。

### 容器（Cloud Run / Fly.io / Railway）

```dockerfile
FROM oven/bun:1.3
WORKDIR /app
COPY package.json bun.lock ./
RUN bun install --production
COPY . .
ENV PORT=8003
EXPOSE 8003
CMD ["bun", "src/server.ts"]
```

只跑 cloud agents 的话，不需要任何本地工作目录 —— 容器里 `DEFAULT_CWD` 设个 `/tmp` 或者别设就行。

---

## Cloud Agent · 多 session 并行

Cursor SDK 的 cloud agent 每个会拿到一台**独立的 sandbox VM**，所以同一个 repo 可以同时开 N 个并行跑。

```bash
# 必须先在 GitHub 上给 ShukriChiu 装 Cursor "Background Agents" App，
# 并把目标 repo 授权给它。否则会报：
#   [validation_error] Failed to verify existence of branch 'main'
#
# 安装入口：https://cursor.com/integrations/github
```

跑 smoke test：

```bash
CURSOR_API_KEY=crsr_... \
  REPO_URL=https://github.com/ShukriChiu/onion-agent.git \
  N=3 bun run test:cloud
```

会启 3 个 cloud agent 同时干 3 件事，最后给一个 wall-clock vs sum-of-individuals 的并行加速比。

---

## 状态

| 模块                        | 状态           |
| --------------------------- | -------------- |
| 本地 agent (`source=local`) | ✅ 可用        |
| Cloud agent (`source=cloud`)| ⚠️ 需先装 GitHub App |
| 多 session 并行             | ⚠️ 待实测      |
| 多 bridge 注册（dashboard） | 🛠 进行中      |
| Cloudflare Tunnel 部署      | 📝 文档已就绪  |

---

## License

MIT — see [LICENSE](./LICENSE).
