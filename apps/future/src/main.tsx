import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { createBrowserRouter, Navigate, RouterProvider } from 'react-router-dom'
import './index.css'
import { AuthProvider } from './lib/auth-context'
import { AdminShell } from './components/admin-shell'
import { StudentListPage } from './pages/student-list'
import { StudentDetailPage } from './pages/student-detail'
import { ProjectsPage } from './pages/projects'
import { ShareLinkPage } from './pages/share-link'
import { ApplyPage } from './pages/apply'
import { ApplySuccessPage } from './pages/apply-success'

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 1000 * 30,
      gcTime: 1000 * 60 * 30,
      retry: 1,
      refetchOnWindowFocus: false,
    },
  },
})

const router = createBrowserRouter([
  {
    path: '/apply/:token',
    element: <ApplyPage />,
  },
  {
    path: '/apply/:token/done',
    element: <ApplySuccessPage />,
  },
  {
    path: '/',
    element: <AdminShell />,
    children: [
      { index: true, element: <Navigate to="/students" replace /> },
      { path: 'students', element: <StudentListPage /> },
      { path: 'students/:id', element: <StudentDetailPage /> },
      { path: 'projects', element: <ProjectsPage /> },
      { path: 'share', element: <ShareLinkPage /> },
    ],
  },
])

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <AuthProvider>
        <RouterProvider router={router} />
      </AuthProvider>
    </QueryClientProvider>
  </StrictMode>,
)
