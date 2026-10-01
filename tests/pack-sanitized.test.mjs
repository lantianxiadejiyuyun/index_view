import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { execFile } from 'node:child_process'
import { inflateRawSync } from 'node:zlib'
import test from 'node:test'

const run = promisify(execFile)
const script = await fs.readFile(fileURLToPath(new URL('../scripts/pack-sanitized.mjs', import.meta.url)), 'utf8')

async function fixture(t, files) {
  const directory = await fs.mkdtemp(path.join(tmpdir(), 'hd-source-export-test-'))
  const realDirectory = await fs.realpath(directory)
  t.after(async () => {
    const current = await fs.realpath(directory)
    if (current !== realDirectory || path.dirname(current) !== await fs.realpath(tmpdir()) || !path.basename(current).startsWith('hd-source-export-test-')) throw new Error('Unexpected fixture cleanup target')
    await fs.rm(current, { recursive: true })
  })
  for (const [relative, content] of Object.entries({ 'scripts/pack-sanitized.mjs': script, ...files })) {
    const destination = path.join(directory, relative)
    await fs.mkdir(path.dirname(destination), { recursive: true })
    await fs.writeFile(destination, content)
  }
  return directory
}

function unzip(zip) {
  const files = new Map()
  let offset = 0
  while (zip.readUInt32LE(offset) === 0x04034b50) {
    const size = zip.readUInt32LE(offset + 18)
    const nameLength = zip.readUInt16LE(offset + 26)
    const extraLength = zip.readUInt16LE(offset + 28)
    const start = offset + 30 + nameLength + extraLength
    const name = zip.subarray(offset + 30, offset + 30 + nameLength).toString('utf8')
    const content = inflateRawSync(zip.subarray(start, start + size))
    assert.equal(content.length, zip.readUInt32LE(offset + 22))
    files.set(name, content.toString('utf8'))
    offset = start + size
  }
  assert.equal(zip.readUInt32LE(offset), 0x02014b50)
  assert.equal(zip.readUInt16LE(zip.length - 12), files.size)
  return files
}

test('source ZIP includes tests and extension, excludes runtime material, and applies private local rules', async (t) => {
  const directory = await fixture(t, {
    'README.md': 'internal.example.invalid',
    '.env.example': 'EXAMPLE=true',
    '.env.production': 'synthetic-private-environment',
    'app/server/src/server.ts': 'export const app = true',
    'app/server/src/data/model.ts': 'export const model = true',
    'app/web/src/components/notes/Editor.tsx': 'export const Editor = true',
    'app/web/src/uploads/index.ts': 'export const upload = true',
    'app/web/src/backups/index.ts': 'export const backup = true',
    'app/server/src/.env.production': 'synthetic-private-environment',
    'app/server/src/backup.sqlite3-wal': 'synthetic-private-database',
    'app/server/src/local-rules.json': JSON.stringify({ replacements: [{ find: 'internal.example.invalid', replace: 'public.example.com' }], forbidden: ['internal.example.invalid'] }),
    'app/server/data/app.db': 'synthetic-private-database',
    'app/web/dist/index.html': 'build-output',
    'agent/node/index.mjs': 'export const agent = true',
    'agent/node/agent-key': 'synthetic-private-key',
    'agent/node/services.json': 'synthetic-private-services',
    'agent/node/private.pem': 'synthetic-private-certificate',
    'chrome_plug_in/manifest.json': '{}',
    'tests/fixture.test.mjs': 'test fixture',
    'notes/personal.md': 'synthetic-private-note',
    'uploads/private.png': 'synthetic-private-image',
  })
  await run(process.execPath, ['scripts/pack-sanitized.mjs'], { cwd: directory, env: { ...process.env, SANITIZE_RULES: path.join(directory, 'app/server/src/local-rules.json') }, windowsHide: true })
  const [exportFolder] = await fs.readdir(path.join(directory, '.tmp'))
  const archive = await fs.readFile(path.join(directory, '.tmp', exportFolder, 'home-dashboard-source.zip'))
  const entries = unzip(archive)
  assert.equal(entries.get('README.md'), 'public.example.com')
  assert.equal(entries.get('.env.example'), 'EXAMPLE=true')
  assert.ok(entries.has('tests/fixture.test.mjs'))
  assert.ok(entries.has('chrome_plug_in/manifest.json'))
  assert.ok(entries.has('app/server/src/server.ts'))
  assert.ok(entries.has('app/server/src/data/model.ts'))
  assert.ok(entries.has('app/web/src/components/notes/Editor.tsx'))
  assert.ok(entries.has('app/web/src/uploads/index.ts'))
  assert.ok(entries.has('app/web/src/backups/index.ts'))
  assert.ok(entries.has('agent/node/index.mjs'))
  assert.equal(entries.size, 11)
  assert.ok([...entries.values()].every((content) => !content.includes('synthetic-private-')))
  assert.ok([...entries.keys()].every((name) => !name.includes('local-rules')))
  assert.equal(await fs.readFile(path.join(directory, 'README.md'), 'utf8'), 'internal.example.invalid')
})

test('forbidden values stop export without including rule contents in errors', async (t) => {
  const marker = 'synthetic-secret-for-export-test'
  const directory = await fixture(t, { 'README.md': marker, '.sanitize.local.json': JSON.stringify({ forbidden: [marker] }) })
  await assert.rejects(run(process.execPath, ['scripts/pack-sanitized.mjs'], { cwd: directory, env: { ...process.env, SANITIZE_RULES: path.join(directory, '.sanitize.local.json') }, windowsHide: true }), (error) => {
    assert.match(error.stderr, /Local forbidden value remains in README.md/)
    assert.ok(!error.stderr.includes(marker))
    return true
  })
  await assert.rejects(fs.access(path.join(directory, '.tmp')))
})
