import { build } from 'esbuild'
import { fileURLToPath } from 'node:url'
import { SERVER_ESM_BANNER } from './server-bundle-options.mjs'

await build({
  absWorkingDir: fileURLToPath(new URL('../', import.meta.url)),
  entryPoints: ['app/server/src/index.ts'],
  outfile: 'app/server/dist/bundle.mjs',
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node22',
  logLevel: 'warning',
  banner: { js: SERVER_ESM_BANNER },
})
