import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react'
import {
  backend,
  getActiveTenantId,
  getToken,
  setActiveTenantId,
  setUnauthorizedHandler,
  type MeResponse,
  type TenantPublic,
  type UserPublic,
} from './backend'

interface AuthState {
  status: 'loading' | 'anonymous' | 'authenticated'
  user: UserPublic | null
  tenant: TenantPublic | null
  tenants: TenantPublic[]
  error: string | null
}

interface AuthContextValue extends AuthState {
  login: (identifier: string, password: string) => Promise<void>
  logout: () => Promise<void>
  switchTenant: (id: string) => Promise<void>
  refresh: () => Promise<void>
}

const AuthContext = createContext<AuthContextValue | null>(null)

const initial: AuthState = {
  status: 'loading',
  user: null,
  tenant: null,
  tenants: [],
  error: null,
}

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [state, setState] = useState<AuthState>(initial)
  const sessionExpiredRef = useRef(false)

  const refresh = useCallback(async () => {
    if (!getToken()) {
      setState({ status: 'anonymous', user: null, tenant: null, tenants: [], error: null })
      return
    }
    try {
      const me = await backend.me()
      setState({
        status: 'authenticated',
        user: me.user,
        tenant: pickActiveTenant(me),
        tenants: me.tenants,
        error: null,
      })
    } catch {
      setState({ status: 'anonymous', user: null, tenant: null, tenants: [], error: null })
    }
  }, [])

  useEffect(() => {
    setUnauthorizedHandler(() => {
      sessionExpiredRef.current = true
      setState({ status: 'anonymous', user: null, tenant: null, tenants: [], error: null })
    })
    return () => setUnauthorizedHandler(null)
  }, [])

  useEffect(() => {
    void refresh()
  }, [refresh])

  const login = useCallback(async (identifier: string, password: string) => {
    setState((s) => ({ ...s, error: null }))
    const r = await backend.login(identifier, password)
    sessionExpiredRef.current = false
    setState({
      status: 'authenticated',
      user: r.user,
      tenant: pickActiveTenant(r),
      tenants: r.tenants,
      error: null,
    })
  }, [])

  const logout = useCallback(async () => {
    await backend.logout()
    setState({ status: 'anonymous', user: null, tenant: null, tenants: [], error: null })
  }, [])

  const switchTenant = useCallback(async (id: string) => {
    const next = state.tenants.find((t) => t.id === id)
    if (next) {
      setActiveTenantId(id)
      setState((s) => ({ ...s, tenant: next }))
    }
    try {
      const me = await backend.switchTenant(id)
      setState((s) => ({ ...s, tenant: pickActiveTenant(me), tenants: me.tenants }))
    } catch {
      /* server-side switch is advisory; UI already updated */
    }
  }, [state.tenants])

  const value = useMemo<AuthContextValue>(
    () => ({ ...state, login, logout, switchTenant, refresh }),
    [state, login, logout, switchTenant, refresh],
  )

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>
}

function pickActiveTenant(me: MeResponse): TenantPublic | null {
  if (me.current_tenant) return me.current_tenant
  const stored = getActiveTenantId()
  if (stored) {
    const found = me.tenants.find((t) => t.id === stored)
    if (found) return found
  }
  return me.tenants[0] ?? null
}

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext)
  if (!ctx) throw new Error('useAuth must be inside AuthProvider')
  return ctx
}
