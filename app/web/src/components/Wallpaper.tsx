import { memo, useEffect, useState, type CSSProperties } from 'react'
import { activeWallpaper } from '../lib/settings.ts'
import { derivedUrl, wallpaperStyle } from '../lib/wallpapers.ts'
import { useApp } from '../store/app.ts'
import { useTheme } from '../lib/useTheme.ts'
import { VideoWallpaper } from './VideoWallpaper.tsx'

/**
 * 全屏壁纸 + 压暗层。
 *
 * 固定定位到视口而不是页面高度：页面很长时壁纸仍要铺满，
 * 而且 blur 滤镜本身有开销，尺寸越小越省。
 *
 * 压暗强度由 App.tsx 算好写进 CSS 变量（依赖主题与壁纸明暗），
 * 这里只负责把它叠上去。
 *
 * ── 分两步加载 ──
 * 先铺缩略图（几十 KB，几乎立刻就有），大图在后台加载完再淡入。
 * 手机拍的照片动辄几 MB，直接当背景会先白屏好几秒。
 *
 * ⚠️ **派生图可用时，绝不能把原图那一层留在 DOM 里当兜底。**
 * 浏览器会下载被完全盖住的 `background-image` —— 实测过：三层都挂着的时候，
 * 那张 7.2MB 的原图照样被完整下载了一遍，优化等于白做。
 * 所以这里用 `<img>` + `onError` 来探测缩略图是否真的存在：
 * 只有它加载失败时，才把原图那层挂出来。
 */
export const Wallpaper = memo(function Wallpaper() {
  const settings = useApp((s) => s.settings)
  // 壁纸是「浅色一套、深色一套」，这里按当前实际主题取对应那套。
  // resolveDark 对 auto 会看系统偏好，所以系统切深浅色时壁纸也跟着换。
  const active = activeWallpaper(settings, useTheme(settings.theme))

  const isImage = active.type === 'image' || active.type === 'url'
  const thumb = isImage ? derivedUrl(active.value, 'thumb') : null
  const large = isImage ? derivedUrl(active.value, 'large') : null

  // 派生图可能不存在（上传时生成失败、或者用 API 直传的图），探测到再退回原图
  const [derivedBroken, setDerivedBroken] = useState(false)
  const [largeReady, setLargeReady] = useState(false)

  // 换壁纸时把上一张的状态清掉，否则新图会带着旧结论显示
  useEffect(() => {
    setDerivedBroken(false)
    setLargeReady(false)
  }, [active.value, thumb, large])

  const useDerived = Boolean(thumb && large) && !derivedBroken

  // 模糊 / 缩放 / 铺法由 wallpaperStyle 统一决定。
  // 图片改用 <img> 渲染，所以这里只取滤镜和缩放，背景那几个属性交给 object-cover。
  const base = wallpaperStyle(active.type, active.value, settings.wallpaper_blur)
  const fx: CSSProperties = {}
  if (base.filter) fx.filter = base.filter
  if (base.transform) fx.transform = base.transform

  return (
    // 外层只当裁剪窗口：它的高度跟着布局视口变（地址栏收起/展开），
    // 但里面所有东西都挂在固定高度的 .wallpaper-stage 上，所以看不出来
    <div className="pointer-events-none fixed inset-0 -z-20 overflow-hidden">
      <div className="wallpaper-stage">
        {active.type === 'video' ? (
          <div className="absolute inset-0" style={{ backgroundImage: base.backgroundImage }}>
            <VideoWallpaper src={active.value} className="absolute inset-0" style={fx} controlPlacement="floating" />
          </div>
        ) : useDerived ? (
          <>
            {/* 缩略图：跟着首屏一起到，先让用户看到画面 */}
            <img
              src={thumb!}
              alt=""
              aria-hidden
              onError={() => setDerivedBroken(true)}
              className="absolute inset-0 size-full object-cover"
              style={fx}
            />
            {/* 大图：加载完淡入。加载失败就一直显示缩略图，不会露出空白 */}
            <img
              src={large!}
              alt=""
              aria-hidden
              onLoad={() => setLargeReady(true)}
              className="absolute inset-0 size-full object-cover transition-opacity duration-700"
              style={{ ...fx, opacity: largeReady ? 1 : 0 }}
            />
          </>
        ) : (
          // 没有派生图（外链、老图没补、生成失败）——原图是唯一选择，行为跟以前一样
          <div className="absolute inset-0" style={base} />
        )}

        {/* 色罩和暗角也放进舞台：它们的强度是按壁纸明暗算的，
            跟着一起固定住才不会在滚动时和图片错位 */}
        <div className="wallpaper-scrim absolute inset-0" />
        <div className="wallpaper-vignette absolute inset-0" />
      </div>
    </div>
  )
})
