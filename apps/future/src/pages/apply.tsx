import { useEffect, useRef, useState } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import { useQuery } from '@tanstack/react-query'
import { backend } from '../lib/backend'
import {
  GRADE_YEAR_META,
  GRADE_YEAR_ORDER,
  type FutureGradeYear,
} from '../lib/types'

const RESUME_MAX_BYTES = 5 * 1024 * 1024
const RESUME_ACCEPT =
  '.pdf,.doc,.docx,.png,.jpg,.jpeg,application/pdf,application/msword,application/vnd.openxmlformats-officedocument.wordprocessingml.document,image/png,image/jpeg'

const BIRTH_YEAR_MIN = 1940
/** 输入类控件最小高度（触控友好） */
const CONTROL_MIN_TAP = 44
const NARROW_BREAKPOINT = '(max-width: 767px)'

type ApplySectionId = 'contact' | 'campus' | 'ai' | 'projects' | 'resume'

interface FormState {
  fullName: string
  wechatId: string
  phone: string
  birthYear: string
  university: string
  major: string
  gradeYear: FutureGradeYear
  aiUnderstanding: string
  aiExperience: string
  pastProjects: string
  motivation: string
}

const EMPTY: FormState = {
  fullName: '',
  wechatId: '',
  phone: '',
  birthYear: '',
  university: '',
  major: '',
  gradeYear: 'junior',
  aiUnderstanding: '',
  aiExperience: '',
  pastProjects: '',
  motivation: '',
}

/**
 * Public student application form.
 */
export function ApplyPage() {
  const narrow = useNarrowApplyLayout()
  const { token = '' } = useParams<{ token: string }>()
  const navigate = useNavigate()
  const info = useQuery({
    queryKey: ['apply.tenantInfo', token],
    queryFn: () => backend.apply.getTenantInfo(token),
    retry: 0,
    enabled: !!token,
  })

  const [form, setForm] = useState<FormState>(EMPTY)
  const [resume, setResume] = useState<File | null>(null)
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const fileRef = useRef<HTMLInputElement>(null)
  const [expandedSections, setExpandedSections] = useState<
    Record<ApplySectionId, boolean>
  >({
    contact: true,
    campus: false,
    ai: false,
    projects: false,
    resume: false,
  })

  if (info.isLoading) {
    return <ApplyShell title="加载中…" subtitle="" narrow={narrow} />
  }
  if (info.isError) {
    return (
      <ApplyShell title="链接已失效" subtitle="" narrow={narrow}>
        <p style={{ fontSize: 14, color: 'var(--muted)', margin: 0 }}>
          这个招募链接不存在，或者已经被关闭。请联系工作区管理员获取新的链接。
        </p>
      </ApplyShell>
    )
  }
  const tenant = info.data!
  if (!tenant.isOpen) {
    return (
      <ApplyShell
        title={`${tenant.tenantName} · 招募已暂停`}
        subtitle={tenant.label}
        narrow={narrow}
      >
        <p style={{ fontSize: 14, color: 'var(--muted)', margin: 0 }}>
          这一期的招募已经关闭。请联系管理员了解下一期开放时间。
        </p>
      </ApplyShell>
    )
  }

  function set<K extends keyof FormState>(key: K, value: FormState[K]) {
    setForm((s) => ({ ...s, [key]: value }))
  }

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault()
    if (submitting) return
    if (!form.fullName.trim()) {
      setError('请填写姓名')
      return
    }
    if (!form.wechatId.trim()) {
      setError('请填写微信号')
      return
    }
    if (!form.phone.trim()) {
      setError('请填写手机号')
      return
    }
    const y = parseInt(form.birthYear.trim(), 10)
    const yMax = new Date().getFullYear()
    if (
      !Number.isFinite(y) ||
      y < BIRTH_YEAR_MIN ||
      y > yMax
    ) {
      setError(`请填写有效的出生年份（${BIRTH_YEAR_MIN}–${yMax}）`)
      return
    }
    if (resume && resume.size > RESUME_MAX_BYTES) {
      setError('简历超过 5MB 上限，请压缩后再上传。')
      return
    }
    setSubmitting(true)
    setError(null)
    try {
      const result = await backend.apply.submit(
        token,
        {
          fullName: form.fullName.trim(),
          wechatId: form.wechatId.trim(),
          phone: form.phone.trim(),
          birthYear: y,
          university: form.university.trim() || undefined,
          major: form.major.trim() || undefined,
          gradeYear: form.gradeYear,
          aiUnderstanding: form.aiUnderstanding.trim() || undefined,
          aiExperience: form.aiExperience.trim() || undefined,
          pastProjects: form.pastProjects.trim() || undefined,
          motivation: form.motivation.trim() || undefined,
        },
        resume,
      )
      navigate(`/apply/${token}/done`, {
        replace: true,
        state: {
          tenantName: tenant.tenantName,
          studentId: result.studentId,
          fullName: form.fullName,
        },
      })
    } catch (err) {
      setError(err instanceof Error ? err.message : '提交失败，请稍后再试。')
    } finally {
      setSubmitting(false)
    }
  }

  function toggleSection(id: ApplySectionId) {
    setExpandedSections((s) => ({ ...s, [id]: !s[id] }))
  }

  return (
    <ApplyShell
      title={`${tenant.tenantName} · 招募申请`}
      subtitle={tenant.label}
      narrow={narrow}
    >
      <form
        onSubmit={onSubmit}
        noValidate
        style={{
          display: 'flex',
          flexDirection: 'column',
          gap: narrow ? 16 : 28,
        }}
      >
        {narrow && (
          <p
            style={{
              margin: 0,
              fontSize: 12,
              color: 'var(--muted)',
              lineHeight: 1.5,
            }}
          >
            手机填写可点开各段标题展开；带 * 为必填。可随时上下滑动修改已填内容。
          </p>
        )}
        <SectionWrap
          mode={narrow ? 'collapsible' : 'static'}
          id="contact"
          title="联系方式"
          desc="姓名、微信号与手机号为必填"
          expanded={expandedSections.contact}
          onToggle={() => toggleSection('contact')}
        >
          <Row>
            <Field
              label="姓名 *"
              value={form.fullName}
              onChange={(v) => set('fullName', v)}
              required
              autoFocus
            />
            <Field
              label="微信号 *"
              value={form.wechatId}
              onChange={(v) => set('wechatId', v)}
              placeholder="用于添加联系"
              required
            />
          </Row>
          <Row>
            <Field
              label="手机号 *"
              type="tel"
              value={form.phone}
              onChange={(v) => set('phone', v)}
              required
            />
            <Field
              label="出生年份 *"
              type="number"
              value={form.birthYear}
              onChange={(v) => set('birthYear', v)}
              placeholder={`例：2003（${BIRTH_YEAR_MIN}–${new Date().getFullYear()}）`}
              required
            />
          </Row>
        </SectionWrap>

        <SectionWrap
          mode={narrow ? 'collapsible' : 'static'}
          id="campus"
          title="校园信息"
          desc="学校、专业、年级（选填亦可留空）"
          expanded={expandedSections.campus}
          onToggle={() => toggleSection('campus')}
        >
          <Row>
            <Field
              label="学校"
              value={form.university}
              onChange={(v) => set('university', v)}
              placeholder="例：清华大学"
            />
            <Field
              label="专业"
              value={form.major}
              onChange={(v) => set('major', v)}
              placeholder="例：计算机科学与技术"
            />
          </Row>
          <Row>
            <SelectField
              label="年级"
              value={form.gradeYear}
              onChange={(v) =>
                set('gradeYear', v as FutureGradeYear)
              }
              options={GRADE_YEAR_ORDER.map((g) => ({
                value: g,
                label: GRADE_YEAR_META[g],
              }))}
            />
          </Row>
        </SectionWrap>

        <SectionWrap
          mode={narrow ? 'collapsible' : 'static'}
          id="ai"
          title="对 AI 的理解和运用"
          desc="重点 — 越具体越好，例子比抽象描述更有说服力"
          expanded={expandedSections.ai}
          onToggle={() => toggleSection('ai')}
        >
          <TextArea
            label="你怎么看 AI？以及你打算怎么用 AI？"
            value={form.aiUnderstanding}
            onChange={(v) => set('aiUnderstanding', v)}
            rows={5}
            placeholder="可以写：你对 AI 的核心判断、对未来的预判、它给你的具体启发……"
          />
          <TextArea
            label="你过去用 AI 做过什么具体的事？"
            value={form.aiExperience}
            onChange={(v) => set('aiExperience', v)}
            rows={5}
            placeholder="例：用 Claude 写过一个量化交易脚本；用 Cursor 做过 X；做过 prompt engineering 的 Y……"
          />
        </SectionWrap>

        <SectionWrap
          mode={narrow ? 'collapsible' : 'static'}
          id="projects"
          title="项目经历"
          desc="任何作品、产品、研究、组织都算"
          expanded={expandedSections.projects}
          onToggle={() => toggleSection('projects')}
        >
          <TextArea
            label="过往项目经历"
            value={form.pastProjects}
            onChange={(v) => set('pastProjects', v)}
            rows={6}
            placeholder="尽量给：做了什么、扮演了什么角色、最后产出是什么。一条一段。"
          />
          <TextArea
            label="你的一些个人目标（可选）"
            value={form.motivation}
            onChange={(v) => set('motivation', v)}
            rows={4}
            placeholder="optional"
          />
        </SectionWrap>

        <SectionWrap
          mode={narrow ? 'collapsible' : 'static'}
          id="resume"
          title="简历（可选）"
          desc="PDF / Word / 图片，5MB 以内"
          expanded={expandedSections.resume}
          onToggle={() => toggleSection('resume')}
        >
          <input
            ref={fileRef}
            type="file"
            accept={RESUME_ACCEPT}
            onChange={(e) => setResume(e.target.files?.[0] ?? null)}
            style={{ display: 'none' }}
          />
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              flexWrap: 'wrap',
              gap: 12,
              padding: 14,
              background: 'var(--leaf)',
              border: '1px dashed var(--hairline-strong)',
              borderRadius: 'var(--radius)',
            }}
          >
            <button
              type="button"
              onClick={() => fileRef.current?.click()}
              style={{
                minHeight: CONTROL_MIN_TAP,
                padding: '10px 16px',
                fontSize: 14,
                color: 'var(--ink)',
                background: 'var(--paper)',
                border: '1px solid var(--hairline-strong)',
                borderRadius: 'var(--radius-sm)',
              }}
            >
              {resume ? '更换文件' : '选择文件'}
            </button>
            <span
              style={{
                fontSize: 12,
                color: 'var(--muted)',
                flex: 1,
                minWidth: 0,
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                whiteSpace: 'nowrap',
              }}
            >
              {resume
                ? `${resume.name} · ${(resume.size / 1024).toFixed(0)} KB`
                : '尚未选择文件（可选）'}
            </span>
            {resume && (
              <button
                type="button"
                onClick={() => {
                  setResume(null)
                  if (fileRef.current) fileRef.current.value = ''
                }}
                style={{
                  fontSize: 13,
                  color: 'var(--muted)',
                  minHeight: CONTROL_MIN_TAP,
                  padding: '8px 12px',
                }}
              >
                移除
              </button>
            )}
          </div>
        </SectionWrap>

        {error && (
          <div
            role="alert"
            style={{
              fontSize: 13,
              padding: '10px 14px',
              borderRadius: 'var(--radius-sm)',
              background: 'var(--vermilion-soft)',
              color: 'var(--vermilion-deep)',
              border: '1px solid var(--vermilion-soft)',
            }}
          >
            {error}
          </div>
        )}

        <button
          type="submit"
          disabled={submitting}
          style={{
            minHeight: narrow ? 48 : CONTROL_MIN_TAP,
            fontSize: narrow ? 15 : 14,
            color: 'var(--paper)',
            background: 'var(--ink)',
            borderRadius: 'var(--radius)',
            letterSpacing: '0.04em',
            opacity: submitting ? 0.55 : 1,
            padding: narrow ? '12px 16px' : undefined,
            marginTop: narrow ? 4 : undefined,
          }}
        >
          {submitting ? '提交中…' : '提交申请'}
        </button>
      </form>
    </ApplyShell>
  )
}

function useNarrowApplyLayout(): boolean {
  const [narrow, setNarrow] = useState(false)
  useEffect(() => {
    const mq = window.matchMedia(NARROW_BREAKPOINT)
    const sync = () => setNarrow(mq.matches)
    sync()
    mq.addEventListener('change', sync)
    return () => mq.removeEventListener('change', sync)
  }, [])
  return narrow
}

function ApplyShell({
  title,
  subtitle,
  narrow,
  children,
}: {
  title: string
  subtitle?: string
  narrow?: boolean
  children?: React.ReactNode
}) {
  return (
    <div
      style={{
        minHeight: '100svh',
        padding: narrow
          ? 'max(16px, env(safe-area-inset-top)) 16px max(72px, calc(16px + env(safe-area-inset-bottom)))'
          : '40px 16px 80px',
        display: 'flex',
        justifyContent: 'center',
      }}
    >
      <div
        style={{
          width: 'min(640px, 100%)',
          background: 'var(--leaf)',
          border: '1px solid var(--hairline)',
          borderRadius: 'var(--radius-lg)',
          boxShadow: 'var(--paper-shadow)',
          padding: narrow ? '24px 18px 28px' : '40px 28px',
          display: 'flex',
          flexDirection: 'column',
          gap: narrow ? 20 : 28,
        }}
      >
        <header style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          <span className="eyebrow">application form</span>
          <h1
            className="serif"
            style={{
              margin: 0,
              fontSize: narrow ? 22 : 26,
              lineHeight: 1.25,
              letterSpacing: '-0.012em',
              color: 'var(--ink)',
            }}
          >
            {title}
          </h1>
          {subtitle && (
            <p style={{ margin: 0, fontSize: 13, color: 'var(--muted)' }}>
              {subtitle}
            </p>
          )}
        </header>
        {children}
      </div>
    </div>
  )
}

type SectionMode = 'static' | 'collapsible'

function StaticSection({
  title,
  desc,
  children,
}: {
  id: ApplySectionId
  title: string
  desc?: string
  children: React.ReactNode
}) {
  return <Section title={title} desc={desc}>{children}</Section>
}

function CollapsibleSection({
  id,
  title,
  desc,
  expanded,
  onToggle,
  children,
}: {
  id: ApplySectionId
  title: string
  desc?: string
  expanded: boolean
  onToggle: () => void
  children: React.ReactNode
}) {
  const panelId = `apply-section-${id}`
  return (
    <section
      style={{
        border: '1px solid var(--hairline)',
        borderRadius: 'var(--radius)',
        background: 'var(--paper-deep)',
        overflow: 'hidden',
      }}
    >
      <button
        type="button"
        id={`${panelId}-trigger`}
        aria-expanded={expanded}
        aria-controls={panelId}
        onClick={onToggle}
        style={{
          width: '100%',
          display: 'flex',
          alignItems: 'flex-start',
          justifyContent: 'space-between',
          gap: 12,
          padding: '14px 16px',
          minHeight: CONTROL_MIN_TAP,
          textAlign: 'left',
          background: expanded ? 'var(--leaf-soft)' : 'var(--leaf)',
          border: 0,
          borderBottom: expanded ? '1px solid var(--hairline-soft)' : 'none',
          cursor: 'pointer',
        }}
      >
        <span style={{ display: 'flex', flexDirection: 'column', gap: 4, minWidth: 0 }}>
          <span
            className="serif"
            style={{
              fontSize: 16,
              color: 'var(--ink)',
              letterSpacing: '0.01em',
            }}
          >
            {title}
          </span>
          {desc && (
            <span
              style={{
                fontSize: 12,
                color: 'var(--muted)',
                lineHeight: 1.45,
              }}
            >
              {desc}
            </span>
          )}
        </span>
        <span
          aria-hidden
          style={{
            flexShrink: 0,
            fontSize: 12,
            color: 'var(--faint)',
            marginTop: 4,
            transform: expanded ? 'rotate(90deg)' : 'none',
            transition: 'transform 160ms var(--ease-out-quart)',
          }}
        >
          ›
        </span>
      </button>
      {expanded && (
        <div
          id={panelId}
          role="region"
          aria-labelledby={`${panelId}-trigger`}
          style={{
            padding: '16px 16px 18px',
            display: 'flex',
            flexDirection: 'column',
            gap: 14,
          }}
        >
          {children}
        </div>
      )}
    </section>
  )
}

function SectionWrap(props: {
  mode: SectionMode
  id: ApplySectionId
  title: string
  desc?: string
  expanded: boolean
  onToggle: () => void
  children: React.ReactNode
}) {
  if (props.mode === 'static') {
    return (
      <StaticSection
        id={props.id}
        title={props.title}
        desc={props.desc}
      >
        {props.children}
      </StaticSection>
    )
  }
  return (
    <CollapsibleSection
      id={props.id}
      title={props.title}
      desc={props.desc}
      expanded={props.expanded}
      onToggle={props.onToggle}
    >
      {props.children}
    </CollapsibleSection>
  )
}

function Section({
  title,
  desc,
  children,
}: {
  title: string
  desc?: string
  children: React.ReactNode
}) {
  return (
    <section style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
      <header style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
        <h2
          className="serif"
          style={{
            margin: 0,
            fontSize: 16,
            color: 'var(--ink)',
            letterSpacing: '0.01em',
          }}
        >
          {title}
        </h2>
        {desc && (
          <p style={{ margin: 0, fontSize: 12, color: 'var(--muted)' }}>
            {desc}
          </p>
        )}
      </header>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
        {children}
      </div>
    </section>
  )
}

function Row({ children }: { children: React.ReactNode }) {
  return (
    <div
      style={{
        display: 'grid',
        gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))',
        gap: 12,
      }}
    >
      {children}
    </div>
  )
}

function Field({
  label,
  value,
  onChange,
  type = 'text',
  required,
  autoFocus,
  placeholder,
}: {
  label: string
  value: string
  onChange: (v: string) => void
  type?: string
  required?: boolean
  autoFocus?: boolean
  placeholder?: string
}) {
  return (
    <label style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
      <span style={{ fontSize: 12, color: 'var(--muted)', fontWeight: 500 }}>
        {label}
      </span>
      <input
        type={type}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        required={required}
        autoFocus={autoFocus}
        placeholder={placeholder}
        min={type === 'number' ? BIRTH_YEAR_MIN : undefined}
        max={type === 'number' ? new Date().getFullYear() : undefined}
        style={inputStyle}
      />
    </label>
  )
}

function SelectField({
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
    <label style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
      <span style={{ fontSize: 12, color: 'var(--muted)', fontWeight: 500 }}>
        {label}
      </span>
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
  placeholder,
}: {
  label: string
  value: string
  onChange: (v: string) => void
  rows?: number
  placeholder?: string
}) {
  return (
    <label style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
      <span style={{ fontSize: 12, color: 'var(--muted)', fontWeight: 500 }}>
        {label}
      </span>
      <textarea
        value={value}
        onChange={(e) => onChange(e.target.value)}
        rows={rows}
        placeholder={placeholder}
        style={{
          ...inputStyle,
          minHeight: Math.max(CONTROL_MIN_TAP * 2, rows * 26),
          height: 'auto',
          padding: '12px 14px',
          fontFamily: 'var(--font-sans)',
          fontSize: 16,
          lineHeight: 1.55,
          resize: 'vertical',
        }}
      />
    </label>
  )
}

const inputStyle: React.CSSProperties = {
  minHeight: CONTROL_MIN_TAP,
  width: '100%',
  borderRadius: 'var(--radius-sm)',
  border: '1px solid var(--hairline)',
  background: 'var(--paper)',
  padding: '0 14px',
  fontSize: 16,
  color: 'var(--ink)',
  outline: 'none',
  transition: 'border-color 160ms var(--ease-out-quart)',
  lineHeight: 1.35,
}
