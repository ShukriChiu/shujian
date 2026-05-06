import { useEffect, useRef } from 'react'
import { Navigate, useLocation } from 'react-router-dom'
import { toast } from 'sonner'
import { useAuth } from '@/lib/auth-context'

/**
 * Guards the protected route tree. Three states:
 *
 * - loading      → render nothing (root background covers it)
 * - anonymous    → redirect to /login, preserving intended path. If we just
 *                  fell from authenticated → anonymous (token expired), fire
 *                  a toast so the user knows why they got bounced.
 * - authenticated → children
 */
export function AuthGate({ children }: { children: React.ReactNode }) {
  const auth = useAuth()
  const location = useLocation()
  const wasAuthRef = useRef(false)

  useEffect(() => {
    if (auth.status === 'authenticated') {
      wasAuthRef.current = true
      return
    }
    if (auth.status === 'anonymous' && wasAuthRef.current) {
      toast.error('会话已过期，请重新登录')
      wasAuthRef.current = false
    }
  }, [auth.status])

  if (auth.status === 'loading') {
    return <div className="h-full bg-bg" />
  }
  if (auth.status === 'anonymous') {
    const next = location.pathname + location.search
    return <Navigate to={`/login?next=${encodeURIComponent(next)}`} replace />
  }
  return <>{children}</>
}
