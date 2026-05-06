import { useQuery } from '@tanstack/react-query'
import { agentApi, cursorApi } from '@/lib/api'
import { ErrorBanner, Panel } from '@/components/Panel'

function KV({ label, value }: { label: string; value: string }) {
  return (
    <div className="grid grid-cols-[140px_1fr] items-center gap-3 border-b border-ink-100 px-5 py-2 text-xs">
      <div className="text-ink-500">{label}</div>
      <div className="font-mono text-ink-800 break-all">{value}</div>
    </div>
  )
}

export function SettingsView() {
  const health = useQuery({ queryKey: ['agent', 'health'], queryFn: agentApi.health })
  const me = useQuery({ queryKey: ['cursor', 'me'], queryFn: cursorApi.me, retry: 0 })
  const meta = useQuery({ queryKey: ['cursor', 'meta'], queryFn: cursorApi.meta, retry: 0 })

  return (
    <div className="space-y-5">
      <Panel
        title="shujian-agent (Rust)"
        sub="作为本地 daemon 跑：cargo run -- daemon"
      >
        {health.error ? (
          <ErrorBanner error={health.error} />
        ) : health.data ? (
          <div>
            <KV label="状态" value={health.data.status} />
            <KV label="版本" value={`v${health.data.version}`} />
            <KV label="Agents" value={health.data.agents.join(', ')} />
            <KV label="HTTP" value="http://localhost:8002 → 通过 Vite /api 代理" />
          </div>
        ) : (
          <div className="px-5 py-4 text-xs text-ink-500">加载中…</div>
        )}
      </Panel>

      <Panel
        title="cursor-bridge (Node)"
        sub="@cursor/sdk 的 HTTP/SSE 边车"
      >
        {me.error ? (
          <div className="space-y-2 px-5 py-4 text-xs text-ink-500">
            <div>未连接 ·{' '}
              <code className="rounded bg-ink-100 px-1.5 py-0.5 text-[11px]">
                cd shujian-agent/cursor-bridge && bun run dev
              </code>
            </div>
            <div className="text-[11px]">{(me.error as Error).message}</div>
          </div>
        ) : (
          <div>
            <KV label="HTTP" value="http://localhost:8003 → 通过 Vite /cursor 代理" />
            {meta.data && <KV label="活跃 agents" value={String(meta.data.activeAgents)} />}
            {meta.data && <KV label="活跃 runs" value={String(meta.data.activeRuns)} />}
            {me.data && <KV label="API key" value={me.data.apiKeyName} />}
            {me.data?.userEmail && <KV label="账户" value={me.data.userEmail} />}
            {me.data && <KV label="创建于" value={me.data.createdAt} />}
          </div>
        )}
      </Panel>

      <Panel title="架构" sub="三个进程，端口都本地">
        <div className="space-y-3 px-5 py-4 text-xs text-ink-700">
          <pre className="rounded-md border border-ink-200 bg-ink-50 p-3 font-mono leading-relaxed text-ink-700">{`┌──────────────────────────────────────┐
│  shujian-dashboard  (Vite, :5273)    │  ← 你看的这个
└──────┬─────────────────────┬─────────┘
       │ /api proxy          │ /cursor proxy
       ▼                     ▼
┌──────────────┐      ┌────────────────────┐
│ shujian-agent│      │  cursor-bridge      │
│   Rust :8002 │      │  Node :8003         │
│              │      │  @cursor/sdk        │
└──────────────┘      └────────────────────┘
       │                       │
       │                       ▼
       ▼               ┌────────────────────┐
   触发器/工具          │  Cursor Cloud /    │
   Supabase            │  本地 Cursor agent  │
                       └────────────────────┘
`}</pre>
          <p className="text-ink-600">
            <b>Rust</b> 跑预设的、定时的、内部业务用的数字员工（document_clerk / inventory_watcher
            等）。<b>Cursor</b> 跑需要直接动 IDE / 仓库 / 改代码的事，无论本机还是云端。
          </p>
        </div>
      </Panel>

      <Panel title="开发命令" sub="一键起三个进程">
        <pre className="m-5 overflow-x-auto rounded-md border border-ink-200 bg-ink-950 p-4 font-mono text-[11px] leading-relaxed text-emerald-200">{`# 终端 1 — Rust agent
cd shujian-agent
cargo run -- daemon

# 终端 2 — Cursor SDK 边车
cd shujian-agent/cursor-bridge
bun install
bun run dev

# 终端 3 — 这个 dashboard
cd shujian-dashboard
bun install
bun run dev    # → http://localhost:5273`}</pre>
      </Panel>
    </div>
  )
}
