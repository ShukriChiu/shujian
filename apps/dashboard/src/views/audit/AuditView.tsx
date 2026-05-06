import { ScrollText } from 'lucide-react'
import { PageHeader } from '@/components/PageHeader'
import { EmptyState } from '@/components/EmptyState'

export function AuditView() {
  return (
    <div className="flex flex-col">
      <PageHeader
        title="Audit log"
        description="工作区里的所有 agent 创建、派单、凭证变更、登录事件。"
      />
      <div className="px-6 pb-12">
        <EmptyState
          glyph={<ScrollText className="h-5 w-5" />}
          title="审计还没接上"
          hint={
            <>
              backend 里需要的 <span className="text-ink-muted">events</span> 表/接口尚未实现。
              <br />
              一旦 shujian-backend 暴露 <span className="text-ink-muted">/v1/events</span>，
              这页就会变成倒序的事件流（who · when · what · target）。
            </>
          }
        />
      </div>
    </div>
  )
}
