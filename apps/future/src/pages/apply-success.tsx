import { useLocation, useParams } from 'react-router-dom'

interface NavState {
  tenantName?: string
  studentId?: string
  fullName?: string
}

export function ApplySuccessPage() {
  const { token } = useParams<{ token: string }>()
  const { state } = useLocation() as { state: NavState | null }
  const tenantName = state?.tenantName ?? '工作区'
  const fullName = state?.fullName

  return (
    <div
      style={{
        minHeight: '100svh',
        padding: '40px 16px 80px',
        display: 'flex',
        justifyContent: 'center',
      }}
    >
      <div
        style={{
          width: 'min(540px, 100%)',
          background: 'var(--leaf)',
          border: '1px solid var(--hairline)',
          borderRadius: 'var(--radius-lg)',
          boxShadow: 'var(--paper-shadow)',
          padding: '48px 32px',
          display: 'flex',
          flexDirection: 'column',
          gap: 24,
          alignItems: 'center',
          textAlign: 'center',
        }}
      >
        <span
          className="eyebrow"
          style={{ color: 'var(--moss)', letterSpacing: '0.18em' }}
        >
          submission received
        </span>
        <h1
          className="serif"
          style={{
            margin: 0,
            fontSize: 28,
            lineHeight: 1.25,
            color: 'var(--ink)',
          }}
        >
          {fullName ? `${fullName}，` : ''}申请已提交
        </h1>
        <p
          style={{
            margin: 0,
            fontSize: 14,
            color: 'var(--muted)',
            maxWidth: 420,
            lineHeight: 1.7,
          }}
        >
          {tenantName} 收到了你的卷宗。管理员会在几天内审阅，如果合适，会通过你提供的微信主动联系你，记得留意陌生微信添加请求。
        </p>
        <p
          className="mono"
          style={{
            fontSize: 11,
            color: 'var(--faint)',
            margin: 0,
            letterSpacing: '0.08em',
          }}
        >
          token · {token?.slice(0, 8)}…
        </p>
      </div>
    </div>
  )
}
