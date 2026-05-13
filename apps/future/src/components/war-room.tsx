import {
  DndContext,
  DragOverlay,
  PointerSensor,
  useSensor,
  useSensors,
  type DragEndEvent,
  type DragStartEvent,
} from '@dnd-kit/core'
import { AnimatePresence } from 'motion/react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Cloud, CloudOff, Download, Loader2, LogOut, Plus, Upload } from 'lucide-react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import {
  exportData,
  importData,
  loadData,
  safeId,
  saveData,
} from '../lib/storage'
import type {
  Feedback,
  Project,
  Squad,
  Student,
  WarRoomData,
} from '../lib/types'
import { useAuth } from '../lib/auth-context'
import { ProjectLane, NewLaneCard } from './project-lane'
import { StudentRoster } from './student-roster'
import { TheatreView } from './theatre-view'
import { EntityDrawer } from './entity-drawer'
import { StudentChip } from './student-chip'

type DrawerState =
  | { kind: 'student'; mode: 'create' | 'edit'; initial?: Student }
  | { kind: 'project'; mode: 'create' | 'edit'; initial?: Project }
  | null

type SyncStatus = 'idle' | 'saving' | 'saved' | 'error'

/**
 * WarRoom is the page-level container. It loads tenant-scoped data from
 * `apps/backend` via `GET /v1/future/state` and gates rendering on it.
 *
 * Once data is loaded, the actual UI lives in `<WarRoomInner />`. Local
 * edits drive optimistic state there and are debounced back to the server
 * (`PUT /v1/future/state`) — last-write-wins, single-editor-per-tenant.
 */
export function WarRoom() {
  const auth = useAuth()
  const tenantId = auth.tenant?.id

  const stateQuery = useQuery({
    queryKey: ['future', 'state', tenantId],
    queryFn: loadData,
    enabled: !!tenantId,
    staleTime: Infinity,
    refetchOnWindowFocus: false,
  })

  if (!tenantId) {
    return <BootCard message="还没有可用的工作区。" />
  }
  if (stateQuery.isLoading) {
    return <BootCard message="正在加载工作区…" />
  }
  if (stateQuery.isError || !stateQuery.data) {
    const msg =
      stateQuery.error instanceof Error
        ? stateQuery.error.message
        : '加载失败'
    return <BootCard tone="alert" message={`加载失败：${msg}`} />
  }

  return (
    <WarRoomInner
      key={tenantId}
      initial={stateQuery.data}
      tenantId={tenantId}
    />
  )
}

function WarRoomInner({
  initial,
  tenantId,
}: {
  initial: WarRoomData
  tenantId: string
}) {
  const auth = useAuth()
  const queryClient = useQueryClient()

  const [data, setData] = useState<WarRoomData>(initial)
  const [activeStudent, setActiveStudent] = useState<Student | null>(null)
  const [drawer, setDrawer] = useState<DrawerState>(null)
  const [theatreId, setTheatreId] = useState<string | null>(null)
  const [syncStatus, setSyncStatus] = useState<SyncStatus>('saved')
  const [syncError, setSyncError] = useState<string | null>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 6 } }),
  )

  // Local -> server. Debounce so a burst of edits (drag, type, drag) collapses
  // into a single PUT. Last-write-wins is fine for the current single-editor
  // usage; collaborative editing is a follow-up that would need per-entity
  // mutations and either ETag-style optimistic concurrency or CRDTs.
  const lastSyncedJsonRef = useRef<string>(JSON.stringify(initial))

  const saveMutation = useMutation({
    mutationFn: saveData,
    onMutate: () => {
      setSyncStatus('saving')
      setSyncError(null)
    },
    onSuccess: (server) => {
      setSyncStatus('saved')
      // Refresh the cache so a subsequent navigation away/back skips the
      // GET round-trip and uses canonical server state.
      queryClient.setQueryData(['future', 'state', tenantId], server)
    },
    onError: (err) => {
      setSyncStatus('error')
      setSyncError(err instanceof Error ? err.message : '保存失败')
      // Roll the marker back so the next edit retries the failed save.
      lastSyncedJsonRef.current = ''
    },
  })
  const { mutate: saveMutate } = saveMutation

  useEffect(() => {
    const json = JSON.stringify(data)
    if (json === lastSyncedJsonRef.current) return
    const handle = setTimeout(() => {
      lastSyncedJsonRef.current = json
      saveMutate(data)
    }, 600)
    return () => clearTimeout(handle)
  }, [data, saveMutate])

  const membersByProject = useMemo(() => {
    const map = new Map<string, Student[]>()
    for (const project of data.projects) map.set(project.id, [])
    for (const squad of data.squads) {
      const student = data.students.find((s) => s.id === squad.studentId)
      if (!student) continue
      const arr = map.get(squad.projectId)
      if (arr) arr.push(student)
    }
    return map
  }, [data])

  const unassignedIds = useMemo(() => {
    const assigned = new Set(data.squads.map((s) => s.studentId))
    const set = new Set<string>()
    for (const stu of data.students) if (!assigned.has(stu.id)) set.add(stu.id)
    return set
  }, [data])

  const totalAssigned = data.squads.length
  const totalSlots = data.projects.reduce((acc, p) => acc + p.teamSize, 0)
  const overallFill = totalSlots ? Math.round((totalAssigned / totalSlots) * 100) : 0

  const handleDragStart = useCallback(
    (e: DragStartEvent) => {
      const studentId = e.active.data.current?.studentId as string | undefined
      const stu = data.students.find((s) => s.id === studentId) ?? null
      setActiveStudent(stu)
    },
    [data.students],
  )

  const handleDragEnd = useCallback((e: DragEndEvent) => {
    setActiveStudent(null)
    const studentId = e.active.data.current?.studentId as string | undefined
    const fromLane = (e.active.data.current?.fromLane ?? null) as string | null
    if (!studentId) return
    const overData = e.over?.data.current as
      | { kind: 'lane'; projectId: string }
      | { kind: 'roster' }
      | undefined
    if (!overData) return

    setData((prev) => {
      let squads: Squad[] = prev.squads
      if (overData.kind === 'roster') {
        if (fromLane) {
          squads = squads.filter(
            (s) => !(s.studentId === studentId && s.projectId === fromLane),
          )
        }
        return { ...prev, squads }
      }

      const targetProjectId = overData.projectId
      if (fromLane === targetProjectId) return prev

      const project = prev.projects.find((p) => p.id === targetProjectId)
      if (!project) return prev
      const currentMembers = squads.filter((s) => s.projectId === targetProjectId)
      if (currentMembers.length >= project.teamSize) return prev
      if (
        squads.some(
          (s) => s.studentId === studentId && s.projectId === targetProjectId,
        )
      )
        return prev

      if (fromLane) {
        squads = squads.filter(
          (s) => !(s.studentId === studentId && s.projectId === fromLane),
        )
      }
      squads = [
        ...squads,
        {
          studentId,
          projectId: targetProjectId,
          role: '队员',
          joinedAt: new Date().toISOString().slice(0, 10),
        },
      ]
      return { ...prev, squads }
    })
  }, [])

  function saveStudent(draft: Omit<Student, 'id'>, id?: string) {
    setData((prev) => {
      if (id) {
        return {
          ...prev,
          students: prev.students.map((s) => (s.id === id ? { ...draft, id } : s)),
        }
      }
      return {
        ...prev,
        students: [{ ...draft, id: safeId('stu') }, ...prev.students],
      }
    })
  }

  function deleteStudent(id: string) {
    setData((prev) => ({
      ...prev,
      students: prev.students.filter((s) => s.id !== id),
      squads: prev.squads.filter((s) => s.studentId !== id),
      feedback: prev.feedback.filter((f) => f.studentId !== id),
    }))
    setDrawer(null)
  }

  function saveProject(draft: Omit<Project, 'id'>, id?: string) {
    setData((prev) => {
      if (id) {
        return {
          ...prev,
          projects: prev.projects.map((p) => (p.id === id ? { ...draft, id } : p)),
        }
      }
      return {
        ...prev,
        projects: [...prev.projects, { ...draft, id: safeId('pro') }],
      }
    })
  }

  function deleteProject(id: string) {
    setData((prev) => ({
      ...prev,
      projects: prev.projects.filter((p) => p.id !== id),
      squads: prev.squads.filter((s) => s.projectId !== id),
      feedback: prev.feedback.filter((f) => f.projectId !== id),
    }))
    setDrawer(null)
    if (theatreId === id) setTheatreId(null)
  }

  function removeMember(projectId: string, studentId: string) {
    setData((prev) => ({
      ...prev,
      squads: prev.squads.filter(
        (s) => !(s.studentId === studentId && s.projectId === projectId),
      ),
    }))
  }

  function addFeedback(f: Omit<Feedback, 'id' | 'projectId'>, projectId?: string) {
    setData((prev) => ({
      ...prev,
      feedback: [{ ...f, id: safeId('fed'), projectId }, ...prev.feedback],
    }))
  }

  function openTheatre(id: string) {
    if (typeof document !== 'undefined' && 'startViewTransition' in document) {
      ;(document as Document & {
        startViewTransition: (cb: () => void) => unknown
      }).startViewTransition(() => setTheatreId(id))
      return
    }
    setTheatreId(id)
  }

  function closeTheatre() {
    if (typeof document !== 'undefined' && 'startViewTransition' in document) {
      ;(document as Document & {
        startViewTransition: (cb: () => void) => unknown
      }).startViewTransition(() => setTheatreId(null))
      return
    }
    setTheatreId(null)
  }

  const focusedProject = theatreId
    ? data.projects.find((p) => p.id === theatreId) ?? null
    : null

  const tenantLabel =
    auth.tenant?.display_name ?? auth.tenant?.name ?? auth.tenant?.slug ?? '工作区'

  return (
    <DndContext
      sensors={sensors}
      onDragStart={handleDragStart}
      onDragEnd={handleDragEnd}
      onDragCancel={() => setActiveStudent(null)}
    >
      <div className="folio-shell">
        <header className="masthead">
          <div className="masthead-brand">
            <div className="masthead-mark" aria-hidden>
              <span className="serif">书</span>
            </div>
            <div>
              <p className="masthead-title serif">书剑 Future · 学生卷宗</p>
              <p className="eyebrow">
                {tenantLabel} · 编程小队 · 第 1 期
              </p>
            </div>
          </div>

          <div className="masthead-stats">
            <Stat label="学生在册" value={data.students.length} />
            <Divider />
            <Stat label="项目卷宗" value={data.projects.length} />
            <Divider />
            <Stat
              label="座位填充"
              value={overallFill}
              suffix="%"
              hint={`${totalAssigned}/${totalSlots}`}
            />
          </div>

          <div className="masthead-actions">
            <SyncIndicator status={syncStatus} error={syncError} />
            <button
              type="button"
              className="btn-line"
              onClick={() => fileInputRef.current?.click()}
            >
              <Upload size={13} /> 导入
            </button>
            <button
              type="button"
              className="btn-line"
              onClick={() => exportData(data)}
            >
              <Download size={13} /> 导出
            </button>
            <button
              type="button"
              className="btn-seal"
              onClick={() => setDrawer({ kind: 'student', mode: 'create' })}
            >
              <Plus size={13} /> 录入学生
            </button>
            <button
              type="button"
              className="btn-line"
              title={auth.user?.identifier ?? '退出登录'}
              onClick={() => void auth.logout()}
            >
              <LogOut size={13} /> 退出
            </button>
            <input
              ref={fileInputRef}
              type="file"
              accept="application/json"
              hidden
              onChange={async (e) => {
                const file = e.target.files?.[0]
                if (!file) return
                try {
                  const next = await importData(file)
                  setData(next)
                } catch (err) {
                  console.error('import failed', err)
                }
                if (fileInputRef.current) fileInputRef.current.value = ''
              }}
            />
          </div>
        </header>

        <main className="folio-main">
          <article className="prologue">
            <p className="eyebrow">编者按</p>
            <h1 className="prologue-headline serif">
              把学生分类组织，<br />
              组成<em className="prologue-em">编程小队</em>，
              一起跑真实项目。
            </h1>
            <p className="prologue-lede">
              拖动右侧学籍簿里的学生到任意项目卷宗的成员位上。
              能力覆盖率会实时计算，告诉你这个小队还缺什么。
              点击任意卷宗封面，翻开内页，看小队当前状态、反馈与下一步。
            </p>
          </article>

          <section className="volumes" aria-label="项目卷宗列表">
            <header className="volumes-head">
              <span className="vertical eyebrow volumes-vertical">本期项目</span>
              <h2 className="volumes-title serif">项目卷宗</h2>
              <span className="volumes-rule" />
              <span className="volumes-count mono">
                共 {data.projects.length} 卷
              </span>
            </header>

            <div className="volumes-list">
              {data.projects.map((project, i) => (
                <ProjectLane
                  key={project.id}
                  project={project}
                  index={i}
                  members={membersByProject.get(project.id) ?? []}
                  isFocused={theatreId === project.id}
                  onOpen={openTheatre}
                  onEdit={(p) => setDrawer({ kind: 'project', mode: 'edit', initial: p })}
                  onSelectStudent={(s) =>
                    setDrawer({ kind: 'student', mode: 'edit', initial: s })
                  }
                />
              ))}
              <NewLaneCard
                onCreate={() => setDrawer({ kind: 'project', mode: 'create' })}
              />
            </div>
          </section>
        </main>

        <StudentRoster
          students={data.students}
          unassignedIds={unassignedIds}
          onSelect={(s) => setDrawer({ kind: 'student', mode: 'edit', initial: s })}
          onAddStudent={() => setDrawer({ kind: 'student', mode: 'create' })}
        />

        <footer className="colophon">
          <span className="serif">书剑 Future</span>
          <span className="colophon-rule" />
          <span className="mono">v0.3 · {tenantLabel} · 已同步到云端</span>
        </footer>
      </div>

      <DragOverlay
        dropAnimation={{
          duration: 320,
          easing: 'cubic-bezier(0.16, 1, 0.3, 1)',
        }}
      >
        {activeStudent && (
          <div className="overlay-chip">
            <StudentChip student={activeStudent} origin="roster" variant="card" />
          </div>
        )}
      </DragOverlay>

      <AnimatePresence>
        {focusedProject && (
          <TheatreView
            key={focusedProject.id}
            project={focusedProject}
            members={membersByProject.get(focusedProject.id) ?? []}
            feedback={data.feedback}
            onClose={closeTheatre}
            onRemoveMember={(studentId) => removeMember(focusedProject.id, studentId)}
            onAddFeedback={(f) => addFeedback(f, focusedProject.id)}
          />
        )}
      </AnimatePresence>

      <AnimatePresence>
        {drawer &&
          (drawer.kind === 'student' ? (
            <EntityDrawer
              kind="student"
              mode={drawer.mode}
              initial={drawer.initial}
              onClose={() => setDrawer(null)}
              onSave={saveStudent}
              onDelete={deleteStudent}
            />
          ) : (
            <EntityDrawer
              kind="project"
              mode={drawer.mode}
              initial={drawer.initial}
              onClose={() => setDrawer(null)}
              onSave={saveProject}
              onDelete={deleteProject}
            />
          ))}
      </AnimatePresence>
    </DndContext>
  )
}

function Stat({
  label,
  value,
  suffix,
  hint,
}: {
  label: string
  value: number
  suffix?: string
  hint?: string
}) {
  return (
    <div className="stat">
      <span className="stat-label eyebrow">{label}</span>
      <span className="stat-value serif">
        {value}
        {suffix && <span className="stat-suffix mono">{suffix}</span>}
      </span>
      {hint && <span className="stat-hint mono">{hint}</span>}
    </div>
  )
}

function Divider() {
  return <span className="masthead-divider" aria-hidden />
}

function SyncIndicator({
  status,
  error,
}: {
  status: SyncStatus
  error: string | null
}) {
  const [icon, label, color] = (() => {
    switch (status) {
      case 'saving':
        return [<Loader2 key="i" size={13} className="sync-spin" />, '同步中', 'var(--muted)'] as const
      case 'error':
        return [<CloudOff key="i" size={13} />, error ?? '同步失败', 'var(--vermilion)'] as const
      case 'saved':
      case 'idle':
      default:
        return [<Cloud key="i" size={13} />, '已同步', 'var(--moss)'] as const
    }
  })()
  return (
    <span
      className="mono"
      title={error ?? undefined}
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 6,
        fontSize: 11,
        color,
        padding: '0 8px',
        userSelect: 'none',
      }}
    >
      {icon}
      <span>{label}</span>
    </span>
  )
}

function BootCard({
  message,
  tone = 'info',
}: {
  message: string
  tone?: 'info' | 'alert'
}) {
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
          color: tone === 'alert' ? 'var(--vermilion-deep)' : 'var(--muted)',
          letterSpacing: '0.04em',
        }}
      >
        {message}
      </p>
    </div>
  )
}
