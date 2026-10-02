/** Container validation only: playback still depends on the browser's codec support. */
export type VideoFormat = { ext: '.mp4' | '.webm'; mime: 'video/mp4' | 'video/webm' }

type Element = { id: string; start: number; end: number }

function mp4Boxes(data: Buffer, start = 0, end = data.length): Element[] {
  const boxes: Element[] = []
  while (start < end) {
    if (end - start < 8 || boxes.length >= 10000) throw new Error('Invalid MP4 box')
    let size = data.readUInt32BE(start)
    let header = 8
    if (size === 1) {
      if (end - start < 16) throw new Error('Invalid MP4 size')
      const extended = data.readBigUInt64BE(start + 8)
      if (extended > BigInt(end - start)) throw new Error('Invalid MP4 size')
      size = Number(extended)
      header = 16
    } else if (size === 0) size = end - start
    if (size < header || size > end - start) throw new Error('Invalid MP4 size')
    boxes.push({ id: data.toString('ascii', start + 4, start + 8), start: start + header, end: start + size })
    start += size
  }
  return boxes
}

function isMp4(data: Buffer): boolean {
  const boxes = mp4Boxes(data)
  const type = boxes.find((box) => box.id === 'ftyp')
  if (!type || type.end - type.start < 8 || (type.end - type.start) % 4) return false
  const brands = [data.toString('ascii', type.start, type.start + 4)]
  for (let offset = type.start + 8; offset < type.end; offset += 4) brands.push(data.toString('ascii', offset, offset + 4))
  if (!brands.some((brand) => /^(isom|iso[2-9]|mp4[12]|avc1|M4V |MSNV|dash)$/.test(brand))) return false
  if (!boxes.some((box) => box.id === 'mdat' && box.end > box.start)) return false
  return boxes.filter((box) => box.id === 'moov').some((movie) =>
    mp4Boxes(data, movie.start, movie.end).filter((box) => box.id === 'trak').some((track) =>
      mp4Boxes(data, track.start, track.end).filter((box) => box.id === 'mdia').some((media) =>
        mp4Boxes(data, media.start, media.end).some((box) => box.id === 'hdlr' && box.end - box.start >= 12 && data.toString('ascii', box.start + 8, box.start + 12) === 'vide'),
      ),
    ),
  )
}

function vint(data: Buffer, offset: number, id: boolean): { value: number; length: number; unknown: boolean } {
  const first = data[offset]
  if (!first) throw new Error('Invalid EBML integer')
  let mask = 0x80
  let length = 1
  while (!(first & mask)) { mask >>= 1; length++ }
  if (length > (id ? 4 : 8) || offset + length > data.length) throw new Error('Invalid EBML integer')
  let value = id ? first : first & (mask - 1)
  let unknown = !id && value === mask - 1
  for (let i = 1; i < length; i++) {
    value = value * 256 + data[offset + i]!
    unknown = unknown && data[offset + i] === 255
  }
  if (!unknown && !Number.isSafeInteger(value)) throw new Error('Invalid EBML size')
  return { value, length, unknown }
}

function ebmlElements(data: Buffer, start: number, end: number): Element[] {
  const elements: Element[] = []
  while (start < end) {
    if (elements.length >= 10000) throw new Error('Too many EBML elements')
    const id = vint(data, start, true)
    const size = vint(data, start + id.length, false)
    const body = start + id.length + size.length
    const next = size.unknown ? end : body + size.value
    // Streaming WebM files may omit the Segment or Cluster size.
    if (size.unknown && id.value !== 0x18538067 && id.value !== 0x1f43b675) throw new Error('Invalid EBML size')
    if (body > end || next > end) throw new Error('Truncated EBML element')
    elements.push({ id: id.value.toString(16), start: body, end: next })
    start = next
  }
  return elements
}

function isWebm(data: Buffer): boolean {
  if (data.length < 4 || data.readUInt32BE(0) !== 0x1a45dfa3) return false
  const roots = ebmlElements(data, 0, data.length)
  const header = roots[0]!
  const docType = ebmlElements(data, header.start, header.end).find((element) => element.id === '4282')
  if (!docType || data.toString('ascii', docType.start, docType.end) !== 'webm') return false
  const segment = roots.find((element) => element.id === '18538067')
  if (!segment) return false
  const children = ebmlElements(data, segment.start, segment.end)
  if (!children.some((element) => element.id === '1f43b675' && element.end > element.start)) return false
  return children.filter((element) => element.id === '1654ae6b').some((tracks) =>
    ebmlElements(data, tracks.start, tracks.end).filter((element) => element.id === 'ae').some((track) =>
      ebmlElements(data, track.start, track.end).some((element) => element.id === '83' && element.end - element.start === 1 && data[element.start] === 1),
    ),
  )
}

/** Require a recognizable video track; a MIME header or renamed audio/image file is insufficient. */
export function detectVideoFormat(data: Buffer): VideoFormat | null {
  try {
    if (isWebm(data)) return { ext: '.webm', mime: 'video/webm' }
    if (isMp4(data)) return { ext: '.mp4', mime: 'video/mp4' }
  } catch {
    // Malformed/truncated containers are rejected without leaking parser internals.
  }
  return null
}
