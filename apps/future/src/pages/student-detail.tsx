import { useEffect, useState } from 'react'
import { Link, useNavigate, useParams } from 'react-router-dom'
import {
  useMutation,
  useQuery,
  useQueryClient,
} from '@tanstack/react-query'
import { backend } from '../lib/backend'
import { StatusPill } from '../components/status-pill'
import {
  ASSIGNMENT_STATUS_META,
  GRADE_YEAR_META,
  GRADE_YEAR_ORDER,
  NOTE_KIND_META,
  PROJECT_STATUS_META,
  STUDENT_STATUS_META,
  STUDENT_STATUS_ORDER,
  type FutureGradeYear,
  type FutureNoteKind,
  type FutureStudentDetail,
  type FutureStudentStatus,
  type FutureUpdateStudent,
} from '../lib/types'

export function StudentDetailPage() {
  const { id = '' } = useParams<{ id: string }>()
  const navigate = useNavigate()
  const qc = useQueryClient()

  const detail = useQuery({
    queryKey: ['students.get', id],
    queryFn: () => backend.students.get(id),
    enabled: !!id,
  })

  if (detail.isLoading) {
    return <p style={{ color: 'var(--muted)' }}>加载中…</p>
  }
  if (detail.isError) {
    return (
      <div>
        <Link to="/students" style={{ fontSize: 13, color: 'var(--muted)' }}>
          ← 返回列表
        </Link>
        <p
          style={{
            color: 'var(--vermilion-deep)',
            background: 'var(--vermilion-soft)',
            padding: 12,
            borderRadius: 'var(--radius-sm)',
            marginTop: 12,
          }}
        >
          {(detail.error as Error).message}
        </p>
      </div>
    )
  }

  const student = detail.data!

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 24 }}>
      <Link
        to="/students"
        style={{
          fontSize: 12,
          color: 'var(--muted)',
          textDecoration: 'none',
          width: 'fit-content',
        }}
      >
        ← 返回列表
      </Link>

      <Header
        student={student}
        onArchive={async () => {
          if (!confirm(`确定归档 ${student.fullName}？数据保留，只是不在默认列表显示。`)) return
          await backend.students.archive(id)
          await qc.invalidateQueries({ queryKey: ['students.list'] })
          navigate('/students')
        }}
      />

      <Grid>
        <IntakePanel student={student} onSaved={() => detail.refetch()} />
        <SidePanel student={student} onChanged={() => detail.refetch()} />
      </Grid>

      <AssignmentsPanel studentId={id} />

      <NotesPanel studentId={id} />
    </div>
  )
}

// ─── Header (name + status quick-change) ──────────────────────────────

function Header({
  student,
  onArchive,
}: {
  student: FutureStudentDetail
  onArchive: () => void
}) {
  const qc = useQueryClient()
  const meta = STUDENT_STATUS_META[student.status]

  const setStatus = useMutation({
    mutationFn: (status: FutureStudentStatus) =>
      backend.students.update(student.id, { status }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['students.get', student.id] })
      qc.invalidateQueries({ queryKey: ['students.list'] })
    },
  })

  return (
    <header
      style={{
        display: 'flex',
        alignItems: 'flex-start',
        justifyContent: 'space-between',
        gap: 24,
        flexWrap: 'wrap',
      }}
    >
      <div>
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 12,
            flexWrap: 'wrap',
          }}
        >
          <h1
            className="serif"
            style={{
              margin: 0,
              fontSize: 28,
              color: 'var(--ink)',
              letterSpacing: '-0.012em',
            }}
          >
            {student.fullName}
          </h1>
          <StatusPill tone={meta.tone} label={meta.label} />
        </div>
        <p
          style={{
            margin: '6px 0 0',
            fontSize: 13,
            color: 'var(--muted)',
          }}
        >
          {[student.university, student.major, GRADE_YEAR_META[student.gradeYear]]
            .filter(Boolean)
            .join(' · ')}
        </p>
        <p
          className="mono"
          style={{ fontSize: 11, color: 'var(--faint)', margin: '6px 0 0' }}
        >
          提交于 {fmtDateTime(student.submittedAt)}
          {student.reviewedAt && ` · 首次审阅于 ${fmtDateTime(student.reviewedAt)}`}
        </p>
      </div>
      <div
        style={{ display: 'flex', flexDirection: 'column', gap: 8, alignItems: 'flex-end' }}
      >
        <select
          value={student.status}
          onChange={(e) =>
            setStatus.mutate(e.target.value as FutureStudentStatus)
          }
          disabled={setStatus.isPending}
          style={{
            padding: '8px 12px',
            fontSize: 13,
            color: 'var(--ink)',
            background: 'var(--leaf)',
            border: '1px solid var(--hairline-strong)',
            borderRadius: 'var(--radius-sm)',
          }}
        >
          {STUDENT_STATUS_ORDER.map((s) => (
            <option key={s} value={s}>
              切换到「{STUDENT_STATUS_META[s].label}」
            </option>
          ))}
        </select>
        <button
          onClick={onArchive}
          style={{
            fontSize: 11,
            color: 'var(--muted)',
            padding: '4px 10px',
            border: '1px solid var(--hairline-soft)',
            borderRadius: 'var(--radius-sm)',
          }}
        >
          归档
        </button>
      </div>
    </header>
  )
}

// ─── Layout ───────────────────────────────────────────────────────────

function Grid({ children }: { children: React.ReactNode }) {
  return (
    <div
      style={{
        display: 'grid',
        gridTemplateColumns: 'minmax(0, 2fr) minmax(280px, 1fr)',
        gap: 20,
        alignItems: 'flex-start',
      }}
    >
      {children}
    </div>
  )
}

function Card({
  title,
  desc,
  right,
  children,
}: {
  title: string
  desc?: string
  right?: React.ReactNode
  children: React.ReactNode
}) {
  return (
    <section
      style={{
        background: 'var(--leaf)',
        border: '1px solid var(--hairline)',
        borderRadius: 'var(--radius-lg)',
        padding: 20,
        display: 'flex',
        flexDirection: 'column',
        gap: 16,
      }}
    >
      <header
        style={{
          display: 'flex',
          alignItems: 'flex-end',
          justifyContent: 'space-between',
          gap: 8,
        }}
      >
        <div>
          <h2
            className="serif"
            style={{ margin: 0, fontSize: 16, color: 'var(--ink)' }}
          >
            {title}
          </h2>
          {desc && (
            <p
              style={{
                margin: '2px 0 0',
                fontSize: 11.5,
                color: 'var(--muted)',
              }}
            >
              {desc}
            </p>
          )}
        </div>
        {right}
      </header>
      {children}
    </section>
  )
}

// ─── Intake panel — editable ──────────────────────────────────────────

function IntakePanel({
  student,
  onSaved,
}: {
  student: FutureStudentDetail
  onSaved: () => void
}) {
  const [edit, setEdit] = useState<FutureUpdateStudent>({})
  const [saving, setSaving] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const dirty = Object.keys(edit).length > 0

  // Reset edit buffer when the underlying student changes (e.g. after refetch).
  useEffect(() => {
    setEdit({})
  }, [student.updatedAt])

  function set<K extends keyof FutureUpdateStudent>(k: K, v: FutureUpdateStudent[K]) {
    setEdit((e) => {
      const next = { ...e, [k]: v }
      if (next[k] === student[k as keyof FutureStudentDetail]) {
        delete next[k]
      }
      return next
    })
  }

  async function save() {
    if (!dirty) return
    setSaving(true)
    setErr(null)
    try {
      await backend.students.update(student.id, edit)
      onSaved()
      setEdit({})
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'save failed')
    } finally {
      setSaving(false)
    }
  }

  function val<K extends keyof FutureStudentDetail>(k: K): string {
    const candidate =
      k in edit ? (edit as Record<string, unknown>)[k as string] : student[k]
    return typeof candidate === 'string' ? candidate : ''
  }

  return (
    <Card
      title="申请信息"
      desc="学生提交的内容；可以直接编辑，例如纠正打字错误"
      right={
        <div style={{ display: 'flex', gap: 8 }}>
          {dirty && (
            <button
              onClick={() => setEdit({})}
              disabled={saving}
              style={btnSecondary}
            >
              撤销
            </button>
          )}
          <button
            onClick={save}
            disabled={!dirty || saving}
            style={{
              ...btnPrimary,
              opacity: !dirty || saving ? 0.45 : 1,
            }}
          >
            {saving ? '保存中…' : '保存'}
          </button>
        </div>
      }
    >
      {err && (
        <div
          role="alert"
          style={{
            fontSize: 12,
            padding: '8px 12px',
            borderRadius: 'var(--radius-sm)',
            background: 'var(--vermilion-soft)',
            color: 'var(--vermilion-deep)',
          }}
        >
          {err}
        </div>
      )}

      <FieldGrid>
        <Edit label="姓名" value={val('fullName')} onChange={(v) => set('fullName', v)} />
        <Edit label="邮箱" value={val('email')} onChange={(v) => set('email', v)} />
        <Edit label="微信号" value={val('wechatId')} onChange={(v) => set('wechatId', v)} />
        <Edit
          label="微信昵称"
          value={val('wechatNickname')}
          onChange={(v) => set('wechatNickname', v)}
        />
        <Edit label="手机号" value={val('phone')} onChange={(v) => set('phone', v)} />
        <Edit
          label="学校"
          value={val('university')}
          onChange={(v) => set('university', v)}
        />
        <Edit label="专业" value={val('major')} onChange={(v) => set('major', v)} />
        <EditSelect
          label="年级"
          value={val('gradeYear') as FutureGradeYear}
          onChange={(v) => set('gradeYear', v as FutureGradeYear)}
          options={GRADE_YEAR_ORDER.map((g) => ({
            value: g,
            label: GRADE_YEAR_META[g],
          }))}
        />
      </FieldGrid>

      <EditTextArea
        label="对 AI 的理解"
        value={val('aiUnderstanding')}
        onChange={(v) => set('aiUnderstanding', v)}
        rows={4}
      />
      <EditTextArea
        label="AI 实际运用经验"
        value={val('aiExperience')}
        onChange={(v) => set('aiExperience', v)}
        rows={4}
      />
      <EditTextArea
        label="过往项目经历"
        value={val('pastProjects')}
        onChange={(v) => set('pastProjects', v)}
        rows={5}
      />
      {(student.motivation || edit.motivation !== undefined) && (
        <EditTextArea
          label="加入动机"
          value={val('motivation')}
          onChange={(v) => set('motivation', v)}
          rows={3}
        />
      )}
    </Card>
  )
}

// ─── Sidebar — admin notes / tags / resume ────────────────────────────

function SidePanel({
  student,
  onChanged,
}: {
  student: FutureStudentDetail
  onChanged: () => void
}) {
  const [adminNotes, setAdminNotes] = useState(student.adminNotes)
  const [tagInput, setTagInput] = useState('')
  const [tags, setTags] = useState<string[]>(student.tags)

  useEffect(() => setAdminNotes(student.adminNotes), [student.adminNotes])
  useEffect(() => setTags(student.tags), [student.tags])

  const notesDirty = adminNotes !== student.adminNotes
  const tagsDirty = tags.join('|') !== student.tags.join('|')

  async function saveAdmin() {
    const patch: FutureUpdateStudent = {}
    if (notesDirty) patch.adminNotes = adminNotes
    if (tagsDirty) patch.tags = tags
    if (!Object.keys(patch).length) return
    await backend.students.update(student.id, patch)
    onChanged()
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      {student.hasResume && (
        <Card title="简历">
          <button
            onClick={() => backend.students.downloadResume(student.id).catch((e) => alert((e as Error).message))}
            style={{
              ...btnPrimary,
              width: '100%',
              padding: '10px 14px',
              fontSize: 13,
            }}
          >
            下载简历
          </button>
        </Card>
      )}

      <Card title="标签">
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
          {tags.map((t) => (
            <span
              key={t}
              style={{
                display: 'inline-flex',
                alignItems: 'center',
                gap: 4,
                background: 'var(--inset)',
                color: 'var(--ink-soft)',
                fontSize: 12,
                padding: '3px 8px',
                borderRadius: 999,
                border: '1px solid var(--hairline-soft)',
              }}
            >
              {t}
              <button
                onClick={() => setTags(tags.filter((x) => x !== t))}
                style={{
                  fontSize: 14,
                  color: 'var(--faint)',
                  lineHeight: 1,
                  padding: 0,
                }}
              >
                ×
              </button>
            </span>
          ))}
        </div>
        <div style={{ display: 'flex', gap: 8 }}>
          <input
            value={tagInput}
            onChange={(e) => setTagInput(e.target.value)}
            placeholder="加标签…"
            onKeyDown={(e) => {
              if (e.key === 'Enter' && tagInput.trim()) {
                e.preventDefault()
                if (!tags.includes(tagInput.trim())) {
                  setTags([...tags, tagInput.trim()])
                }
                setTagInput('')
              }
            }}
            style={{ ...inputStyle, height: 32, fontSize: 12 }}
          />
        </div>
      </Card>

      <Card title="管理员备注" desc="只有团队内部能看到">
        <textarea
          value={adminNotes}
          onChange={(e) => setAdminNotes(e.target.value)}
          rows={6}
          placeholder="第一印象、面谈结论、关键判断…"
          style={{
            ...inputStyle,
            height: 'auto',
            padding: '10px 12px',
            fontSize: 13,
            lineHeight: 1.55,
            resize: 'vertical',
          }}
        />
      </Card>

      {(notesDirty || tagsDirty) && (
        <button onClick={saveAdmin} style={{ ...btnPrimary, alignSelf: 'flex-start' }}>
          保存修改
        </button>
      )}
    </div>
  )
}

// ─── Assignments ──────────────────────────────────────────────────────

function AssignmentsPanel({ studentId }: { studentId: string }) {
  const list = useQuery({
    queryKey: ['students.assignments', studentId],
    queryFn: () => backend.assignments.forStudent(studentId),
  })
  const projects = useQuery({
    queryKey: ['projects.list'],
    queryFn: () => backend.projects.list(),
  })
  const qc = useQueryClient()

  const [showForm, setShowForm] = useState(false)
  const [projectId, setProjectId] = useState('')
  const [role, setRole] = useState('队员')

  const create = useMutation({
    mutationFn: () => backend.assignments.create(studentId, { projectId, role }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['students.assignments', studentId] })
      qc.invalidateQueries({ queryKey: ['projects.list'] })
      setShowForm(false)
      setProjectId('')
      setRole('队员')
    },
  })

  const remove = useMutation({
    mutationFn: (pid: string) => backend.assignments.delete(studentId, pid),
    onSuccess: () =>
      qc.invalidateQueries({ queryKey: ['students.assignments', studentId] }),
  })

  const eligibleProjects = (projects.data ?? []).filter(
    (p) => !(list.data ?? []).some((a) => a.projectId === p.id),
  )

  return (
    <Card
      title="项目分配"
      desc="把学生加入项目，跟进 ta 的实际成长"
      right={
        !showForm && (
          <button
            onClick={() => {
              setShowForm(true)
              if (!projectId && eligibleProjects[0]) {
                setProjectId(eligibleProjects[0].id)
              }
            }}
            disabled={eligibleProjects.length === 0}
            style={{
              ...btnPrimary,
              opacity: eligibleProjects.length === 0 ? 0.45 : 1,
            }}
          >
            + 加入项目
          </button>
        )
      }
    >
      {showForm && (
        <div
          style={{
            background: 'var(--inset)',
            border: '1px solid var(--hairline)',
            borderRadius: 'var(--radius)',
            padding: 12,
            display: 'flex',
            gap: 8,
            flexWrap: 'wrap',
            alignItems: 'flex-end',
          }}
        >
          <label style={{ display: 'flex', flexDirection: 'column', gap: 4, flex: 1, minWidth: 200 }}>
            <span style={{ fontSize: 11, color: 'var(--muted)' }}>项目</span>
            <select
              value={projectId}
              onChange={(e) => setProjectId(e.target.value)}
              style={inputStyle}
            >
              <option value="" disabled>
                选择项目
              </option>
              {eligibleProjects.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </select>
          </label>
          <label style={{ display: 'flex', flexDirection: 'column', gap: 4, width: 140 }}>
            <span style={{ fontSize: 11, color: 'var(--muted)' }}>角色</span>
            <input
              value={role}
              onChange={(e) => setRole(e.target.value)}
              style={inputStyle}
            />
          </label>
          <button
            onClick={() => create.mutate()}
            disabled={!projectId || create.isPending}
            style={{
              ...btnPrimary,
              opacity: !projectId || create.isPending ? 0.45 : 1,
            }}
          >
            {create.isPending ? '保存中…' : '保存'}
          </button>
          <button onClick={() => setShowForm(false)} style={btnSecondary}>
            取消
          </button>
        </div>
      )}

      {list.isLoading && <p style={{ fontSize: 12, color: 'var(--muted)' }}>加载中…</p>}
      {list.isSuccess && list.data.length === 0 && !showForm && (
        <p style={{ fontSize: 12, color: 'var(--faint)', margin: 0 }}>
          还没有分配项目。
        </p>
      )}
      {list.isSuccess &&
        list.data.map((a) => {
          const meta = ASSIGNMENT_STATUS_META[a.status]
          return (
            <div
              key={a.projectId}
              style={{
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'space-between',
                gap: 12,
                padding: '10px 14px',
                background: 'var(--paper)',
                border: '1px solid var(--hairline-soft)',
                borderRadius: 'var(--radius-sm)',
              }}
            >
              <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
                <span style={{ fontSize: 14, color: 'var(--ink)' }}>
                  {a.projectName}
                </span>
                <span
                  className="mono"
                  style={{ fontSize: 11, color: 'var(--faint)' }}
                >
                  {a.role} · 加入 {a.joinedAt}
                  {a.leftAt && ` · 离开 ${a.leftAt}`}
                </span>
              </div>
              <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                <StatusPill tone={meta.tone} label={meta.label} size="sm" />
                <button
                  onClick={() => {
                    if (confirm(`从 ${a.projectName} 移除？`)) {
                      remove.mutate(a.projectId)
                    }
                  }}
                  style={{
                    fontSize: 11,
                    color: 'var(--faint)',
                    padding: '2px 8px',
                  }}
                >
                  移除
                </button>
              </div>
            </div>
          )
        })}
    </Card>
  )
}

// ─── Notes timeline ───────────────────────────────────────────────────

function NotesPanel({ studentId }: { studentId: string }) {
  const list = useQuery({
    queryKey: ['students.notes', studentId],
    queryFn: () => backend.notes.list(studentId),
  })
  const qc = useQueryClient()

  const [body, setBody] = useState('')
  const [kind, setKind] = useState<FutureNoteKind>('general')

  const create = useMutation({
    mutationFn: () => backend.notes.create(studentId, { body: body.trim(), kind }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['students.notes', studentId] })
      setBody('')
    },
  })

  const remove = useMutation({
    mutationFn: (id: string) => backend.notes.delete(studentId, id),
    onSuccess: () =>
      qc.invalidateQueries({ queryKey: ['students.notes', studentId] }),
  })

  return (
    <Card title="时间线" desc="记录每一次沟通、复盘、判断">
      <div
        style={{
          background: 'var(--paper)',
          border: '1px solid var(--hairline)',
          borderRadius: 'var(--radius)',
          padding: 12,
          display: 'flex',
          flexDirection: 'column',
          gap: 8,
        }}
      >
        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
          {(Object.keys(NOTE_KIND_META) as FutureNoteKind[]).map((k) => {
            const m = NOTE_KIND_META[k]
            const active = k === kind
            return (
              <button
                key={k}
                onClick={() => setKind(k)}
                style={{
                  padding: '3px 10px',
                  fontSize: 11,
                  borderRadius: 999,
                  background: active ? 'var(--ink)' : 'transparent',
                  color: active ? 'var(--paper)' : 'var(--ink-soft)',
                  border: '1px solid',
                  borderColor: active ? 'var(--ink)' : 'var(--hairline)',
                }}
              >
                {m.label}
              </button>
            )
          })}
        </div>
        <textarea
          value={body}
          onChange={(e) => setBody(e.target.value)}
          rows={3}
          placeholder="记一笔…（Cmd/Ctrl + Enter 提交）"
          onKeyDown={(e) => {
            if ((e.metaKey || e.ctrlKey) && e.key === 'Enter' && body.trim()) {
              create.mutate()
            }
          }}
          style={{
            ...inputStyle,
            height: 'auto',
            padding: '8px 10px',
            fontSize: 13,
            lineHeight: 1.55,
            resize: 'vertical',
            border: 'none',
            background: 'transparent',
          }}
        />
        <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
          <button
            onClick={() => create.mutate()}
            disabled={!body.trim() || create.isPending}
            style={{
              ...btnPrimary,
              opacity: !body.trim() || create.isPending ? 0.45 : 1,
            }}
          >
            {create.isPending ? '保存中…' : '保存'}
          </button>
        </div>
      </div>

      {list.isLoading && <p style={{ fontSize: 12, color: 'var(--muted)' }}>加载中…</p>}
      {list.isSuccess && list.data.length === 0 && (
        <p style={{ fontSize: 12, color: 'var(--faint)', margin: 0 }}>
          还没有记录。
        </p>
      )}
      {list.isSuccess &&
        list.data.map((n) => {
          const m = NOTE_KIND_META[n.kind]
          return (
            <div
              key={n.id}
              style={{
                display: 'flex',
                gap: 12,
                padding: '12px 14px',
                background: 'var(--paper)',
                border: '1px solid var(--hairline-soft)',
                borderRadius: 'var(--radius-sm)',
              }}
            >
              <StatusPill tone={m.tone} label={m.label} size="sm" />
              <div style={{ flex: 1, minWidth: 0 }}>
                <p
                  style={{
                    margin: 0,
                    fontSize: 13.5,
                    color: 'var(--ink)',
                    lineHeight: 1.65,
                    whiteSpace: 'pre-wrap',
                  }}
                >
                  {n.body}
                </p>
                <p
                  className="mono"
                  style={{
                    margin: '6px 0 0',
                    fontSize: 10.5,
                    color: 'var(--faint)',
                    display: 'flex',
                    gap: 8,
                  }}
                >
                  <span>{fmtDateTime(n.createdAt)}</span>
                  {n.authorName && <span>· {n.authorName}</span>}
                  {n.projectName && <span>· {n.projectName}</span>}
                </p>
              </div>
              <button
                onClick={() => {
                  if (confirm('删除这条记录？')) remove.mutate(n.id)
                }}
                style={{
                  fontSize: 11,
                  color: 'var(--faint)',
                  alignSelf: 'flex-start',
                }}
              >
                删除
              </button>
            </div>
          )
        })}
    </Card>
  )
}

// ─── Reusable inputs ──────────────────────────────────────────────────

function FieldGrid({ children }: { children: React.ReactNode }) {
  return (
    <div
      style={{
        display: 'grid',
        gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))',
        gap: 12,
      }}
    >
      {children}
    </div>
  )
}

function Edit({
  label,
  value,
  onChange,
}: {
  label: string
  value: string
  onChange: (v: string) => void
}) {
  return (
    <label style={{ display: 'flex', flexDirection: 'column', gap: 5 }}>
      <span style={{ fontSize: 11, color: 'var(--muted)' }}>{label}</span>
      <input
        value={value}
        onChange={(e) => onChange(e.target.value)}
        style={inputStyle}
      />
    </label>
  )
}

function EditSelect({
  label,
  value,
  onChange,
  options,
}: {
  label: string
  value: string
  onChange: (v: string) => void
  options: { value: string; label: string }[]
}) {
  return (
    <label style={{ display: 'flex', flexDirection: 'column', gap: 5 }}>
      <span style={{ fontSize: 11, color: 'var(--muted)' }}>{label}</span>
      <select
        value={value}
        onChange={(e) => onChange(e.target.value)}
        style={inputStyle}
      >
        {options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
    </label>
  )
}

function EditTextArea({
  label,
  value,
  onChange,
  rows = 4,
}: {
  label: string
  value: string
  onChange: (v: string) => void
  rows?: number
}) {
  return (
    <label style={{ display: 'flex', flexDirection: 'column', gap: 5 }}>
      <span style={{ fontSize: 11, color: 'var(--muted)' }}>{label}</span>
      <textarea
        value={value}
        onChange={(e) => onChange(e.target.value)}
        rows={rows}
        style={{
          ...inputStyle,
          height: 'auto',
          padding: '10px 12px',
          fontSize: 13.5,
          lineHeight: 1.6,
          resize: 'vertical',
        }}
      />
    </label>
  )
}

const inputStyle: React.CSSProperties = {
  height: 36,
  width: '100%',
  borderRadius: 'var(--radius-sm)',
  border: '1px solid var(--hairline)',
  background: 'var(--paper)',
  padding: '0 12px',
  fontSize: 13.5,
  color: 'var(--ink)',
  outline: 'none',
}

const btnPrimary: React.CSSProperties = {
  padding: '6px 14px',
  fontSize: 12,
  fontWeight: 500,
  letterSpacing: '0.04em',
  color: 'var(--paper)',
  background: 'var(--ink)',
  borderRadius: 'var(--radius-sm)',
}

const btnSecondary: React.CSSProperties = {
  padding: '6px 12px',
  fontSize: 12,
  color: 'var(--ink-soft)',
  background: 'transparent',
  border: '1px solid var(--hairline)',
  borderRadius: 'var(--radius-sm)',
}

function fmtDateTime(iso: string): string {
  const d = new Date(iso)
  if (isNaN(d.getTime())) return iso
  return d.toLocaleString('zh-CN', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  })
}

// keep the unused import warning quiet (PROJECT_STATUS_META reserved
// for projects/:id detail page in a later iteration)
void PROJECT_STATUS_META
