/**
 * 浏览器端生成派生图（缩略图 / 中等图）。
 *
 * **为什么在浏览器做**：服务端生成缩略图需要图片解码器，也就是 `sharp` 这种原生依赖。
 * 这个项目刻意保持「单文件 bundle、运行时零依赖、镜像里不带 node_modules」，
 * 引一个原生依赖等于把这些性质全丢掉。而浏览器本来就有最快的解码器
 * （`createImageBitmap` 常常直接走硬件），顺手就用了。
 *
 * 代价：只有走网页上传才有派生图；用 API/curl 直传的图片没有，前端会回退到原图。
 *
 * ── 苹果浏览器（Safari / iOS）的几处差异，都在这个文件里兜住 ──
 *
 *  1. **Safari 编不出 WebP**。`canvas.toBlob(cb, 'image/webp')` 在 Safari 上
 *     会静默回退成 PNG —— 那比原图还大。所以导出后必须检查返回的 MIME，
 *     不是 WebP 就重来一次 JPEG。（服务端两种都收，派生图的地址也与格式无关。）
 *  2. **老 Safari 没有 `createImageBitmap`**，退回 `<img>` + objectURL 解码。
 *     讽刺的是这条路的格式支持反而更广 —— iOS 的 HEIC 只能这么解。
 *  3. **EXIF 方向**。手机竖拍的照片像素是横的，靠 EXIF 里的方向标记转正。
 *     `imageOrientation: 'from-image'` 能按标记转，但老版本不认这个选项会抛，
 *     所以要再试一次不带参数的。
 */

/** 网格里用的缩略图，最长边 480 —— 手机上两列布局每格约 180px，2x 屏也够 */
export const THUMB_MAX_EDGE = 480
/** 灯箱用的中等图，最长边 1600 —— 手机上全屏显示绰绰有余，桌面端也够清晰 */
export const LARGE_MAX_EDGE = 1600

/**
 * 原图小于这个大小就懒得生成中等图了：本来就没多大，再压一次收益有限，
 * 还要多花一次编解码。缩略图仍然会生成（网格里几十张图的差别很可观）。
 */
const SKIP_LARGE_BELOW_BYTES = 400 * 1024

/**
 * 能栅格化的位图格式。GIF 会动、SVG 是矢量，都不该被压成一张静态图，直接跳过。
 * HEIC/HEIF 是苹果的默认拍照格式 —— 只有 Safari 系能解，其它浏览器给不出派生图，
 * 前端会相应地把「原图」也换成派生图来显示。
 */
const RASTER = /^image\/(jpeg|png|webp|avif|bmp|heic|heif)$/i

/** 派生出图片的格式：优先 WebP，Safari 不支持编码时退回 JPEG */
export type DerivedBlob = Blob

export type Derivatives = {
  thumb: DerivedBlob | null
  large: DerivedBlob | null
}

type Decoded = {
  source: CanvasImageSource
  width: number
  height: number
  /** 释放解码占用的资源（objectURL / ImageBitmap） */
  release: () => void
}

/** 用 <img> 解码：给没有 createImageBitmap 的老 Safari，以及它才能解的 HEIC 用 */
async function decodeViaImage(file: File): Promise<Decoded | null> {
  const url = URL.createObjectURL(file)
  try {
    const img = await new Promise<HTMLImageElement>((resolve, reject) => {
      const el = new Image()
      el.onload = () => resolve(el)
      el.onerror = () => reject(new Error('decode failed'))
      el.src = url
    })
    return {
      source: img,
      width: img.naturalWidth,
      height: img.naturalHeight,
      release: () => URL.revokeObjectURL(url),
    }
  } catch {
    URL.revokeObjectURL(url)
    return null
  }
}

async function decode(file: File): Promise<Decoded | null> {
  try {
    let bitmap: ImageBitmap
    try {
      // 带方向标记转正（Safari 16+ / Chrome 81+）
      bitmap = await createImageBitmap(file, { imageOrientation: 'from-image' })
    } catch {
      // 老版本不认这个选项会抛，退一步不要方向处理，总比什么都没有强
      bitmap = await createImageBitmap(file)
    }
    return {
      source: bitmap,
      width: bitmap.width,
      height: bitmap.height,
      release: () => bitmap.close(),
    }
  } catch {
    // 没有 createImageBitmap，或者它解不了的格式（HEIC）—— 换 <img> 再试
    return await decodeViaImage(file)
  }
}

/**
 * 把一张图缩到指定最长边并导出。
 *
 * WebP 编码不被支持时 `toBlob` 会悄悄回退成 PNG —— 那比原图还大，
 * 所以要检查返回类型，不是 WebP 就改用 JPEG。
 */
async function exportResized(
  decoded: Decoded,
  maxEdge: number,
  quality: number,
): Promise<DerivedBlob | null> {
  const longest = Math.max(decoded.width, decoded.height)
  if (longest === 0) return null

  // 不放大：原图本来就比目标小就按原尺寸导出（只为了转格式 / 降质量）
  const scale = Math.min(1, maxEdge / longest)
  const width = Math.max(1, Math.round(decoded.width * scale))
  const height = Math.max(1, Math.round(decoded.height * scale))

  const canvas = document.createElement('canvas')
  canvas.width = width
  canvas.height = height
  const ctx = canvas.getContext('2d')
  if (!ctx) return null
  // 缩图时默认插值（low）在缩得很狠时会糊，开高质量
  ctx.imageSmoothingEnabled = true
  ctx.imageSmoothingQuality = 'high'
  ctx.drawImage(decoded.source, 0, 0, width, height)

  const toBlob = (type: string, q: number) =>
    new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, type, q))

  const webp = await toBlob('image/webp', quality)
  if (webp && webp.type === 'image/webp') return webp

  // Safari 走到这里：它把 webp 请求当成了 png（或者干脆返回 null）
  const jpeg = await toBlob('image/jpeg', quality)
  return jpeg && jpeg.type === 'image/jpeg' ? jpeg : null
}

/**
 * 为一张上传的图生成派生图。
 *
 * 整个函数**不抛异常**：生成失败就返回 null，让调用方退回原图 ——
 * 宁可慢一点，也不能因为缩略图挂了就传不上去。
 */
export async function makeDerivatives(file: File): Promise<Derivatives> {
  const empty: Derivatives = { thumb: null, large: null }
  if (!RASTER.test(file.type)) return empty

  const decoded = await decode(file)
  if (!decoded) return empty
  try {
    const thumb = await exportResized(decoded, THUMB_MAX_EDGE, 0.75)
    const large =
      file.size > SKIP_LARGE_BELOW_BYTES
        ? await exportResized(decoded, LARGE_MAX_EDGE, 0.82)
        : null
    return { thumb, large }
  } catch {
    return empty
  } finally {
    decoded.release()
  }
}
