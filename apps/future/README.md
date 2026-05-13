# 书剑 Future

学生招募 CRM。公网问卷链接收申请 → 后台审核打标签 → 项目跟进学生成长。

## 形态

两层界面：

- **公网问卷**（`/apply/:token`）：学生通过分享链接提交问卷（姓名、微信、专业、年级、对 AI 的理解和经验、过往项目、可选简历）。无需登录，token 决定数据归到哪个 tenant。
- **后台 CRM**（`/students`、`/projects`、`/share`）：登录后的工作区。看学生列表 / 改状态 / 打标签 / 内部备注 / 下载简历 / 加入项目 / 时间线记录沟通。

## 数据层

`apps/future` 是纯前端（Vite + React 19 + TanStack Query + react-router）。
所有数据走 `apps/backend`（Rust + Axum + Postgres）的细粒度 REST：

| Method | 路径 | 谁能调 |
|---|---|---|
| GET  | `/v1/future/apply/:token` | 公网（拿 tenant 名称） |
| POST | `/v1/future/apply/:token` | 公网（multipart 提交问卷） |
| GET / PATCH / DELETE | `/v1/future/students/:id` | 管理员 |
| GET | `/v1/future/students/:id/resume` | 管理员（下载简历） |
| GET / POST | `/v1/future/students/:id/notes` | 管理员（时间线） |
| GET / POST | `/v1/future/students/:id/assignments` | 管理员（项目分配） |
| GET / POST / PATCH / DELETE | `/v1/future/projects` ... | 管理员 |
| GET / PATCH | `/v1/future/share-link` | 管理员 |
| POST | `/v1/future/share-link/rotate` | 管理员（重置 token） |

业务表都带 `future_` 前缀（migration `0006_future_intake_redesign.sql`）。
类型契约在 `packages/shared-types/src/future.ts`，前后端共享。

## 本地开发

```bash
# 在仓库根目录
bun install

# 起 backend（需要可用的 Postgres，见 apps/backend/.env.example）
just dev-backend

# 起 future 前端（端口 5274，vite 代理 /backend → Railway prod）
just dev-future

# 想连本地后端：
BACKEND_DEV_TARGET=http://localhost:8080 just dev-future
```

## 构建

```bash
just build-future
```

输出在 `apps/future/dist/`。

## 部署

Cloudflare Pages（GitHub 集成自动部署 `apps/future/`）。

- 项目名：`shujian-future`
- 构建命令：`bun install && cd apps/future && bunx vite build`
- 输出目录：`apps/future/dist`
- 环境变量（可选）：`VITE_BACKEND_URL` 显式指向 backend；不设则用代码里的 Railway prod fallback。

backend 那边记得把 future 的 origin 加到 `CORS_ALLOW_ORIGINS`（已添加 `https://shujian-future.pages.dev` + `http://localhost:5274`）。
