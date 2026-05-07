import { Suspense, lazy } from 'react'
import { Navigate, Outlet, createBrowserRouter } from 'react-router-dom'
import { AppShell } from './components/AppShell'
import { AuthGate } from './components/AuthGate'
import { RouteFallback } from './components/RouteFallback'

const LoginView = lazy(() => import('./views/login/LoginView').then((m) => ({ default: m.LoginView })))
const AgentsView = lazy(() => import('./views/agents/AgentsView').then((m) => ({ default: m.AgentsView })))
const WorkspaceView = lazy(() =>
  import('./views/workspace/WorkspaceView').then((m) => ({ default: m.WorkspaceView })),
)
const VaultsView = lazy(() => import('./views/vaults/VaultsView').then((m) => ({ default: m.VaultsView })))
const PersonasView = lazy(() =>
  import('./views/personas/PersonasView').then((m) => ({ default: m.PersonasView })),
)
const SettingsView = lazy(() =>
  import('./views/settings/SettingsView').then((m) => ({ default: m.SettingsView })),
)
const BillingView = lazy(() =>
  import('./views/billing/BillingView').then((m) => ({ default: m.BillingView })),
)
const SchedulesView = lazy(() =>
  import('./views/schedules/SchedulesView').then((m) => ({ default: m.SchedulesView })),
)
const AuditView = lazy(() => import('./views/audit/AuditView').then((m) => ({ default: m.AuditView })))

function ProtectedLayout() {
  return (
    <AuthGate>
      <AppShell>
        <Suspense fallback={<RouteFallback />}>
          <Outlet />
        </Suspense>
      </AppShell>
    </AuthGate>
  )
}

export const router = createBrowserRouter([
  {
    path: '/login',
    element: (
      <Suspense fallback={<RouteFallback />}>
        <LoginView />
      </Suspense>
    ),
  },
  {
    path: '/',
    element: <ProtectedLayout />,
    children: [
      { index: true, element: <Navigate to="/agents" replace /> },
      { path: 'agents', element: <AgentsView /> },
      { path: 'workspace', element: <WorkspaceView /> },
      { path: 'vaults', element: <VaultsView /> },
      { path: 'personas', element: <PersonasView /> },
      { path: 'schedules', element: <SchedulesView /> },
      { path: 'audit-log', element: <AuditView /> },
      { path: 'billing', element: <BillingView /> },
      { path: 'settings', element: <SettingsView /> },
      { path: 'settings/:section', element: <SettingsView /> },
      { path: '*', element: <Navigate to="/agents" replace /> },
    ],
  },
])
