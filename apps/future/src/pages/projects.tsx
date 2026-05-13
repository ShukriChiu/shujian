import { useState } from 'react'
import {
  useMutation,
  useQuery,
  useQueryClient,
} from '@tanstack/react-query'
import { backend } from '../lib/backend'
import { StatusPill } from '../components/status-pill'
import { PageHeader } from './student-list'
import {
  PROJECT_STATUS_META,
  type FutureCreateProject,
  type FutureProject,
  type FutureProjectStatus,
} from '../lib/types'

export function ProjectsPage() {
  const list = useQuery({
    queryKey: ['projects.list'],
    queryFn: () => backend.projects.list(),
  })
  const [showForm, setShowForm] = useState(false)

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>
      <PageHeader
        title="项目"
        subtitle="把通过的学生分配进项目，跟进 ta 的实际成长"
        right={
          !showForm && (
            <button
              onClick={() => setShowForm(true)}
              style={{
                padding: '8px 14px',
                fontSize: 13,
                color: 'var(--paper)',
                background: 'var(--ink)',
                borderRadius: 'var(--radius-sm)',
              }}
            >
              + 新建项目
            </button>
          )
        }
      />

      {showForm && <CreateProjectForm onDone={() => setShowForm(false)} />}

      {list.isLoading && <p style={{ color: 'var(--muted)' }}>加载中…</p>}
      {list.isSuccess && list.data.length === 0 && !showForm && (
        <Empty>还没有项目。点击右上角创建第一个。</Empty>
      )}
      {list.isSuccess && list.data.length > 0 && (
        <div
          style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(auto-fill, minmax(300px, 1fr))',
            gap: 16,
          }}
        >
          {list.data.map((p) => (
            <ProjectCard key={p.id} p={p} />
          ))}
        </div>
      )}
    </div>
  )
}

function CreateProjectForm({ onDone }: { onDone: () => void }) {
  const qc = useQueryClient()
  const [body, setBody] = useState<FutureCreateProject>({
    name: '',
    summary: '',
    status: 'planning',
  })
  const create = useMutation({
    mutationFn: () => backend.projects.create(body),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['projects.list'] })
      onDone()
    },
  })

  return (
    <section
      style={{
        background: 'var(--leaf)',
        border: '1px solid var(--hairline)',
        borderRadius: 'var(--radius-lg)',
        padding: 20,
        display: 'flex',
        flexDirection: 'column',
        gap: 14,
      }}
    >
      <h2
        className="serif"
        style={{ margin: 0, fontSize: 16, color: 'var(--ink)' }}
      >
        新建项目
      </h2>
      <div
        style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))',
          gap: 12,
        }}
      >
        <Input
          label="项目名 *"
          value={body.name}
          onChange={(v) => setBody({ ...body, name: v })}
          autoFocus
        />
        <Select
          label="状态"
          value={body.status ?? 'planning'}
          onChange={(v) =>
            setBody({ ...body, status: v as FutureProjectStatus })
          }
          options={Object.entries(PROJECT_STATUS_META).map(([v, m]) => ({
            value: v,
            label: m.label,
          }))}
        />
      </div>
      <TextArea
        label="项目简介"
        value={body.summary ?? ''}
        onChange={(v) => setBody({ ...body, summary: v })}
        rows={3}
      />
      <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
        <button onClick={onDone} style={btnSecondary}>
          取消
        </button>
        <button
          onClick={() => create.mutate()}
          disabled={!body.name.trim() || create.isPending}
          style={{
            ...btnPrimary,
            opacity: !body.name.trim() || create.isPending ? 0.45 : 1,
          }}
        >
          {create.isPending ? '保存中…' : '创建'}
        </button>
      </div>
    </section>
  )
}

function ProjectCard({ p }: { p: FutureProject }) {
  const qc = useQueryClient()
  const [editing, setEditing] = useState(false)
  const meta = PROJECT_STATUS_META[p.status]

  const archive = useMutation({
    mutationFn: () => backend.projects.archive(p.id),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['projects.list'] }),
  })

  return (
    <article
      style={{
        background: 'var(--leaf)',
        border: '1px solid var(--hairline)',
        borderRadius: 'var(--radius)',
        padding: 16,
        display: 'flex',
        flexDirection: 'column',
        gap: 10,
      }}
    >
      <div
        style={{
          display: 'flex',
          alignItems: 'flex-start',
          justifyContent: 'space-between',
          gap: 8,
        }}
      >
        <h3
          className="serif"
          style={{ margin: 0, fontSize: 16, color: 'var(--ink)' }}
        >
          {p.name}
        </h3>
        <StatusPill tone={meta.tone} label={meta.label} size="sm" />
      </div>
      {p.summary && (
        <p
          style={{
            margin: 0,
            fontSize: 13,
            color: 'var(--ink-soft)',
            lineHeight: 1.6,
            whiteSpace: 'pre-wrap',
          }}
        >
          {p.summary}
        </p>
      )}
      <div
        className="mono"
        style={{
          fontSize: 11,
          color: 'var(--faint)',
          display: 'flex',
          gap: 8,
          marginTop: 'auto',
        }}
      >
        <span>{p.activeMemberCount} 人在岗</span>
        {p.startedAt && <span>· 始于 {p.startedAt}</span>}
        {p.endedAt && <span>· 结束 {p.endedAt}</span>}
      </div>
      <div
        style={{
          display: 'flex',
          gap: 8,
          paddingTop: 8,
          borderTop: '1px dashed var(--hairline-soft)',
        }}
      >
        <button onClick={() => setEditing(true)} style={btnSecondary}>
          编辑
        </button>
        {p.status !== 'archived' && (
          <button
            onClick={() => {
              if (confirm(`归档「${p.name}」？数据保留，不在默认列表显示。`)) {
                archive.mutate()
              }
            }}
            style={{
              ...btnSecondary,
              color: 'var(--vermilion-deep)',
              borderColor: 'var(--vermilion-soft)',
            }}
          >
            归档
          </button>
        )}
      </div>
      {editing && (
        <EditProjectModal
          project={p}
          onClose={() => setEditing(false)}
        />
      )}
    </article>
  )
}

function EditProjectModal({
  project,
  onClose,
}: {
  project: FutureProject
  onClose: () => void
}) {
  const qc = useQueryClient()
  const [name, setName] = useState(project.name)
  const [summary, setSummary] = useState(project.summary)
  const [status, setStatus] = useState<FutureProjectStatus>(project.status)
  const save = useMutation({
    mutationFn: () =>
      backend.projects.update(project.id, { name, summary, status }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['projects.list'] })
      onClose()
    },
  })

  return (
    <div
      role="dialog"
      style={{
        position: 'fixed',
        inset: 0,
        background: 'oklch(20% 0.012 60 / 50%)',
        display: 'grid',
        placeItems: 'center',
        padding: 16,
        zIndex: 100,
      }}
      onClick={onClose}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          width: 'min(480px, 100%)',
          background: 'var(--leaf)',
          border: '1px solid var(--hairline)',
          borderRadius: 'var(--radius-lg)',
          padding: 24,
          display: 'flex',
          flexDirection: 'column',
          gap: 14,
        }}
      >
        <h2 className="serif" style={{ margin: 0, fontSize: 18, color: 'var(--ink)' }}>
          编辑项目
        </h2>
        <Input label="项目名" value={name} onChange={setName} autoFocus />
        <Select
          label="状态"
          value={status}
          onChange={(v) => setStatus(v as FutureProjectStatus)}
          options={Object.entries(PROJECT_STATUS_META).map(([v, m]) => ({
            value: v,
            label: m.label,
          }))}
        />
        <TextArea label="简介" value={summary} onChange={setSummary} rows={4} />
        <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
          <button onClick={onClose} style={btnSecondary}>
            取消
          </button>
          <button
            onClick={() => save.mutate()}
            disabled={!name.trim() || save.isPending}
            style={{
              ...btnPrimary,
              opacity: !name.trim() || save.isPending ? 0.45 : 1,
            }}
          >
            {save.isPending ? '保存中…' : '保存'}
          </button>
        </div>
      </div>
    </div>
  )
}

// ─── Inputs ───────────────────────────────────────────────────────────

function Input({
  label,
  value,
  onChange,
  autoFocus,
}: {
  label: string
  value: string
  onChange: (v: string) => void
  autoFocus?: boolean
}) {
  return (
    <label style={{ display: 'flex', flexDirection: 'column', gap: 5 }}>
      <span style={{ fontSize: 11, color: 'var(--muted)' }}>{label}</span>
      <input
        value={value}
        onChange={(e) => onChange(e.target.value)}
        autoFocus={autoFocus}
        style={inputStyle}
      />
    </label>
  )
}

function Select({
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

function TextArea({
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

function Empty({ children }: { children: React.ReactNode }) {
  return (
    <div
      style={{
        padding: '40px 24px',
        textAlign: 'center',
        background: 'var(--leaf-soft)',
        border: '1px dashed var(--hairline)',
        borderRadius: 'var(--radius-lg)',
        fontSize: 13,
        color: 'var(--muted)',
      }}
    >
      {children}
    </div>
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
