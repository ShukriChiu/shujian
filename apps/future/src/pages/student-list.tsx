import { useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import { useQuery } from '@tanstack/react-query'
import { backend } from '../lib/backend'
import { StatusPill } from '../components/status-pill'
import {
  GRADE_YEAR_META,
  STUDENT_STATUS_META,
  STUDENT_STATUS_ORDER,
  type FutureStudentStatus,
  type FutureStudentSummary,
} from '../lib/types'

type StatusFilter = FutureStudentStatus | 'all'

export function StudentListPage() {
  const [statusFilter, setStatusFilter] = useState<StatusFilter>('all')
  const [query, setQuery] = useState('')

  const apiStatus = statusFilter === 'all' ? undefined : statusFilter

  const list = useQuery({
    queryKey: ['students.list', apiStatus],
    queryFn: () => backend.students.list({ status: apiStatus }),
  })

  // Search filters client-side over the active server-fetched batch
  // so the filter buttons feel instant. The server-side `q` param
  // remains available if the dataset grows past a few hundred rows.
  const filtered = useMemo(() => {
    const data = list.data ?? []
    const q = query.trim().toLowerCase()
    if (!q) return data
    return data.filter((s) =>
      [
        s.fullName,
        s.wechatNickname,
        s.university,
        s.major,
        s.birthYear != null ? String(s.birthYear) : '',
        ...s.tags,
      ]
        .join(' ')
        .toLowerCase()
        .includes(q),
    )
  }, [list.data, query])

  const counts = useMemo(() => {
    const c: Record<string, number> = { all: 0 }
    for (const s of list.data ?? []) {
      c.all += 1
      c[s.status] = (c[s.status] ?? 0) + 1
    }
    return c
  }, [list.data])

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>
      <PageHeader
        title="学生"
        subtitle="所有提交过申请的人，按状态筛选 / 搜索"
        right={
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="搜索 姓名 / 出生年份 / 学校 / 标签…"
            style={{
              height: 34,
              padding: '0 12px',
              fontSize: 13,
              color: 'var(--ink)',
              background: 'var(--leaf)',
              border: '1px solid var(--hairline)',
              borderRadius: 'var(--radius-sm)',
              minWidth: 220,
              outline: 'none',
            }}
          />
        }
      />

      <FilterBar
        active={statusFilter}
        counts={counts}
        onChange={setStatusFilter}
      />

      {list.isLoading && (
        <p style={{ color: 'var(--muted)', fontSize: 13 }}>加载中…</p>
      )}
      {list.isError && (
        <p
          style={{
            color: 'var(--vermilion-deep)',
            fontSize: 13,
            background: 'var(--vermilion-soft)',
            padding: 12,
            borderRadius: 'var(--radius-sm)',
          }}
        >
          {(list.error as Error).message}
        </p>
      )}
      {list.isSuccess && filtered.length === 0 && (
        <Empty
          title={
            query
              ? '没有匹配的学生'
              : statusFilter === 'all'
                ? '还没有学生提交申请'
                : '这个状态下还没有学生'
          }
          hint={
            query
              ? '换个关键词试试。'
              : '到「招募链接」拷贝公网链接，发出去就能开始收申请了。'
          }
        />
      )}
      {list.isSuccess && filtered.length > 0 && (
        <div
          style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(auto-fill, minmax(280px, 1fr))',
            gap: 16,
          }}
        >
          {filtered.map((s) => (
            <StudentCard key={s.id} s={s} />
          ))}
        </div>
      )}
    </div>
  )
}

function FilterBar({
  active,
  counts,
  onChange,
}: {
  active: StatusFilter
  counts: Record<string, number>
  onChange: (s: StatusFilter) => void
}) {
  const all: { value: StatusFilter; label: string }[] = [
    { value: 'all', label: '全部' },
    ...STUDENT_STATUS_ORDER.filter((s) => s !== 'archived').map((s) => ({
      value: s as StatusFilter,
      label: STUDENT_STATUS_META[s].label,
    })),
  ]

  return (
    <div
      style={{
        display: 'flex',
        gap: 6,
        flexWrap: 'wrap',
        padding: 6,
        background: 'var(--leaf-soft)',
        border: '1px solid var(--hairline)',
        borderRadius: 'var(--radius)',
      }}
    >
      {all.map((item) => {
        const isActive = active === item.value
        const count = counts[item.value] ?? 0
        return (
          <button
            key={item.value}
            onClick={() => onChange(item.value)}
            style={{
              padding: '6px 12px',
              fontSize: 12,
              fontWeight: 500,
              color: isActive ? 'var(--paper)' : 'var(--ink-soft)',
              background: isActive ? 'var(--ink)' : 'transparent',
              border: '1px solid',
              borderColor: isActive ? 'var(--ink)' : 'transparent',
              borderRadius: 'var(--radius-sm)',
              transition: 'all 120ms var(--ease-out-quart)',
              display: 'flex',
              alignItems: 'center',
              gap: 6,
            }}
          >
            <span>{item.label}</span>
            {count > 0 && (
              <span
                className="mono"
                style={{
                  fontSize: 10,
                  padding: '1px 6px',
                  borderRadius: 999,
                  background: isActive
                    ? 'oklch(40% 0.012 60)'
                    : 'var(--hairline-soft)',
                  color: isActive ? 'var(--paper)' : 'var(--ink-soft)',
                }}
              >
                {count}
              </span>
            )}
          </button>
        )
      })}
    </div>
  )
}

function StudentCard({ s }: { s: FutureStudentSummary }) {
  const meta = STUDENT_STATUS_META[s.status]
  return (
    <Link
      to={`/students/${s.id}`}
      style={{
        textDecoration: 'none',
        color: 'inherit',
        display: 'flex',
        flexDirection: 'column',
        gap: 10,
        padding: 16,
        background: 'var(--leaf)',
        border: '1px solid var(--hairline)',
        borderRadius: 'var(--radius)',
        transition: 'all 140ms var(--ease-out-quart)',
      }}
      onMouseEnter={(e) => {
        e.currentTarget.style.transform = 'translateY(-1px)'
        e.currentTarget.style.boxShadow = 'var(--paper-shadow-pop)'
      }}
      onMouseLeave={(e) => {
        e.currentTarget.style.transform = 'translateY(0)'
        e.currentTarget.style.boxShadow = 'none'
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
        <div style={{ minWidth: 0, flex: 1 }}>
          <h3
            className="serif"
            style={{
              margin: 0,
              fontSize: 16,
              color: 'var(--ink)',
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
            }}
          >
            {s.fullName}
          </h3>
          {s.wechatNickname && (
            <p
              style={{
                margin: '2px 0 0',
                fontSize: 12,
                color: 'var(--muted)',
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                whiteSpace: 'nowrap',
              }}
            >
              {s.wechatNickname}
            </p>
          )}
        </div>
        <StatusPill tone={meta.tone} label={meta.label} size="sm" />
      </div>
      <div
        style={{
          fontSize: 12,
          color: 'var(--ink-soft)',
          display: 'flex',
          flexWrap: 'wrap',
          gap: '0 6px',
        }}
      >
        {s.birthYear != null && (
          <span>{s.birthYear} 年生</span>
        )}
        {s.university && (
          <>
            {s.birthYear != null && (
              <span style={{ color: 'var(--faint)' }}>·</span>
            )}
            <span>{s.university}</span>
          </>
        )}
        {s.major && (
          <>
            <span style={{ color: 'var(--faint)' }}>·</span>
            <span>{s.major}</span>
          </>
        )}
        {s.gradeYear && s.gradeYear !== 'other' && (
          <>
            <span style={{ color: 'var(--faint)' }}>·</span>
            <span>{GRADE_YEAR_META[s.gradeYear]}</span>
          </>
        )}
      </div>
      {s.tags.length > 0 && (
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4 }}>
          {s.tags.map((t) => (
            <StatusPill
              key={t}
              tone="mute"
              label={t}
              size="sm"
              style={{ textTransform: 'none', letterSpacing: 0 }}
            />
          ))}
        </div>
      )}
      <div
        className="mono"
        style={{
          fontSize: 10,
          color: 'var(--faint)',
          display: 'flex',
          gap: 8,
          marginTop: 4,
        }}
      >
        <span>{timeAgo(s.submittedAt)}提交</span>
        {s.hasResume && (
          <>
            <span>·</span>
            <span>有简历</span>
          </>
        )}
      </div>
    </Link>
  )
}

export function PageHeader({
  title,
  subtitle,
  right,
}: {
  title: string
  subtitle?: string
  right?: React.ReactNode
}) {
  return (
    <header
      style={{
        display: 'flex',
        alignItems: 'flex-end',
        justifyContent: 'space-between',
        gap: 24,
        flexWrap: 'wrap',
      }}
    >
      <div>
        <h1
          className="serif"
          style={{
            margin: 0,
            fontSize: 24,
            color: 'var(--ink)',
            letterSpacing: '-0.012em',
          }}
        >
          {title}
        </h1>
        {subtitle && (
          <p
            style={{
              margin: '4px 0 0',
              fontSize: 13,
              color: 'var(--muted)',
            }}
          >
            {subtitle}
          </p>
        )}
      </div>
      {right}
    </header>
  )
}

function Empty({ title, hint }: { title: string; hint?: string }) {
  return (
    <div
      style={{
        padding: '48px 24px',
        textAlign: 'center',
        background: 'var(--leaf-soft)',
        border: '1px dashed var(--hairline)',
        borderRadius: 'var(--radius-lg)',
        display: 'flex',
        flexDirection: 'column',
        gap: 6,
      }}
    >
      <p
        className="serif"
        style={{ margin: 0, fontSize: 16, color: 'var(--ink-soft)' }}
      >
        {title}
      </p>
      {hint && (
        <p style={{ margin: 0, fontSize: 12, color: 'var(--faint)' }}>{hint}</p>
      )}
    </div>
  )
}

function timeAgo(iso: string): string {
  const t = new Date(iso).getTime()
  if (!t) return ''
  const diff = (Date.now() - t) / 1000
  if (diff < 60) return '刚刚'
  if (diff < 3600) return `${Math.floor(diff / 60)} 分钟前`
  if (diff < 86400) return `${Math.floor(diff / 3600)} 小时前`
  if (diff < 86400 * 30) return `${Math.floor(diff / 86400)} 天前`
  return new Date(iso).toLocaleDateString('zh-CN')
}
