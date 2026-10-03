import { useState } from 'react'
import { Check, Maximize2, Monitor, Smartphone } from 'lucide-react'
import { Modal, btnGhost, btnPrimary } from './Modal.tsx'
import { widgetResizeError, type DesktopViewport, type PlacedItem } from '../lib/desktop-layout.ts'
import { widgetLabels, widgetSizePresets, type WidgetDimensions } from '../lib/desktop-widgets.ts'

export function DesktopWidgetSizeDialog({ name, viewport, item, occupied, busy, onClose, onApply }: {
  name: string; viewport: DesktopViewport; item: PlacedItem; occupied: PlacedItem[]; busy: boolean
  onClose: () => void; onApply: (size: WidgetDimensions) => void
}) {
  const [selected, setSelected] = useState<WidgetDimensions>({ width: item.width, height: item.height })
  const presets = widgetSizePresets(name, viewport)
  const error = widgetResizeError(item, selected, occupied, viewport === 'wide' ? 12 : 4)
  const unchanged = selected.width === item.width && selected.height === item.height
  return <Modal open title={`${widgetLabels[name]} · 组件尺寸`} onClose={() => !busy && onClose()}>
    <div className="desktop-size-dialog">
      <p className="desktop-size-device">{viewport === 'wide' ? <Monitor size={16} /> : <Smartphone size={16} />}当前调整{viewport === 'wide' ? '电脑' : '手机'}布局 <span>独立保存</span></p>
      <div className="desktop-size-presets" role="group" aria-label="选择组件尺寸">
        {presets.map(preset => {
          const checked = selected.width === preset.width && selected.height === preset.height
          const current = item.width === preset.width && item.height === preset.height
          const blocked = widgetResizeError(item, preset, occupied, viewport === 'wide' ? 12 : 4)
          return <button type="button" key={preset.label} aria-pressed={checked} aria-label={`${preset.label} ${preset.width} 列 ${preset.height} 行${current ? '，当前尺寸' : ''}`} className={`desktop-size-preset${checked ? ' is-selected' : ''}`} disabled={busy} onClick={() => setSelected(preset)}>
            <span className="desktop-size-illustration" aria-hidden="true"><span style={{ width: `${Math.max(28, preset.width / (viewport === 'wide' ? 8 : 4) * 88)}%`, height: 12 + preset.height * 8 }}><Maximize2 size={14} /></span></span>
            <strong>{preset.label}{checked && <Check size={14} aria-hidden />}</strong>
            <span>{preset.width} × {preset.height} 格</span>
            <small>{current ? '当前尺寸' : blocked ? '需腾出空间' : '可直接使用'}</small>
          </button>
        })}
      </div>
      <p className={`desktop-size-notice${error && !unchanged ? ' is-blocked' : ''}`} role="status">{error && !unchanged ? error : '从左上角调整大小，其他图标和组件保持原位。'}</p>
      <div className="desktop-size-footer"><span>当前 {item.width} × {item.height} 格</span><button type="button" className={btnGhost} disabled={busy} onClick={onClose}>取消</button><button type="button" className={btnPrimary} disabled={busy || unchanged || !!error} onClick={() => onApply(selected)}>{busy ? '保存中…' : '应用尺寸'}</button></div>
    </div>
  </Modal>
}
