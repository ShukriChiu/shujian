import { motion } from 'motion/react'
import {
  ArrowLeft,
  CalendarClock,
  Compass,
  MessageCircle,
  Sparkles,
  Trash2,
  X,
} from 'lucide-react'
import {
  PROJECT_STATUS_META,
  SIGNAL_META,
  SKILL_META,
  type Feedback,
  type Project,
  type SkillKey,
  type Student,
} from '../lib/types'
import { SquadPortrait } from './squad-portrait'

type Props = {
  project: Project
  members: Student[]
  feedback: Feedback[]
  onClose: () => void
  onRemoveMember: (studentId: string) => void
  onAddFeedback: (f: Omit<Feedback, 'id' | 'projectId'>) => void
}

export function TheatreView({
  project,
  members,
  feedback,
  onClose,
  onRemoveMember,
  onAddFeedback,
}: Props) {
  const status = PROJECT_STATUS_META[project.status]
  const projectFeedback = feedback.filter((f) => f.projectId === project.id)

  return (
    <motion.div
      className="interior"
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      transition={{ duration: 0.3 }}
    >
      <div className="interior-backdrop" onClick={onClose} />

      <motion.section
        className={`interior-page interior-${status.tone}`}
        style={{ viewTransitionName: `lane-${project.id}` } as React.CSSProperties}
        initial={{ y: 30, opacity: 0 }}
        animate={{ y: 0, opacity: 1 }}
        exit={{ y: 16, opacity: 0 }}
        transition={{ duration: 0.5, ease: [0.16, 1, 0.3, 1] }}
      >
        <header className="interior-head">
          <button type="button" className="interior-back" onClick={onClose}>
            <ArrowLeft size={14} /> <span className="serif">返回卷宗目录</span>
          </button>
          <span className={`status-seal status-seal-${status.tone}`}>
            {status.label}
          </span>
          <button
            type="button"
            className="interior-close"
            onClick={onClose}
            aria-label="关闭"
          >
            <X size={16} />
          </button>
        </header>

        <div className="interior-masthead">
          <p className="eyebrow">代号 · {project.codename}</p>
          <h1 className="interior-title serif">{project.name}</h1>
          <p className="interior-brief">{project.brief}</p>
          <div className="interior-rule" />
        </div>

        <div className="interior-grid">
          <section className="interior-section">
            <h3 className="interior-section-title">
              <Compass size={14} />
              <span className="serif">项目结构</span>
            </h3>
            <dl className="interior-meta">
              <div>
                <dt>来源</dt>
                <dd className="serif">{project.source}</dd>
              </div>
              <div>
                <dt>难度</dt>
                <dd className="mono">
                  {'■'.repeat(project.difficulty)}
                  {'□'.repeat(3 - project.difficulty)}
                </dd>
              </div>
              <div>
                <dt>队伍规模</dt>
                <dd className="mono">
                  {members.length} / {project.teamSize}
                </dd>
              </div>
              <div>
                <dt>启动日期</dt>
                <dd className="mono">{project.startedAt}</dd>
              </div>
            </dl>
            <div className="needs-grid">
              {(Object.entries(project.skillNeeds) as Array<[SkillKey, number]>).map(
                ([skill, weight]) => (
                  <div
                    key={skill}
                    className="need-tile"
                    style={{ ['--hue' as string]: SKILL_META[skill].hue }}
                  >
                    <span className="need-tile-label serif">
                      {SKILL_META[skill].label}
                    </span>
                    <span className="need-tile-weight mono">{weight}</span>
                  </div>
                ),
              )}
            </div>
          </section>

          <section className="interior-section">
            <h3 className="interior-section-title">
              <CalendarClock size={14} />
              <span className="serif">下一里程碑</span>
            </h3>
            <p className="next-milestone serif">
              {project.nextMilestone || '尚未设定'}
            </p>
          </section>

          <section className="interior-section interior-section-wide">
            <h3 className="interior-section-title">
              <Sparkles size={14} />
              <span className="serif">当前小队</span>
            </h3>
            {members.length > 0 && (
              <div className="interior-portrait">
                <SquadPortrait project={project} members={members} variant="spread" />
              </div>
            )}
            {members.length === 0 ? (
              <p className="interior-empty">
                还没有人加入这个项目。回到卷宗目录把学生拖进来。
              </p>
            ) : (
              <ul className="member-list">
                {members.map((m) => (
                  <li key={m.id} className="member-row">
                    <div className="member-avatar serif">{m.initial}</div>
                    <div className="member-meta">
                      <strong className="serif">
                        {m.name}
                        {m.alias && (
                          <span className="member-alias mono">·{m.alias}</span>
                        )}
                      </strong>
                      <span className="mono">
                        {m.school} · {m.major} · {m.grade}
                      </span>
                      <span className="member-intro">{m.intro}</span>
                    </div>
                    <button
                      type="button"
                      className="member-remove"
                      onClick={() => onRemoveMember(m.id)}
                      aria-label={`从此项目移除 ${m.name}`}
                    >
                      <Trash2 size={13} />
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </section>

          <section className="interior-section interior-section-wide">
            <h3 className="interior-section-title">
              <MessageCircle size={14} />
              <span className="serif">反馈时间线</span>
            </h3>
            <FeedbackComposer members={members} onSubmit={onAddFeedback} />
            {projectFeedback.length === 0 ? (
              <p className="interior-empty">
                还没有反馈。每周写一条，长期看出谁值得重点投入。
              </p>
            ) : (
              <ol className="timeline">
                {projectFeedback.map((f) => {
                  const sig = SIGNAL_META[f.signal]
                  const member = members.find((m) => m.id === f.studentId)
                  return (
                    <li key={f.id} className={`timeline-item timeline-${sig.tone}`}>
                      <div className="timeline-spine" />
                      <div className="timeline-card">
                        <header>
                          <span className="timeline-date mono">{f.date}</span>
                          <span className={`timeline-signal timeline-signal-${sig.tone}`}>
                            {sig.label}
                          </span>
                          {member && (
                            <span className="timeline-who serif">{member.name}</span>
                          )}
                        </header>
                        <p>{f.notes}</p>
                      </div>
                    </li>
                  )
                })}
              </ol>
            )}
          </section>
        </div>
      </motion.section>
    </motion.div>
  )
}

function FeedbackComposer({
  members,
  onSubmit,
}: {
  members: Student[]
  onSubmit: (f: Omit<Feedback, 'id' | 'projectId'>) => void
}) {
  return (
    <form
      className="feedback-form"
      onSubmit={(e) => {
        e.preventDefault()
        const fd = new FormData(e.currentTarget)
        const studentId = String(fd.get('studentId') ?? members[0]?.id ?? '')
        const signal = String(fd.get('signal') ?? 'shipping') as Feedback['signal']
        const notes = String(fd.get('notes') ?? '').trim()
        if (!studentId || !notes) return
        onSubmit({
          studentId,
          signal,
          notes,
          date: new Date().toISOString().slice(0, 10),
        })
        e.currentTarget.reset()
      }}
    >
      <select name="studentId" disabled={members.length === 0}>
        {members.length === 0 ? (
          <option>先加入队员</option>
        ) : (
          members.map((m) => (
            <option key={m.id} value={m.id}>
              {m.name}
            </option>
          ))
        )}
      </select>
      <select name="signal" defaultValue="shipping">
        <option value="shipping">执行稳定</option>
        <option value="learning">学习快</option>
        <option value="breakthrough">突破时刻</option>
        <option value="needs_followup">需要跟进</option>
      </select>
      <input name="notes" type="text" placeholder="一句话反馈" />
      <button
        type="submit"
        className="btn-seal feedback-submit"
        disabled={members.length === 0}
      >
        记一笔
      </button>
    </form>
  )
}
