/** Connection form drafts contain only an address and username, never secrets. */
export const SERVER_FORM_DRAFT_KEY = 'serverFormDraft'

export function safeServerForm(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  if (typeof value.base !== 'string' || typeof value.user !== 'string') return null
  return { base: value.base, user: value.user }
}

export function selectServerForm(draft, account) {
  return safeServerForm(draft) ?? { base: account?.base || '', user: account?.user || '' }
}

export function createServerFormCache({ send, delay = 250, onError = () => {}, onInvalidate = () => {} }) {
  let timer = null
  let draft = null
  let revision = null
  let latestWrite = Promise.resolve()

  function stopTimer() {
    if (timer !== null) clearTimeout(timer)
    timer = null
  }

  function flush(value) {
    stopTimer()
    if (value !== undefined) draft = safeServerForm(value)
    if (!draft) return latestWrite
    const saved = draft
    draft = null
    const sentRevision = revision
    // Dispatch immediately, including from pagehide. The worker owns serialization
    // and keeps the operation alive after this page's JavaScript context is gone.
    latestWrite = send('server-form-save', { draft: saved, revision: sentRevision }).then((result) => {
      if (revision === sentRevision && result.saved === false) invalidate(result.revision)
      return result
    })
    return latestWrite
  }

  function invalidate(nextRevision) {
    if (typeof nextRevision !== 'string' || !nextRevision || nextRevision === revision) return
    revision = nextRevision
    stopTimer()
    draft = null
    onInvalidate()
  }

  return {
    async load() {
      const startedAt = revision
      const result = await send('server-form-get')
      // A reset broadcast can arrive while the initial read is still in flight.
      if (revision !== startedAt) return null
      revision = result.revision
      return safeServerForm(result.draft)
    },
    schedule(value) {
      draft = safeServerForm(value)
      stopTimer()
      timer = setTimeout(() => { void flush().catch(onError) }, delay)
    },
    flush,
    invalidate,
  }
}
