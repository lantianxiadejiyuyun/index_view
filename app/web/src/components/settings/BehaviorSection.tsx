import { useApp } from '../../store/app.ts'
import { Note, SettingTextField, ToggleField } from './controls.tsx'
import { SettingsSection } from './Section.tsx'
import { useSettingsSave } from './saver.tsx'

/**
 * 端口列表规整：只留 1–65535 的数字并去重。
 * 放在失焦时做而不是每次输入都做 —— 边打字边删会把「9201,」里的逗号吃掉。
 */
function normalizePorts(raw: string): string {
  const seen = new Set<string>()
  for (const part of raw.split(/[^0-9]+/)) {
    if (!part) continue
    const port = Number(part)
    if (port < 1 || port > 65535) continue
    seen.add(String(port))
  }
  return [...seen].join(',')
}

export function BehaviorSection() {
  const settings = useApp((s) => s.settings)
  const { save } = useSettingsSave()

  async function togglePublicView(next: boolean) {
    // 关掉访客浏览是会影响「自己退出登录后也看不到首页」的操作，问一句更稳
    if (
      !next &&
      !window.confirm(
        '关闭后，未登录的访客将无法浏览首页内容，必须登录才能看到图标。\n\n确定要关闭吗？',
      )
    ) {
      return
    }
    void save({ public_view: next })
  }

  return (
    <SettingsSection id="behavior" description="点击行为、访客权限与探针端口">
      <ToggleField
        label="图标在新标签页打开"
        hint="关闭后当前标签页直接跳走"
        checked={settings.open_in_new_tab}
        onChange={(next) => void save({ open_in_new_tab: next })}
      />

      <ToggleField
        label="允许未登录浏览首页"
        hint="关闭后必须登录才能看到图标与分组，编辑功能始终需要登录"
        checked={settings.public_view}
        onChange={(next) => void togglePublicView(next)}
      />

      <SettingTextField
        id="set-agent-ports"
        label="探针候选端口"
        value={settings.agent_ports}
        onSave={(next) => void save({ agent_ports: next })}
        normalize={normalizePorts}
        placeholder="9201,9202"
        inputMode="numeric"
        mono
        hint="多个端口用英文逗号分隔，例如 9201,9202"
      />

      <Note tone="info">
        首页在内网打开时（以 192.168 / 10. / 172.16-31 等内网地址访问），会依次尝试上面这些端口去自动发现探针，
        命中后就能自动补全图标的内网地址；找不到探针时会安静回落到公网地址，不影响使用。
      </Note>
    </SettingsSection>
  )
}
