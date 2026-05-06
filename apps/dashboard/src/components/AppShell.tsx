import { useEffect, useState } from 'react'
import { useLocation } from 'react-router-dom'
import { Sidebar } from './Sidebar'
import { Topbar } from './Topbar'
import { CommandMenu } from './CommandMenu'
import { cn } from '@/lib/utils'

export function AppShell({ children }: { children: React.ReactNode }) {
  const [cmdOpen, setCmdOpen] = useState(false)
  const [navOpen, setNavOpen] = useState(false)
  const loc = useLocation()

  useEffect(() => {
    setNavOpen(false)
  }, [loc.pathname])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault()
        setCmdOpen((v) => !v)
      }
      if (e.key === 'Escape') {
        setNavOpen(false)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  return (
    <div className="relative flex h-full overflow-hidden bg-bg text-ink">
      <div
        aria-hidden={!navOpen}
        onClick={() => setNavOpen(false)}
        className={cn(
          'fixed inset-0 z-30 bg-bg/70 backdrop-blur-[2px] transition-opacity duration-200 lg:hidden',
          navOpen ? 'opacity-100' : 'pointer-events-none opacity-0',
        )}
      />
      <Sidebar
        onOpenCommand={() => setCmdOpen(true)}
        mobileOpen={navOpen}
        onMobileClose={() => setNavOpen(false)}
      />
      <div className="flex min-w-0 flex-1 flex-col">
        <Topbar
          onOpenCommand={() => setCmdOpen(true)}
          onOpenNav={() => setNavOpen(true)}
        />
        <main className="flex-1 overflow-y-auto scroll-thin animate-fade-in">{children}</main>
      </div>
      <CommandMenu open={cmdOpen} onClose={() => setCmdOpen(false)} />
    </div>
  )
}
