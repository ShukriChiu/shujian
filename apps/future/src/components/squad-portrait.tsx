import { useEffect, useMemo, useState } from 'react'
import { motion, AnimatePresence } from 'motion/react'
import { SKILL_META, type Project, type SkillKey, type Student } from '../lib/types'

type Props = {
  project: Project
  members: Student[]
  variant?: 'inline' | 'spread'
}

function computeCoverage(project: Project, members: Student[]) {
  const result: Array<{ skill: SkillKey; need: number; covered: number }> = []
  for (const [skill, weight] of Object.entries(project.skillNeeds) as Array<
    [SkillKey, number]
  >) {
    const totalProficiency = members.reduce(
      (sum, member) => sum + (member.skills[skill] ?? 0),
      0,
    )
    const expected = weight * Math.max(project.teamSize, 1)
    const covered = Math.min(100, Math.round((totalProficiency / expected) * 100))
    result.push({ skill, need: weight, covered })
  }
  return result
}

export function SquadPortrait({ project, members, variant = 'inline' }: Props) {
  const coverage = useMemo(() => computeCoverage(project, members), [project, members])
  const overall = coverage.length
    ? Math.round(coverage.reduce((a, b) => a + b.covered, 0) / coverage.length)
    : 0

  if (members.length === 0) return null

  return (
    <motion.section
      className={`portrait portrait-${variant}`}
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, y: 4 }}
      transition={{ duration: 0.5, ease: [0.16, 1, 0.3, 1] }}
    >
      <header className="portrait-head">
        <div className="portrait-title-block">
          <p className="eyebrow">队伍构成</p>
          <h4 className="portrait-overall serif">
            <span className="portrait-overall-num mono">{overall}</span>
            <span className="portrait-overall-unit">% 覆盖</span>
          </h4>
        </div>
        <ChemistryBadge members={members} />
      </header>

      <ul className="coverage-list">
        <AnimatePresence initial={false}>
          {coverage.map(({ skill, covered }, i) => (
            <CoverageRow key={skill} skill={skill} value={covered} delay={i * 0.05} />
          ))}
        </AnimatePresence>
      </ul>
    </motion.section>
  )
}

function CoverageRow({
  skill,
  value,
  delay,
}: {
  skill: SkillKey
  value: number
  delay: number
}) {
  const [target, setTarget] = useState(0)
  useEffect(() => {
    const t = setTimeout(() => setTarget(value), delay * 1000 + 60)
    return () => clearTimeout(t)
  }, [value, delay])

  const meta = SKILL_META[skill]
  const tier = value >= 90 ? 'full' : value >= 60 ? 'solid' : value >= 30 ? 'partial' : 'thin'

  return (
    <motion.li
      layout
      className={`coverage-row coverage-${tier}`}
      style={{
        ['--coverage' as string]: `${target}%`,
        ['--hue' as string]: meta.hue,
      }}
      initial={{ opacity: 0, x: -6 }}
      animate={{ opacity: 1, x: 0 }}
      transition={{ delay: delay + 0.05, duration: 0.4, ease: [0.16, 1, 0.3, 1] }}
    >
      <span className="coverage-label serif">{meta.label}</span>
      <span className="coverage-track">
        <span className="coverage-fill" />
      </span>
      <span className="coverage-value mono">{Math.round(target)}</span>
    </motion.li>
  )
}

function ChemistryBadge({ members }: { members: Student[] }) {
  const backgrounds = Array.from(new Set(members.map((m) => m.background)))
  if (backgrounds.length < 2) {
    return (
      <span className="chemistry-pill chemistry-mono">
        <span className="serif">单一背景</span>
        <span className="mono">·{backgrounds[0] ?? ''}</span>
      </span>
    )
  }
  return (
    <span className="chemistry-pill chemistry-cross">
      <span className="serif">跨界 ×{backgrounds.length}</span>
    </span>
  )
}
