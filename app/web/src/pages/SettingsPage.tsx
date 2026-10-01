import { PageShell } from '../components/PageShell.tsx'
import { AccountSection } from '../components/settings/AccountSection.tsx'
import { AppearanceSection } from '../components/settings/AppearanceSection.tsx'
import { BackupSection } from '../components/settings/BackupSection.tsx'
import { BehaviorSection } from '../components/settings/BehaviorSection.tsx'
import { BookmarkSection } from '../components/settings/BookmarkSection.tsx'
import { SearchSection } from '../components/settings/SearchSection.tsx'
import { SettingsNavAside, SettingsNavBar } from '../components/settings/Section.tsx'
import { SiteInfoSection } from '../components/settings/SiteInfoSection.tsx'
import { WidgetSection } from '../components/settings/WidgetSection.tsx'
import { SaveStatusChip, SettingsSaveProvider } from '../components/settings/saver.tsx'

/**
 * 设置页。
 *
 * 保存策略是「改完立刻存」：所有控件都通过 SettingsSaveProvider 落到 /api/settings，
 * 成功只让页头闪一下「已保存」，失败才 toast —— 二十多个设置项如果每次成功都弹提示，
 * 页面会变成 toast 垃圾场。高频改动（滑杆、标题）由各分区自己做 300–400ms 防抖。
 *
 * 未登录的人根本进不来（路由守卫挡在 RequireAuth 那一层），所以这里不再做只读降级。
 */
export function SettingsPage() {
  return (
    <SettingsSaveProvider readOnly={false}>
      <PageShell
        title="设置"
        description="外观、搜索、小组件、账号与数据"
        wide
        actions={<SaveStatusChip />}
      >
        {/* 桌面端左导航 sticky 跟随，移动端退化成可横向滑动的分区条 */}
        <div className="grid gap-5 lg:grid-cols-[13.5rem_minmax(0,1fr)] lg:items-start">
          <SettingsNavAside />

          <div className="min-w-0 space-y-5">
            <SettingsNavBar />

            <SiteInfoSection />
            <AppearanceSection />
            <SearchSection />
            <WidgetSection />
            <BehaviorSection />
            <AccountSection />
            <BackupSection />
            <BookmarkSection />
          </div>
        </div>
      </PageShell>
    </SettingsSaveProvider>
  )
}
