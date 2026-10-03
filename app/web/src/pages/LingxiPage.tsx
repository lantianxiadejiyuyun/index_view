import { Link } from 'react-router-dom'
import { Settings } from 'lucide-react'
import { PageShell } from '../components/PageShell.tsx'
import { LingxiCalendarWidget, LingxiChatWidget, LingxiDeadlineWidget, LingxiScheduleWidget } from '../components/lingxi/LingxiWidgets.tsx'

export function LingxiPage() {
  return <PageShell wide title="灵犀工作区" description="日程、待办、截止提醒与 AI 对话，和灵犀账号同步" actions={<Link to="/settings/lingxi" className="glass flex size-11 items-center justify-center rounded-xl text-fg/70" aria-label="灵犀联动设置"><Settings size={17} /></Link>}>
    <div className="lingxi-workspace"><div className="lingxi-workspace-calendar"><LingxiCalendarWidget /></div><div className="lingxi-workspace-schedule"><LingxiScheduleWidget /></div><div className="lingxi-workspace-deadline"><LingxiDeadlineWidget /></div><div className="lingxi-workspace-chat"><LingxiChatWidget /></div></div>
  </PageShell>
}
