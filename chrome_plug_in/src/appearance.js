/** Browser-local website preferences; never read or mutate the encrypted vault. */
export const DEFAULT_APPEARANCE = Object.freeze({
  bilibiliTheme: 'system',
  taobaoTheme: 'system',
  goofishTheme: 'system',
  hideBilibiliAdblockTips: true,
})

const isRecord = (value) => value !== null && typeof value === 'object' && !Array.isArray(value)

export function normalizeAppearance(value) {
  const source = isRecord(value) ? value : {}
  return Object.fromEntries(Object.entries(DEFAULT_APPEARANCE).map(([key, fallback]) => [key,
    Object.hasOwn(source, key) && (key === 'hideBilibiliAdblockTips'
      ? typeof source[key] === 'boolean'
      : source[key] === 'system' || source[key] === 'off') ? source[key] : fallback,
  ]))
}

function validatePatch(patch) {
  if (!isRecord(patch) || !Object.keys(patch).length || Object.entries(patch).some(([key, value]) =>
    !Object.hasOwn(DEFAULT_APPEARANCE, key) || (key === 'hideBilibiliAdblockTips'
      ? typeof value !== 'boolean' : value !== 'system' && value !== 'off'))) {
    throw Object.assign(new Error('网站外观设置无效'), { code: 'invalid_appearance' })
  }
  return { ...patch }
}

export function createAppearanceStore(storage) {
  // All extension settings pages share this worker queue. A failed write must
  // neither discard sibling preferences nor block the next request.
  let work = Promise.resolve()
  const enqueue = (task) => {
    const result = work.then(task)
    work = result.catch(() => {})
    return result
  }
  return {
    reset(clearStorage) {
      // The explicit reset-all action must follow any in-flight appearance
      // writes, otherwise a late write could recreate the cleared settings.
      return enqueue(clearStorage)
    },
    get() {
      return enqueue(async () => normalizeAppearance((await storage.get('websiteAppearance')).websiteAppearance))
    },
    set(value) {
      const patch = validatePatch(value)
      return enqueue(async () => {
        const { websiteAppearance } = await storage.get('websiteAppearance')
        const merged = { ...(isRecord(websiteAppearance) ? websiteAppearance : {}), ...patch }
        await storage.set({ websiteAppearance: merged })
        return normalizeAppearance(merged)
      })
    },
  }
}
