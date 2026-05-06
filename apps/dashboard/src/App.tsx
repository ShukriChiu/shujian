import { useState } from 'react'
import { Activity, Bot, Settings, Sparkles } from 'lucide-react'
import { cn } from './lib/utils'
import { OverviewView } from './views/overview/OverviewView'
import { LocalAgentsView } from './views/local-agents/LocalAgentsView'
import { CursorAgentsView } from './views/cursor-agents/CursorAgentsView'
import { SettingsView } from './views/settings/SettingsView'
import { TopBar } from './components/TopBar'

type Tab = 'overview' | 'local' | 'cursor' | 'settings'

const TABS: Array<{ id: Tab; label: string; icon: React.ComponentType<{ className?: string }> }> = [
  { id: 'overview', label: '总览', icon: Activity },
  { id: 'local', label: '本地 Agents', icon: Bot },
  { id: 'cursor', label: 'Cursor Agents', icon: Sparkles },
  { id: 'settings', label: '设置', icon: Settings },
]

export function App() {
  const [tab, setTab] = useState<Tab>('overview')

  return (
    <div className="flex h-full flex-col">
      <TopBar />
      <div className="flex flex-1 overflow-hidden">
        <aside className="hidden w-56 shrink-0 border-r border-ink-200/70 bg-white/60 backdrop-blur md:block">
          <nav className="flex flex-col gap-0.5 p-3">
            {TABS.map((t) => {
              const Icon = t.icon
              const active = tab === t.id
              return (
                <button
                  key={t.id}
                  onClick={() => setTab(t.id)}
                  className={cn(
                    'group flex h-9 items-center gap-2.5 rounded-md px-2.5 text-sm font-medium transition',
                    active
                      ? 'bg-ink-900 text-white shadow-sm'
                      : 'text-ink-600 hover:bg-ink-100 hover:text-ink-900',
                  )}
                >
                  <Icon
                    className={cn(
                      'h-4 w-4',
                      active ? 'text-white' : 'text-ink-400 group-hover:text-ink-600',
                    )}
                  />
                  {t.label}
                </button>
              )
            })}
          </nav>
          <div className="mt-2 px-3">
            <div className="rounded-md border border-ink-200 bg-white px-3 py-2 text-[11px] text-ink-500">
              <div className="font-medium text-ink-700">Runtime</div>
              <div className="mt-1">Rust agent · :8002</div>
              <div>shujian-agent-bridge · N×endpoints</div>
            </div>
          </div>
        </aside>

        <main className="flex-1 overflow-y-auto scroll-thin">
          {/* mobile tabs */}
          <div className="flex gap-1 border-b border-ink-200/70 bg-white/80 px-3 py-2 md:hidden">
            {TABS.map((t) => (
              <button
                key={t.id}
                onClick={() => setTab(t.id)}
                className={cn(
                  'h-8 rounded-md px-2.5 text-xs font-medium',
                  tab === t.id ? 'bg-ink-900 text-white' : 'text-ink-600 hover:bg-ink-100',
                )}
              >
                {t.label}
              </button>
            ))}
          </div>
          <div className="mx-auto max-w-[1280px] animate-fade-up p-5">
            {tab === 'overview' && <OverviewView />}
            {tab === 'local' && <LocalAgentsView />}
            {tab === 'cursor' && <CursorAgentsView />}
            {tab === 'settings' && <SettingsView />}
          </div>
        </main>
      </div>
    </div>
  )
}
