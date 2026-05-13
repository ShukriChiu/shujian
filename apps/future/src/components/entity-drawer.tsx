import { motion } from 'motion/react'
import { useEffect, useState } from 'react'
import { Trash2, X } from 'lucide-react'
import {
  BACKGROUND_HUE,
  PROJECT_STATUS_META,
  SKILL_META,
  STUDENT_STATUS_META,
  type Background,
  type Project,
  type SkillKey,
  type Student,
} from '../lib/types'

type StudentDraft = Omit<Student, 'id'>
type ProjectDraft = Omit<Project, 'id'>

type Props =
  | {
      kind: 'student'
      mode: 'create' | 'edit'
      initial?: Student
      onClose: () => void
      onSave: (s: StudentDraft, id?: string) => void
      onDelete?: (id: string) => void
    }
  | {
      kind: 'project'
      mode: 'create' | 'edit'
      initial?: Project
      onClose: () => void
      onSave: (p: ProjectDraft, id?: string) => void
      onDelete?: (id: string) => void
    }

export function EntityDrawer(props: Props) {
  return (
    <motion.div
      className="drawer-root"
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
    >
      <div className="drawer-backdrop" onClick={props.onClose} />
      <motion.section
        className="drawer-page"
        initial={{ x: '100%' }}
        animate={{ x: 0 }}
        exit={{ x: '100%' }}
        transition={{ type: 'spring', stiffness: 320, damping: 36 }}
      >
        <header className="drawer-head">
          <div>
            <p className="eyebrow">
              {props.kind === 'student' ? '学生档案' : '项目卷宗'} ·{' '}
              {props.mode === 'create' ? '新页' : '续修'}
            </p>
            <h2 className="drawer-title serif">
              {props.kind === 'student'
                ? props.mode === 'create'
                  ? '录入新学生'
                  : `编辑 ${props.initial?.name}`
                : props.mode === 'create'
                  ? '新建项目卷宗'
                  : `编辑 ${props.initial?.name}`}
            </h2>
          </div>
          <button
            type="button"
            className="drawer-close"
            onClick={props.onClose}
            aria-label="关闭"
          >
            <X size={18} />
          </button>
        </header>
        {props.kind === 'student' ? (
          <StudentForm {...props} />
        ) : (
          <ProjectForm {...props} />
        )}
      </motion.section>
    </motion.div>
  )
}

function StudentForm({
  initial,
  onClose,
  onSave,
  onDelete,
}: Extract<Props, { kind: 'student' }>) {
  const [draft, setDraft] = useState<StudentDraft>(() =>
    initial
      ? { ...initial }
      : {
          name: '',
          alias: '',
          initial: '',
          background: '产品设计',
          school: '中南大学',
          major: '',
          grade: '',
          skills: {},
          availability: '',
          status: 'pending',
          intro: '',
          joinedAt: new Date().toISOString().slice(0, 10),
        },
  )

  useEffect(() => {
    if (!draft.initial && draft.name) {
      setDraft((d) => ({ ...d, initial: draft.name.slice(0, 1) }))
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [draft.name])

  return (
    <form
      className="drawer-form"
      onSubmit={(e) => {
        e.preventDefault()
        if (!draft.name.trim()) return
        onSave(
          { ...draft, initial: draft.initial || draft.name.slice(0, 1) },
          initial?.id,
        )
        onClose()
      }}
    >
      <SectionLabel>身份</SectionLabel>
      <div className="form-row form-row-2">
        <Field label="姓名">
          <input
            value={draft.name}
            onChange={(e) => setDraft({ ...draft, name: e.target.value })}
            required
            placeholder="王悦"
          />
        </Field>
        <Field label="昵称 / 微信名">
          <input
            value={draft.alias ?? ''}
            onChange={(e) => setDraft({ ...draft, alias: e.target.value })}
            placeholder="小兑"
          />
        </Field>
      </div>

      <div className="form-row form-row-3">
        <Field label="背景方向">
          <select
            value={draft.background}
            onChange={(e) =>
              setDraft({ ...draft, background: e.target.value as Background })
            }
          >
            {Object.keys(BACKGROUND_HUE).map((b) => (
              <option key={b} value={b}>
                {b}
              </option>
            ))}
          </select>
        </Field>
        <Field label="学校">
          <input
            value={draft.school}
            onChange={(e) => setDraft({ ...draft, school: e.target.value })}
          />
        </Field>
        <Field label="年级">
          <input
            value={draft.grade}
            onChange={(e) => setDraft({ ...draft, grade: e.target.value })}
            placeholder="23 级（大三）"
          />
        </Field>
      </div>

      <div className="form-row form-row-2">
        <Field label="专业">
          <input
            value={draft.major}
            onChange={(e) => setDraft({ ...draft, major: e.target.value })}
            placeholder="产品设计"
          />
        </Field>
        <Field label="可投入时间">
          <input
            value={draft.availability}
            onChange={(e) => setDraft({ ...draft, availability: e.target.value })}
            placeholder="一周两天课，约 12 小时"
          />
        </Field>
      </div>

      <SectionLabel>当前状态</SectionLabel>
      <div className="status-row">
        {(Object.keys(STUDENT_STATUS_META) as Array<keyof typeof STUDENT_STATUS_META>).map(
          (s) => (
            <button
              key={s}
              type="button"
              className={`status-chip status-chip-${STUDENT_STATUS_META[s].tone} ${
                draft.status === s ? 'is-on' : ''
              }`}
              onClick={() => setDraft({ ...draft, status: s })}
            >
              <span className="serif">{STUDENT_STATUS_META[s].label}</span>
            </button>
          ),
        )}
      </div>

      <SectionLabel>能力评估（0-100，留空表示未知）</SectionLabel>
      <div className="skill-grid">
        {(Object.keys(SKILL_META) as SkillKey[]).map((skill) => (
          <label key={skill} className="skill-input">
            <span className="skill-input-label serif">{SKILL_META[skill].label}</span>
            <input
              type="number"
              min={0}
              max={100}
              value={draft.skills[skill] ?? ''}
              onChange={(e) => {
                const v = e.target.value === '' ? undefined : Number(e.target.value)
                setDraft({
                  ...draft,
                  skills: { ...draft.skills, [skill]: v },
                })
              }}
              placeholder="0"
            />
          </label>
        ))}
      </div>

      <SectionLabel>批注</SectionLabel>
      <textarea
        className="annotation"
        value={draft.intro}
        onChange={(e) => setDraft({ ...draft, intro: e.target.value })}
        placeholder="对 AI 信息流运营和软件产品设计有兴趣……"
        rows={4}
      />

      <DrawerFooter
        onDelete={initial && onDelete ? () => onDelete(initial.id) : undefined}
        onCancel={onClose}
      />
    </form>
  )
}

function ProjectForm({
  initial,
  onClose,
  onSave,
  onDelete,
}: Extract<Props, { kind: 'project' }>) {
  const [draft, setDraft] = useState<ProjectDraft>(() =>
    initial
      ? { ...initial }
      : {
          name: '',
          codename: 'NEW-OPS',
          source: '个人实验室',
          difficulty: 1,
          skillNeeds: {},
          teamSize: 3,
          status: 'recruiting',
          brief: '',
          nextMilestone: '',
          startedAt: new Date().toISOString().slice(0, 10),
        },
  )

  return (
    <form
      className="drawer-form"
      onSubmit={(e) => {
        e.preventDefault()
        if (!draft.name.trim()) return
        onSave(draft, initial?.id)
        onClose()
      }}
    >
      <SectionLabel>项目身份</SectionLabel>
      <div className="form-row form-row-2">
        <Field label="项目名称">
          <input
            value={draft.name}
            onChange={(e) => setDraft({ ...draft, name: e.target.value })}
            required
            placeholder="书剑 Future 自身"
          />
        </Field>
        <Field label="代号">
          <input
            value={draft.codename}
            onChange={(e) =>
              setDraft({ ...draft, codename: e.target.value.toUpperCase() })
            }
            placeholder="WAR ROOM"
          />
        </Field>
      </div>

      <div className="form-row form-row-3">
        <Field label="来源">
          <select
            value={draft.source}
            onChange={(e) =>
              setDraft({ ...draft, source: e.target.value as Project['source'] })
            }
          >
            {(['友联', '三诺', '趣学洋葱', '个人实验室', '外部合作'] as const).map(
              (s) => (
                <option key={s} value={s}>
                  {s}
                </option>
              ),
            )}
          </select>
        </Field>
        <Field label="难度">
          <select
            value={draft.difficulty}
            onChange={(e) =>
              setDraft({ ...draft, difficulty: Number(e.target.value) as 1 | 2 | 3 })
            }
          >
            <option value={1}>■□□ 入门</option>
            <option value={2}>■■□ 进阶</option>
            <option value={3}>■■■ 高挑战</option>
          </select>
        </Field>
        <Field label="队伍规模">
          <input
            type="number"
            min={1}
            max={8}
            value={draft.teamSize}
            onChange={(e) => setDraft({ ...draft, teamSize: Number(e.target.value) })}
          />
        </Field>
      </div>

      <SectionLabel>状态</SectionLabel>
      <div className="status-row">
        {(Object.keys(PROJECT_STATUS_META) as Array<keyof typeof PROJECT_STATUS_META>).map(
          (s) => (
            <button
              key={s}
              type="button"
              className={`status-chip status-chip-${PROJECT_STATUS_META[s].tone} ${
                draft.status === s ? 'is-on' : ''
              }`}
              onClick={() => setDraft({ ...draft, status: s })}
            >
              <span className="serif">{PROJECT_STATUS_META[s].label}</span>
            </button>
          ),
        )}
      </div>

      <SectionLabel>能力需求权重（合计建议接近 100）</SectionLabel>
      <div className="skill-grid">
        {(Object.keys(SKILL_META) as SkillKey[]).map((skill) => (
          <label key={skill} className="skill-input">
            <span className="skill-input-label serif">{SKILL_META[skill].label}</span>
            <input
              type="number"
              min={0}
              max={100}
              value={draft.skillNeeds[skill] ?? ''}
              onChange={(e) => {
                const v = e.target.value === '' ? undefined : Number(e.target.value)
                setDraft({
                  ...draft,
                  skillNeeds: { ...draft.skillNeeds, [skill]: v },
                })
              }}
              placeholder="0"
            />
          </label>
        ))}
      </div>

      <SectionLabel>项目要旨</SectionLabel>
      <textarea
        className="annotation"
        value={draft.brief}
        onChange={(e) => setDraft({ ...draft, brief: e.target.value })}
        rows={3}
      />

      <SectionLabel>下一里程碑</SectionLabel>
      <input
        className="full"
        value={draft.nextMilestone}
        onChange={(e) => setDraft({ ...draft, nextMilestone: e.target.value })}
        placeholder="6 月初输出第一版用户旅程图"
      />

      <DrawerFooter
        onDelete={initial && onDelete ? () => onDelete(initial.id) : undefined}
        onCancel={onClose}
      />
    </form>
  )
}

function SectionLabel({ children }: { children: React.ReactNode }) {
  return (
    <div className="section-label">
      <span className="section-label-rule" />
      <span className="serif">{children}</span>
      <span className="section-label-rule" />
    </div>
  )
}

function Field({
  label,
  children,
}: {
  label: string
  children: React.ReactNode
}) {
  return (
    <label className="field">
      <span className="field-label">{label}</span>
      {children}
    </label>
  )
}

function DrawerFooter({
  onDelete,
  onCancel,
}: {
  onDelete?: () => void
  onCancel: () => void
}) {
  return (
    <footer className="drawer-foot">
      {onDelete && (
        <button type="button" className="btn-danger" onClick={onDelete}>
          <Trash2 size={13} /> <span className="serif">删除</span>
        </button>
      )}
      <div className="drawer-foot-right">
        <button type="button" className="btn-line" onClick={onCancel}>
          <span className="serif">取消</span>
        </button>
        <button type="submit" className="btn-seal">
          <span className="serif">保存</span>
        </button>
      </div>
    </footer>
  )
}
