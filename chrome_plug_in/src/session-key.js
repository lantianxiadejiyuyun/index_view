/** Opt-in, device-local recovery. CryptoKey stays non-extractable; no password is stored. */
function transact(mode, action) {
  return new Promise((resolve, reject) => {
    if (!globalThis.indexedDB) { reject(new Error('浏览器不支持保存本机恢复密钥')); return }
    let abandoned = false
    const open = indexedDB.open('hd-pm-session', 1)
    open.onupgradeneeded = () => {
      if (!open.result.objectStoreNames.contains('keys')) open.result.createObjectStore('keys')
    }
    open.onerror = () => { abandoned = true; reject(open.error) }
    open.onblocked = () => {
      abandoned = true
      reject(new Error('本机恢复密钥存储被占用，请关闭其他插件页面后重试'))
    }
    open.onsuccess = () => {
      const db = open.result
      if (abandoned) { db.close(); return }
      db.onversionchange = () => db.close()
      try {
        const tx = db.transaction('keys', mode)
        const request = action(tx.objectStore('keys'))
        tx.oncomplete = () => { db.close(); resolve(request.result ?? null) }
        tx.onabort = tx.onerror = () => { db.close(); reject(tx.error || request.error || new Error('本机恢复密钥保存失败')) }
      } catch (error) { db.close(); reject(error) }
    }
  })
}

export const readSessionKey = () => transact('readonly', (store) => store.get('active'))
export const writeSessionKey = (record) => transact('readwrite', (store) => store.put(record, 'active'))
export const clearSessionKey = () => globalThis.indexedDB
  ? transact('readwrite', (store) => store.delete('active')) : Promise.resolve()
