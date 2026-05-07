import { ARTIFACTS, type ArtifactBundle, type ArtifactKind } from './mock-data'

/**
 * Heuristic intent detector. Real Cloud SDK calls would replace this with
 * agent-driven tool selection — until then, keyword matching is good enough
 * to make the demo feel like an agent that "knows" the business.
 */
const INTENT_RULES: Array<{ kind: ArtifactKind; keywords: RegExp }> = [
  {
    kind: 'staff',
    keywords:
      /(员工|教师|老师|绩效|kpi|续费率|师资|分配|哪些老师|谁的)/i,
  },
  {
    kind: 'unconsumed',
    keywords:
      /(未消课时|未消|课时|课包|负债|到期|存量|消课)/i,
  },
  {
    kind: 'refund',
    keywords:
      /(退款|退费|退课|流失|退掉|为什么退|退款率|退款原因)/i,
  },
  {
    kind: 'revenue',
    keywords:
      /(营收|收入|总营收|gmv|q3|季度|营收情况|业务情况|这季度|本季度|整体)/i,
  },
]

export interface MockTurnEvent {
  type: 'thinking' | 'tool_start' | 'tool_done' | 'text' | 'artifact' | 'done'
  delayMs: number
  payload?: unknown
}

export interface MockPlan {
  bundle: ArtifactBundle
  events: MockTurnEvent[]
}

/**
 * Pick an artifact for the user prompt. Returns null if nothing matched —
 * the workspace then falls back to a generic "I don't know yet" reply.
 */
export function planFromPrompt(prompt: string): MockPlan | null {
  const lower = prompt.toLowerCase()
  for (const rule of INTENT_RULES) {
    if (rule.keywords.test(lower)) {
      return planFor(rule.kind, prompt)
    }
  }
  return null
}

function planFor(kind: ArtifactKind, prompt: string): MockPlan {
  const bundle = ARTIFACTS[kind]

  /**
   * Synthesize a ~2.5s "stream" with realistic phasing:
   *   thinking → tool_start → tool_done → artifact → narrative chunks → done
   *
   * Each chunk's delayMs is the gap *after* the previous step, mimicking
   * the cadence of a real LLM. Tweak these to feel natural without dragging.
   */
  const events: MockTurnEvent[] = [
    {
      type: 'thinking',
      delayMs: 240,
      payload: {
        text: `用户问的是 ${bundleHint(kind)}，需要查询 vaults 数据库里的 ${vaultHint(kind)}。`,
      },
    },
    {
      type: 'thinking',
      delayMs: 380,
      payload: {
        text: ` 维度对齐 Q3 2025；先用聚合查询取核心指标，再按子维度展开。`,
      },
    },
    {
      type: 'tool_start',
      delayMs: 320,
      payload: {
        callId: `call_${kind}`,
        name: 'query_business',
        args: { topic: kind, period: 'Q3 2025', source: 'vaults' },
      },
    },
    {
      type: 'tool_done',
      delayMs: 720,
      payload: {
        callId: `call_${kind}`,
        result: { kind, summary: bundle.summary, rows: bundle.kind === 'staff' ? 7 : 5 },
      },
    },
    {
      type: 'artifact',
      delayMs: 80,
      payload: bundle,
    },
    // Stream the narrative in 4 chunks for that "alive" feel.
    ...narrativeChunks(bundle.narrative, kind, prompt),
    { type: 'done', delayMs: 80 },
  ]

  return { bundle, events }
}

function narrativeChunks(text: string, kind: ArtifactKind, prompt: string): MockTurnEvent[] {
  void kind
  void prompt
  const sentences = text.split(/(?<=。|\n\n)/g).filter(Boolean)
  if (sentences.length <= 4) {
    return sentences.map((s) => ({
      type: 'text' as const,
      delayMs: 220,
      payload: { text: s },
    }))
  }
  // group into ~4 chunks for snappy streaming feel
  const groupSize = Math.ceil(sentences.length / 4)
  const groups: string[] = []
  for (let i = 0; i < sentences.length; i += groupSize) {
    groups.push(sentences.slice(i, i + groupSize).join(''))
  }
  return groups.map((s) => ({
    type: 'text' as const,
    delayMs: 240,
    payload: { text: s },
  }))
}

function bundleHint(kind: ArtifactKind): string {
  switch (kind) {
    case 'revenue':
      return '本季度家教业务整体营收情况'
    case 'refund':
      return '退款的金额、原因与高退款班次'
    case 'unconsumed':
      return '未消课时的存量结构与到期分布'
    case 'staff':
      return '老师的绩效与续费/退款表现'
  }
}

function vaultHint(kind: ArtifactKind): string {
  switch (kind) {
    case 'revenue':
      return '订单宽表 + 退款流水 + 排课台账'
    case 'refund':
      return '退款流水 + 工单原因标签 + 班级映射'
    case 'unconsumed':
      return '课包余额表 + 排课计划表 + 学员状态'
    case 'staff':
      return '教师绩效宽表 + 班级匹配 + 续费日志'
  }
}
