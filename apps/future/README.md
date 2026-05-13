# 书剑 Future

AI 学生实战人才池管理台。跟踪学生画像、项目机会、匹配记录和成长反馈。

## 数据层

`apps/future` 是纯前端（Vite + React 19 + TanStack Query），数据通过
`apps/backend`（Rust + Axum + Postgres）的 `/v1/future/state` 端点同步：

- **GET** 拉取当前 tenant 的 WarRoomData 快照
- **PUT** 提交完整快照（事务性 replace-all）

业务表都带 `future_` 前缀，和 dashboard / vault / personas 等其它 app
共用同一个 backend。tenant 隔离由 `AuthContext` 在 handler 层强制。

类型契约在 `packages/shared-types/src/future.ts`，前后端共享。

## 本地开发

```bash
# 在仓库根目录
bun install

# 起 backend（需要可用的 Postgres，见 apps/backend/.env.example）
just dev-backend

# 起 future 前端（端口 5274，默认 vite 代理 /backend → Railway prod）
just dev-future

# 想本地连后端：
BACKEND_DEV_TARGET=http://localhost:8080 just dev-future
```

## 构建

```bash
just build-future
# 或： cd apps/future && bun install && bunx vite build
```

输出在 `apps/future/dist/`。

## 部署

Cloudflare Pages（GitHub 集成自动部署 `apps/future/`）。

- 项目名：`shujian-future`
- 构建命令：`bun install && cd apps/future && bunx vite build`
- 输出目录：`apps/future/dist`
- 环境变量（可选）：`VITE_BACKEND_URL` 显式指向 backend；不设则用代码里的
  prod fallback（Railway URL）。

backend 那边记得把 future 的 origin 加到 `CORS_ALLOW_ORIGINS`。
