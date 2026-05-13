import { useState } from 'react'
import {
  useMutation,
  useQuery,
  useQueryClient,
} from '@tanstack/react-query'
import { backend } from '../lib/backend'
import { PageHeader } from './student-list'

export function ShareLinkPage() {
  const qc = useQueryClient()
  const link = useQuery({
    queryKey: ['shareLink'],
    queryFn: () => backend.shareLink.get(),
  })

  const [copied, setCopied] = useState(false)
  const [labelDraft, setLabelDraft] = useState<string | null>(null)

  const update = useMutation({
    mutationFn: backend.shareLink.update,
    onSuccess: (data) => {
      qc.setQueryData(['shareLink'], data)
      setLabelDraft(null)
    },
  })

  const rotate = useMutation({
    mutationFn: backend.shareLink.rotate,
    onSuccess: (data) => qc.setQueryData(['shareLink'], data),
  })

  if (link.isLoading) {
    return <p style={{ color: 'var(--muted)' }}>加载中…</p>
  }
  if (link.isError) {
    return (
      <p
        style={{
          color: 'var(--vermilion-deep)',
          background: 'var(--vermilion-soft)',
          padding: 12,
          borderRadius: 'var(--radius-sm)',
        }}
      >
        {(link.error as Error).message}
      </p>
    )
  }

  const data = link.data!
  const url = `${window.location.origin}/apply/${data.token}`

  async function copy() {
    try {
      await navigator.clipboard.writeText(url)
      setCopied(true)
      setTimeout(() => setCopied(false), 1800)
    } catch {
      /* ignore — user can select and copy manually */
    }
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 24, maxWidth: 720 }}>
      <PageHeader
        title="招募链接"
        subtitle="把这个链接发给候选人，他们就能填问卷加入"
      />

      <section
        style={{
          background: 'var(--leaf)',
          border: '1px solid var(--hairline)',
          borderRadius: 'var(--radius-lg)',
          padding: 24,
          display: 'flex',
          flexDirection: 'column',
          gap: 16,
        }}
      >
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            gap: 12,
            flexWrap: 'wrap',
          }}
        >
          <h2
            className="serif"
            style={{ margin: 0, fontSize: 18, color: 'var(--ink)' }}
          >
            当前链接
          </h2>
          <ToggleSwitch
            on={data.isOpen}
            label={data.isOpen ? '招募中' : '已关闭'}
            disabled={update.isPending}
            onChange={(v) => update.mutate({ isOpen: v })}
          />
        </div>

        <div
          className="mono"
          style={{
            fontSize: 14,
            padding: 14,
            background: 'var(--paper)',
            border: '1px solid var(--hairline)',
            borderRadius: 'var(--radius)',
            color: 'var(--ink-soft)',
            wordBreak: 'break-all',
            lineHeight: 1.5,
          }}
        >
          {url}
        </div>

        <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
          <button onClick={copy} style={btnPrimary}>
            {copied ? '已复制 ✓' : '复制链接'}
          </button>
          <a
            href={url}
            target="_blank"
            rel="noreferrer"
            style={{
              ...btnSecondary,
              textDecoration: 'none',
              display: 'inline-flex',
              alignItems: 'center',
            }}
          >
            打开预览 ↗
          </a>
          <button
            onClick={() => {
              if (
                confirm(
                  '重置 token 后，原来的链接立即失效。已经填过的学生不会丢失。要继续吗？',
                )
              ) {
                rotate.mutate()
              }
            }}
            style={{
              ...btnSecondary,
              color: 'var(--vermilion-deep)',
              borderColor: 'var(--vermilion-soft)',
              marginLeft: 'auto',
            }}
            disabled={rotate.isPending}
          >
            {rotate.isPending ? '重置中…' : '重置 token'}
          </button>
        </div>

        <div
          style={{
            display: 'flex',
            flexDirection: 'column',
            gap: 6,
            paddingTop: 8,
            borderTop: '1px dashed var(--hairline-soft)',
          }}
        >
          <span style={{ fontSize: 11, color: 'var(--muted)' }}>
            链接标题（学生在打开链接时会看到）
          </span>
          <div style={{ display: 'flex', gap: 8 }}>
            <input
              value={labelDraft ?? data.label}
              onChange={(e) => setLabelDraft(e.target.value)}
              style={{
                flex: 1,
                height: 36,
                padding: '0 12px',
                fontSize: 14,
                color: 'var(--ink)',
                background: 'var(--paper)',
                border: '1px solid var(--hairline)',
                borderRadius: 'var(--radius-sm)',
                outline: 'none',
              }}
            />
            {labelDraft !== null && labelDraft !== data.label && (
              <button
                onClick={() => update.mutate({ label: labelDraft })}
                style={btnPrimary}
                disabled={update.isPending}
              >
                保存
              </button>
            )}
          </div>
        </div>
      </section>

      <section
        style={{
          fontSize: 12.5,
          color: 'var(--muted)',
          lineHeight: 1.7,
          padding: 16,
          background: 'var(--leaf-soft)',
          border: '1px solid var(--hairline-soft)',
          borderRadius: 'var(--radius)',
        }}
      >
        <p style={{ margin: '0 0 6px' }}>使用建议：</p>
        <ul style={{ margin: 0, paddingLeft: 18, display: 'flex', flexDirection: 'column', gap: 4 }}>
          <li>
            把链接发到群里 / 朋友圈 / 招募贴中。学生不需要登录就能填。
          </li>
          <li>
            提交后会进入「学生」页面 status=新申请，等你审核。
          </li>
          <li>
            一期招完了可以暂时关闭链接，下一期重新开。
          </li>
          <li>
            如果链接外泄，重置 token 即可作废。
          </li>
        </ul>
      </section>
    </div>
  )
}

function ToggleSwitch({
  on,
  label,
  disabled,
  onChange,
}: {
  on: boolean
  label: string
  disabled?: boolean
  onChange: (next: boolean) => void
}) {
  return (
    <button
      onClick={() => onChange(!on)}
      disabled={disabled}
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 10,
        padding: '4px 12px 4px 4px',
        background: on ? 'var(--moss-soft)' : 'var(--inset)',
        border: `1px solid ${on ? 'var(--moss-soft)' : 'var(--hairline)'}`,
        borderRadius: 999,
        opacity: disabled ? 0.55 : 1,
      }}
    >
      <span
        style={{
          width: 26,
          height: 16,
          borderRadius: 999,
          background: on ? 'var(--moss)' : 'var(--faint)',
          position: 'relative',
          transition: 'all 160ms var(--ease-out-quart)',
        }}
      >
        <span
          style={{
            position: 'absolute',
            top: 2,
            left: on ? 12 : 2,
            width: 12,
            height: 12,
            borderRadius: 999,
            background: 'var(--paper)',
            transition: 'left 160ms var(--ease-out-quart)',
          }}
        />
      </span>
      <span
        style={{
          fontSize: 12,
          fontWeight: 500,
          color: on ? 'var(--moss)' : 'var(--ink-soft)',
        }}
      >
        {label}
      </span>
    </button>
  )
}

const btnPrimary: React.CSSProperties = {
  padding: '8px 16px',
  fontSize: 13,
  fontWeight: 500,
  letterSpacing: '0.04em',
  color: 'var(--paper)',
  background: 'var(--ink)',
  borderRadius: 'var(--radius-sm)',
}

const btnSecondary: React.CSSProperties = {
  padding: '8px 14px',
  fontSize: 13,
  color: 'var(--ink-soft)',
  background: 'transparent',
  border: '1px solid var(--hairline-strong)',
  borderRadius: 'var(--radius-sm)',
}
