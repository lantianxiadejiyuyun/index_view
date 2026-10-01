import test from 'node:test'
import assert from 'node:assert/strict'
import { hostOf, matchItems, matches, normalizeItemUrl } from '../chrome_plug_in/src/match.js'
import { normalizeServer } from '../chrome_plug_in/src/sync.js'
import { createFile, unlockFile, upsertItem, sealFile, parseImport, exportPlain, validateFile } from '../chrome_plug_in/src/vault.js'
import { generatePassword } from '../chrome_plug_in/src/generator.js'

test('credential matching isolates hosts, IP addresses and shared hosting tenants', () => {
  assert.equal(matches({ url: 'https://mail.example.com' }, 'https://mail.example.com/login'), true)
  for (const [saved, target] of [
    ['mail.example.com', 'www.example.com'], ['alice.github.io', 'bob.github.io'],
    ['192.168.1.2', '10.0.1.2'], ['example.com', 'example.com.evil.test'],
  ]) assert.equal(matches({ url: saved }, 'https://' + target), false)
  assert.equal(hostOf('https://EXAMPLE.com./login'), 'example.com')
  assert.equal(hostOf('https://user:password@example.com'), '')
  assert.equal(hostOf('javascript://example.com'), '')
})

test('subdomain wildcard is explicit, bounded, and sorts after exact hosts', () => {
  assert.equal(matches({ url: '*.example.com' }, 'https://a.b.example.com'), true)
  assert.equal(matches({ url: '*.example.com' }, 'https://example.com'), false)
  assert.equal(matches({ url: '*.example.com' }, 'https://example.com.evil.test'), false)
  assert.throws(() => normalizeItemUrl('*.127.0.0.1'))
  assert.throws(() => normalizeItemUrl('*example.com'))
  assert.deepEqual(matchItems([
    { id: 'wildcard', url: '*.example.com' }, { id: 'exact', url: 'login.example.com' },
  ], 'https://login.example.com').map((item) => item.id), ['exact', 'wildcard'])
})

test('server URL normalization defaults public hosts to HTTPS and validates private ranges', () => {
  assert.deepEqual(normalizeServer('example.com/path/'), { ok: true, base: 'https://example.com/path', insecure: false })
  for (const address of ['localhost:3000', '127.2.3.4:3000', '[::1]:3000', '192.168.1.2', '172.31.0.2']) {
    const result = normalizeServer(address)
    assert.equal(result.ok, true, address)
    assert.equal(result.insecure, true, address)
  }
  for (const address of ['', 'http://10.evil.com', 'http://192.168.evil.test', 'ftp://localhost',
    'https://user:password@example.com', 'https://example.com?secret=1', 'https://example.com/#hash']) {
    assert.equal(normalizeServer(address).ok, false, address)
  }
})

test('vault validates KDF bounds, passwords, and encrypted file structure before derivation', async () => {
  await assert.rejects(createFile('short'), /至少 8/)
  const created = await createFile('correct-test-password')
  const decoded = await unlockFile(created.file, 'correct-test-password')
  assert.deepEqual(decoded.vault.items, [])
  await assert.rejects(unlockFile(created.file, 'incorrect-password'), { name: 'BadPasswordError' })
  for (const iterations of [0, -1, 50, 6_000_000, Infinity]) {
    assert.throws(() => validateFile({ ...created.file, kdf: { ...created.file.kdf, iterations } }), /参数/)
  }
  assert.throws(() => validateFile({ ...created.file, v: 999 }), /版本/)
  assert.throws(() => validateFile({ ...created.file, payload: { iv: 'bad', data: 'bad' } }))
})

test('plain import validates every entry and assigns independent IDs for safe append', () => {
  const valid = { id: 'existing-id', title: 'Login', url: 'example.com', username: 'alice', password: 'fake-password' }
  const parsed = parseImport(exportPlain({ items: [valid, valid] }))
  assert.equal(parsed.items.length, 2)
  assert.notEqual(parsed.items[0].id, valid.id)
  assert.notEqual(parsed.items[0].id, parsed.items[1].id)
  assert.throws(() => parseImport('null'))
  assert.throws(() => parseImport(JSON.stringify({ app: 'hd-pm', kind: 'plain-vault', items: [null] })))
  assert.throws(() => parseImport(JSON.stringify({ app: 'hd-pm', kind: 'plain-vault', items: [{ ...valid, password: {} }] })))
})

test('item persistence preserves metadata and rejects corrupt entries without mutating the vault', async () => {
  const created = await createFile('correct-test-password')
  const populated = upsertItem(created.vault, { title: 'Example', url: 'example.com', username: 'alice', password: 'fake' })
  assert.equal(created.vault.items.length, 0)
  assert.ok(populated.items[0].id)
  assert.ok(populated.items[0].createdAt)
  const edited = upsertItem(populated, { id: populated.items[0].id, password: 'changed' })
  assert.equal(edited.items.length, 1)
  assert.equal(edited.items[0].createdAt, populated.items[0].createdAt)
  const sealed = await sealFile(created.file, edited, created.vaultKey)
  assert.equal((await unlockFile(sealed.file, 'correct-test-password')).vault.items[0].password, 'changed')
  assert.throws(() => upsertItem(populated, { title: 'Broken', url: 'ftp://example.com' }))
})

test('password generation handles nonfinite and fractional lengths without runaway loops', () => {
  assert.equal(generatePassword({ length: Infinity }).length, 20)
  assert.equal(generatePassword({ length: 8.9 }).length, 8)
  assert.equal(generatePassword({ length: 1000000 }).length, 256)
  const password = generatePassword({ length: 20 })
  for (const expression of [/[a-z]/, /[A-Z]/, /[2-9]/, /[^a-zA-Z0-9]/]) assert.match(password, expression)
})
