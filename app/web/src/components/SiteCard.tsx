import { useEffect, useState, type CSSProperties } from 'react'
import { Globe, Home, Pencil, Trash2 } from 'lucide-react'
import { faviconUrl } from '../lib/api.ts'
import { emojiOf, initialOf, letterGradient } from '../lib/icon.ts'
import { resolveLink } from '../lib/link.ts'
import { CARD_PRESETS, type CardSize } from '../lib/settings.ts'
import type { Site } from '../lib/types.ts'

type Props = {
  site: Site
  editMode: boolean
  size: CardSize
  netMode: 'lan' | 'public'
  onOpen: () => void
  onEdit: () => void
  onDelete: () => void
  dragging?: boolean
}

function SiteIcon({ site, px }: { site: Site; px: number }) {
  const [failed, setFailed] = useState(false)
  const custom = site.icon_url?.trim() || null
  const auto = faviconUrl(site)
  const src = custom || auto

  // 换了图标地址要重新给一次机会，否则一次失败会永久降级成首字母
  useEffect(() => {
    setFailed(false)
  }, [src])

  const emoji = emojiOf(site.title)

  // 标题以 emoji 开头时，用 emoji 当图标比去抓 favicon 更贴切
  if (emoji && !custom) {
    return (
      <span
        className="flex shrink-0 items-center justify-center leading-none"
        style={{ width: 'var(--site-icon-size)', height: 'var(--site-icon-size)', fontSize: 'calc(var(--site-icon-size) * 0.62)' }}
        aria-hidden
      >
        {emoji}
      </span>
    )
  }

  if (src && !failed) {
    return (
      <img
        src={src}
        alt=""
        width={px}
        height={px}
        loading="lazy"
        decoding="async"
        onError={() => setFailed(true)}
        className="shrink-0 rounded-xl object-contain"
        style={{
          width: 'var(--site-icon-size)',
          height: 'var(--site-icon-size)',
          // 不少网站的 favicon 是纯黑图形（GitHub、Vercel 等），
          // 直接放在深色玻璃卡片上会糊成一团。加一圈极淡的白色轮廓光，
          // 让深色图标的剪影能读出来，同时几乎不影响彩色图标。
          filter: 'drop-shadow(0 0 1px rgba(255,255,255,0.75)) drop-shadow(0 0 4px rgba(255,255,255,0.3))',
        }}
      />
    )
  }

  return (
    <span
      className="flex shrink-0 items-center justify-center rounded-xl font-semibold text-fg shadow-inner"
      style={{
        width: 'var(--site-icon-size)',
        height: 'var(--site-icon-size)',
        fontSize: 'calc(var(--site-icon-size) * 0.42)',
        background: site.color || letterGradient(site.title),
      }}
      aria-hidden
    >
      {site.icon_text?.trim() || initialOf(site.title)}
    </span>
  )
}

export function SiteCard({
  site,
  editMode,
  size,
  netMode,
  onOpen,
  onEdit,
  onDelete,
  dragging = false,
}: Props) {
  const preset = CARD_PRESETS[size]
  const link = resolveLink(site, netMode)
  const dual = Boolean(site.url_lan && site.url_public)

  return (
    <div
      style={{ '--site-desktop-icon': `${preset.icon}px`, '--site-desktop-pad': `${preset.pad}px` } as CSSProperties}
      className={[
        'site-card group relative flex flex-col items-center rounded-[1.35rem] transition-all duration-300 ease-out',
        // 编辑模式下轻微抖动，提示「现在可以拖」
        editMode ? 'animate-wiggle' : 'hover:-translate-y-1.5',
        dragging ? 'opacity-40' : '',
      ].join(' ')}
    >
      <button
        type="button"
        onClick={editMode ? onEdit : onOpen}
        title={site.description || site.title}
        className={[
          'site-card-button glass flex w-full flex-col items-center gap-2 rounded-[1.35rem] transition duration-300 ease-out',
          // 边框与投影在 hover 时一起加强，卡片会有「被托起来」的实感
          'ring-1 ring-line/10 hover:ring-line/25',
          'hover:shadow-[0_18px_40px_-16px_rgb(0_0_0/var(--glass-shadow-pop))]',
          'focus-visible:ring-2 focus-visible:ring-accent/60',
          'focus:outline-none',
          editMode ? 'cursor-grab active:cursor-grabbing' : 'cursor-pointer',
        ].join(' ')}
        style={{ padding: 'var(--site-card-pad)' }}
      >
        <SiteIcon site={site} px={preset.icon} />

        <span
          className={`site-card-label line-clamp-2 w-full break-words text-center font-medium text-fg ${preset.label}`}
        >
          {site.title}
        </span>
      </button>

      {/* 双链路角标：让用户一眼知道这次点下去走的是哪条线 */}
      {dual && !editMode && link && (
        <span
          className={[
            'pointer-events-none absolute -right-1 -top-1 flex items-center gap-0.5 rounded-full px-1.5 py-0.5',
            'text-[9px] font-medium shadow-md backdrop-blur',
            link.kind === 'lan'
              ? 'bg-emerald-500/85 text-white'
              : 'bg-sky-500/85 text-white',
          ].join(' ')}
          title={link.kind === 'lan' ? '将使用内网地址' : '将使用公网地址'}
        >
          {link.kind === 'lan' ? (
            <Home className="size-2.5" aria-hidden />
          ) : (
            <Globe className="size-2.5" aria-hidden />
          )}
          {link.kind === 'lan' ? '内网' : '公网'}
        </span>
      )}

      {editMode && (
        <div className="absolute -right-1.5 -top-1.5 flex gap-1">
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation()
              onEdit()
            }}
            className="rounded-full bg-sky-500 p-1.5 text-white shadow-lg transition hover:bg-sky-400"
            aria-label={`编辑 ${site.title}`}
          >
            <Pencil className="size-3" aria-hidden />
          </button>
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation()
              onDelete()
            }}
            className="rounded-full bg-rose-500 p-1.5 text-white shadow-lg transition hover:bg-rose-400"
            aria-label={`删除 ${site.title}`}
          >
            <Trash2 className="size-3" aria-hidden />
          </button>
        </div>
      )}
    </div>
  )
}
