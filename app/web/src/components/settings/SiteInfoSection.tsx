import { useApp } from '../../store/app.ts'
import { SettingTextField } from './controls.tsx'
import { SettingsSection } from './Section.tsx'
import { useSettingsSave } from './saver.tsx'

/** 站点标题与副标题：改完立刻写库，首页的 Clock 读的是同一份 store，无需刷新 */
export function SiteInfoSection() {
  const title = useApp((s) => s.settings.site_title)
  const subtitle = useApp((s) => s.settings.site_subtitle)
  const { save } = useSettingsSave()

  return (
    <SettingsSection id="site" description="首页时钟区域显示的文字">
      <div className="grid gap-4 sm:grid-cols-2">
        <SettingTextField
          id="set-site-title"
          label="站点标题"
          value={title}
          onSave={(next) => void save({ site_title: next })}
          placeholder="我的导航"
          maxLength={40}
          hint="问候语后面那一段，例如「中午好 · 我的导航」"
        />
        <SettingTextField
          id="set-site-subtitle"
          label="副标题"
          value={subtitle}
          onSave={(next) => void save({ site_subtitle: next })}
          placeholder="留空则不显示"
          maxLength={80}
          hint="显示在时钟与日期下方"
        />
      </div>
    </SettingsSection>
  )
}
