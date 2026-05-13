import './app.css'
import { useAuth } from './lib/auth-context'
import { LoginGate } from './components/login-gate'
import { WarRoom } from './components/war-room'

function App() {
  const auth = useAuth()

  if (auth.status === 'loading') {
    return <BootScreen message="正在校验会话…" />
  }

  if (auth.status === 'anonymous') {
    return <LoginGate />
  }

  if (!auth.tenant) {
    return (
      <BootScreen message="还没有可用的工作区。让 owner 把你加入一个 tenant。" />
    )
  }

  return <WarRoom />
}

function BootScreen({ message }: { message: string }) {
  return (
    <div
      style={{
        minHeight: '100svh',
        display: 'grid',
        placeItems: 'center',
        padding: 24,
      }}
    >
      <p
        className="serif"
        style={{
          margin: 0,
          fontSize: 16,
          color: 'var(--muted)',
          letterSpacing: '0.04em',
        }}
      >
        {message}
      </p>
    </div>
  )
}

export default App
