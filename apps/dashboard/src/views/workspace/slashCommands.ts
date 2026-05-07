/**
 * Workspace composer slash commands.
 *
 * When the user types `/` at the start of the composer (or after a
 * newline) we show a palette of these commands. Picking one expands the
 * `template` into the composer in place of the slash trigger.
 *
 * These map to the brain's "skills" (`.agents/skills/...`) the user has
 * documented in `AGENTS.md` — sending the slug as a fenced reference
 * gives the cloud agent a deterministic hook the system prompt can teach
 * it to obey ("if you see /<slug> in the user message, activate that skill").
 *
 * Storage: a hardcoded baseline + user overrides in localStorage so power
 * users can grow the list without a redeploy. Keep entries terse — the
 * palette is not the place for a doc page.
 */

const STORAGE_KEY = 'shujian.workspace.slash-commands.v1'

export interface SlashCommand {
  /** Lowercase, no spaces — what the user types after `/`. */
  slug: string
  /** Short label shown in the palette next to the slug. */
  label: string
  /** One-line description rendered under the label. */
  hint: string
  /**
   * The text inserted into the composer on select. If it contains the
   * literal `{cursor}`, the textarea cursor lands there after expansion;
   * otherwise the cursor is placed at the end.
   */
  template: string
  /** Optional emoji or short glyph shown left of the label. */
  glyph?: string
}

const BUILTINS: SlashCommand[] = [
  {
    slug: 'data',
    label: 'data',
    hint: '从数据库取数据 — 自动走 DATABASE.md 的口径',
    template: '基于 DATABASE.md 的口径，帮我查 {cursor}',
    glyph: '📊',
  },
  {
    slug: 'explain',
    label: 'explain',
    hint: '解释一段代码 / 一个概念 / 一份数据',
    template: '解释 {cursor}',
    glyph: '💡',
  },
  {
    slug: 'audit',
    label: 'audit',
    hint: '激活 audit skill：审视 UI / 数据 / 流程',
    template: '调用 audit skill 审视：{cursor}',
    glyph: '🔍',
  },
  {
    slug: 'critique',
    label: 'critique',
    hint: '激活 critique skill：UX 评审',
    template: '调用 critique skill 评审：{cursor}',
    glyph: '🎨',
  },
  {
    slug: 'plan',
    label: 'plan',
    hint: '先规划再动手 — 列任务 / 跑 todo list',
    template:
      '先列一个 todo list 再动手。任务：{cursor}',
    glyph: '🗺️',
  },
  {
    slug: 'sub',
    label: 'sub',
    hint: '让你 spawn 一个 subagent 处理',
    template: '开一个 subagent 来处理：{cursor}',
    glyph: '🧩',
  },
  {
    slug: 'thought',
    label: 'thought',
    hint: '激活 shujian-thought：对抗性思考',
    template: '用 shujian-thought 对抗性思考一下：{cursor}',
    glyph: '🧠',
  },
  {
    slug: 'memory',
    label: 'memory',
    hint: '激活 brain-memory：写入 / 检索长期记忆',
    template: '调用 brain-memory：{cursor}',
    glyph: '🗃️',
  },
  {
    slug: 'health',
    label: 'health',
    hint: '激活 shujian-health：拉 Oura / 解读身体数据',
    template: '调用 shujian-health：{cursor}',
    glyph: '❤️',
  },
]

function readUser(): SlashCommand[] {
  if (typeof window === 'undefined') return []
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY)
    if (!raw) return []
    const parsed = JSON.parse(raw) as Partial<SlashCommand>[]
    return parsed
      .filter(
        (c): c is SlashCommand =>
          !!c?.slug && !!c.label && !!c.hint && !!c.template,
      )
      .map((c) => ({ ...c, slug: c.slug.toLowerCase() }))
  } catch {
    return []
  }
}

/** All commands, user overrides taking precedence on slug collision. */
export function listSlashCommands(): SlashCommand[] {
  const user = readUser()
  const slugs = new Set(user.map((c) => c.slug))
  return [...user, ...BUILTINS.filter((c) => !slugs.has(c.slug))]
}

/** Filter the command list by `query` (the text after `/`). */
export function filterSlashCommands(query: string): SlashCommand[] {
  const q = query.toLowerCase().trim()
  const all = listSlashCommands()
  if (!q) return all
  return all.filter(
    (c) =>
      c.slug.startsWith(q) || c.label.toLowerCase().includes(q) || c.hint.toLowerCase().includes(q),
  )
}

/**
 * Detect the current `/` trigger. Returns the slug query and the slice
 * of `value` that should be replaced (`[start, end]`) when a command
 * is picked. Returns `null` if no slash is active.
 *
 * Triggers when:
 *   - cursor is inside or right after a `/<word>` token
 *   - the slash is at the very start of the composer or right after
 *     whitespace / a newline (so URLs don't accidentally trigger)
 */
export function detectSlashTrigger(
  value: string,
  selectionStart: number,
): { query: string; start: number; end: number } | null {
  if (!value || selectionStart < 0) return null
  // walk backwards from cursor to find a `/` not preceded by a non-space/non-newline char
  let i = selectionStart
  while (i > 0) {
    const ch = value[i - 1]!
    if (ch === '\n' || ch === ' ' || ch === '\t') return null
    if (ch === '/') {
      // ensure the slash itself starts a token
      const before = i >= 2 ? value[i - 2] : null
      if (before === null || before === ' ' || before === '\n' || before === '\t') {
        const slashAt = i - 1
        // walk forward to capture the word continuation
        let j = selectionStart
        while (j < value.length) {
          const c = value[j]!
          if (c === ' ' || c === '\n' || c === '\t') break
          j++
        }
        return {
          query: value.slice(slashAt + 1, j),
          start: slashAt,
          end: j,
        }
      }
      return null
    }
    i--
  }
  return null
}
