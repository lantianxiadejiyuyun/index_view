import { useState } from 'react'
import { CloudSun, FlaskConical, Loader2 } from 'lucide-react'
import { api, errorMessage } from '../../lib/api.ts'
import type { Weather } from '../../lib/types.ts'
import { useApp } from '../../store/app.ts'
import { toast } from '../../store/toast.ts'
import { btnGhost } from '../Modal.tsx'
import { TextField, ToggleField, useDebouncedCommit, useDraftValue } from './controls.tsx'
import { Segmented } from './controls.tsx'
import { SettingsSection } from './Section.tsx'
import { useSettingsSave } from './saver.tsx'

/** 天气源二选一。默认国内：快 40 倍，而且不受某些国外主机被阻断的影响 */
const WEATHER_PROVIDERS: { value: string; label: string }[] = [
  { value: 'china', label: '国内（中国天气网）' },
  { value: 'open-meteo', label: '国外（open-meteo）' },
]

/** 天气数据的一行摘要，测试接口是否通 */
function WeatherPreview({ data }: { data: Weather }) {
  return (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-1 rounded-xl border border-emerald-400/25 bg-emerald-500/10 px-3 py-2.5 text-xs text-emerald-50">
      <span className="text-sm font-semibold">{Math.round(data.temperature)}°</span>
      <span>{data.description}</span>
      <span className="text-success/80">{data.city}</span>
      <span className="text-success/70">湿度 {Math.round(data.humidity)}%</span>
      <span className="text-success/70">风速 {Math.round(data.wind_speed)}km/h</span>
      <span className="text-success/50">来源 {data.provider}</span>
    </div>
  )
}

export function WidgetSection() {
  const settings = useApp((s) => s.settings)
  const { save } = useSettingsSave()

  const city = useDraftValue(settings.weather_city)
  const commitCity = useDebouncedCommit<[string]>((v) => void save({ weather_city: v }), 400)

  const [testing, setTesting] = useState(false)
  const [result, setResult] = useState<Weather | null>(null)

  async function testWeather(value: string) {
    const trimmed = value.trim()
    setTesting(true)
    try {
      const query = trimmed ? `?city=${encodeURIComponent(trimmed)}` : ''
      // 这个接口不需要登录，测试按钮对游客也安全
      const data = await api<Weather>(`/api/widgets/weather${query}`, {}, { retry: false })
      setResult(data)
      toast.success('天气接口正常')
    } catch (err) {
      setResult(null)
      toast.error(errorMessage(err, '天气获取失败'))
    } finally {
      setTesting(false)
    }
  }

  return (
    <SettingsSection id="widgets" description="时钟区域下方的小组件开关">
      <div className="grid gap-3 sm:grid-cols-2">
        <ToggleField
          label="时钟"
          hint="大号时间与日期"
          checked={settings.show_clock}
          onChange={(next) => void save({ show_clock: next })}
        />
        <ToggleField
          label="问候语"
          hint="「早上好 · 站点标题」，站点标题也挂在这里"
          checked={settings.show_greeting}
          onChange={(next) => void save({ show_greeting: next })}
        />
        <ToggleField
          label="天气"
          hint="需要联网获取，失败时自动隐藏"
          checked={settings.show_weather}
          onChange={(next) => void save({ show_weather: next })}
        />
        <ToggleField
          label="每日一言"
          hint="每次打开页面取一句"
          checked={settings.show_hitokoto}
          onChange={(next) => void save({ show_hitokoto: next })}
        />
        <ToggleField
          label="工作台入口"
          hint="进「工作台」的入口 —— 后台账号密码都在那一页，首页只给一个门"
          checked={settings.show_workbench}
          onChange={(next) => void save({ show_workbench: next })}
        />
      </div>

      <div className="rounded-xl border border-line/10 bg-line/5 p-3">
        <Segmented
          label="天气源"
          value={settings.weather_provider}
          options={WEATHER_PROVIDERS}
          onChange={(next) => void save({ weather_provider: next })}
        />
        <p className="mb-3 text-[11px] leading-relaxed text-fg/50">
          国内源走中国天气网，免 Key、实测 19ms；国外源走 open-meteo，覆盖全球任意城市但要绕到德国（约 900ms）。
          内置表里没有的城市会自动落到国外源。
        </p>

        <TextField
          id="set-weather-city"
          label="天气城市"
          value={city.draft}
          onChange={(next) => {
            city.setDraft(next)
            commitCity.schedule(next)
          }}
          onFocus={city.onFocus}
          onBlur={() => {
            city.onBlur()
            // 失焦立刻落库，免得刚输入完就点「测试」时值还没保存
            commitCity.cancel()
            if (city.draft.trim() !== settings.weather_city) void save({ weather_city: city.draft.trim() })
          }}
          placeholder="例如：北京"
          maxLength={40}
          hint="留空则使用服务端默认城市"
          trailing={
            <button
              type="button"
              className={`${btnGhost} flex w-full items-center justify-center gap-1.5 sm:w-auto`}
              disabled={testing}
              onClick={() => void testWeather(city.draft)}
            >
              {testing ? (
                <Loader2 className="size-3.5 animate-spin" aria-hidden />
              ) : (
                <FlaskConical className="size-3.5" aria-hidden />
              )}
              测试
            </button>
          }
        />

        <div className="mt-3 space-y-2">
          {result ? (
            <WeatherPreview data={result} />
          ) : (
            <p className="flex items-center gap-1.5 text-[11px] text-fg/40">
              <CloudSun className="size-3.5" aria-hidden />
              点「测试」可以立刻验证城市名和天气源是否可用。
            </p>
          )}
        </div>
      </div>
    </SettingsSection>
  )
}
