/**
 * Smoke test: spin up N parallel cloud agents on the SAME repo and verify
 * they actually run concurrently (each in their own isolated VM).
 *
 * Usage:
 *   CURSOR_API_KEY=crsr_... bun scripts/test-cloud-multi.ts
 *   N=4 bun scripts/test-cloud-multi.ts
 */
import { Agent } from '@cursor/sdk'

const apiKey = process.env.CURSOR_API_KEY
if (!apiKey) {
  console.error('CURSOR_API_KEY not set')
  process.exit(1)
}

const REPO = process.env.REPO_URL ?? 'https://github.com/ShukriChiu/onion-agent.git'
const STARTING_REF = process.env.REPO_REF ?? 'main'
const MODEL = process.env.MODEL ?? 'composer-2'
const N = Number(process.env.N ?? 3)

interface Task {
  label: string
  prompt: string
}

const TASKS: Task[] = [
  {
    label: 'A · 列代码结构',
    prompt: '用 ls + 简短文字列出本仓库 top-level 目录结构，告诉我每个目录大概是干什么的。不要写代码、不要修改文件，3 段话以内。',
  },
  {
    label: 'B · 找 TODO',
    prompt: '在仓库里搜一下所有 TODO/FIXME 注释，挑 3 个有意思的列出来（带文件路径和简短说明）。不要修改任何文件。',
  },
  {
    label: 'C · README 摘要',
    prompt: '读 README.md，用中文 3 句话总结这个项目是干什么的、它怎么用、目标用户是谁。不要修改任何文件。',
  },
  {
    label: 'D · 依赖盘点',
    prompt: '看 package.json / Cargo.toml / pyproject.toml 等任意依赖文件，列出 5 个最关键的依赖以及它们各自的作用。不要修改任何文件。',
  },
  {
    label: 'E · 测试现状',
    prompt: '检查这个项目有没有测试，有的话怎么跑、覆盖了哪些模块；没有的话给一个 30 秒可执行的最小测试方案。不要修改任何文件。',
  },
]

interface Stat {
  label: string
  agentId?: string
  runId?: string
  createMs?: number
  firstTokenMs?: number
  doneMs?: number
  status?: string
  events: number
  toolCalls: number
  textChunks: number
  err?: string
}

async function runOne(task: Task, t0: number): Promise<Stat> {
  const stat: Stat = { label: task.label, events: 0, toolCalls: 0, textChunks: 0 }
  try {
    const tCreate = Date.now()
    const agent = await Agent.create({
      apiKey: apiKey!,
      model: { id: MODEL },
      name: `multi-test-${task.label}`,
      cloud: {
        repos: [{ url: REPO, startingRef: STARTING_REF }],
        autoCreatePR: false,
      },
    })
    stat.agentId = agent.agentId
    stat.createMs = Date.now() - tCreate
    log(task.label, `agent created in ${stat.createMs}ms — ${agent.agentId}`)

    const tSend = Date.now()
    const run = await agent.send(task.prompt)
    stat.runId = run.id
    log(task.label, `run started: ${run.id}`)

    let firstTok = false
    for await (const ev of run.stream()) {
      stat.events++
      if (!firstTok && ev.type === 'assistant') {
        const hasText = ev.message.content.some((c) => c.type === 'text')
        if (hasText) {
          stat.firstTokenMs = Date.now() - tSend
          firstTok = true
          log(task.label, `first token at +${stat.firstTokenMs}ms`)
        }
      }
      if (ev.type === 'tool_call') stat.toolCalls++
      if (ev.type === 'assistant') {
        for (const c of ev.message.content) if (c.type === 'text') stat.textChunks++
      }
      if (ev.type === 'status') {
        log(task.label, `status: ${ev.status}`)
      }
    }
    const result = await run.wait()
    stat.doneMs = Date.now() - t0
    stat.status = result.status
    log(task.label, `done in ${stat.doneMs - (stat.createMs ?? 0)}ms · status=${result.status}`)
    try {
      await agent[Symbol.asyncDispose]()
    } catch {
      // best-effort cleanup
    }
  } catch (err) {
    stat.err = err instanceof Error ? err.message : String(err)
    log(task.label, `ERROR: ${stat.err}`)
  }
  return stat
}

function log(label: string, msg: string) {
  const ts = new Date().toISOString().slice(11, 23)
  console.log(`[${ts}] ${label.padEnd(18)} ${msg}`)
}

;(async () => {
  console.log(`▶ Cloud agent multi-session test`)
  console.log(`  repo:  ${REPO} @ ${STARTING_REF}`)
  console.log(`  model: ${MODEL}`)
  console.log(`  N:     ${N}`)
  console.log()

  const t0 = Date.now()
  const tasks = TASKS.slice(0, N)
  const stats = await Promise.all(tasks.map((t) => runOne(t, t0)))

  const total = Date.now() - t0
  console.log()
  console.log(`▶ Summary (wall clock ${total}ms)`)
  console.log(
    [
      'label'.padEnd(18),
      'create'.padStart(8),
      '1st-tok'.padStart(8),
      'wall'.padStart(8),
      'evt'.padStart(5),
      'tool'.padStart(5),
      'text'.padStart(5),
      'status'.padStart(10),
    ].join('  '),
  )
  console.log('-'.repeat(78))
  for (const s of stats) {
    console.log(
      [
        s.label.padEnd(18),
        String(s.createMs ?? '—').padStart(8),
        String(s.firstTokenMs ?? '—').padStart(8),
        String(s.doneMs ?? '—').padStart(8),
        String(s.events).padStart(5),
        String(s.toolCalls).padStart(5),
        String(s.textChunks).padStart(5),
        String(s.status ?? s.err?.slice(0, 10) ?? '—').padStart(10),
      ].join('  '),
    )
  }

  // sanity: were they actually concurrent?
  const slowest = Math.max(...stats.map((s) => s.doneMs ?? 0))
  const sumSerial = stats.reduce((a, s) => a + (s.doneMs ?? 0), 0)
  console.log()
  console.log(`▶ Concurrency: wall ${total}ms vs sum-of-individuals ${sumSerial}ms`)
  console.log(`  → speedup ${(sumSerial / Math.max(total, 1)).toFixed(2)}x (1.0 = serial, ${N}.0 = perfect parallel)`)
  console.log(`  → slowest single ${slowest}ms`)

  process.exit(stats.every((s) => s.status === 'finished') ? 0 : 1)
})()
