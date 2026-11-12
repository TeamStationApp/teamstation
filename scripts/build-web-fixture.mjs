// Builds a web fixture: one entry that mounts itself into #root, bundled as
// the app is, beside the app's index.html and fonts, ready to be served.
//
//   node scripts/build-web-fixture.mjs <entry> <directory>
import { cp, mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

import { build } from 'esbuild'

import { webSettings } from './web-build-settings.mjs'

const [entry, directory] = process.argv.slice(2)
if (!entry || !directory)
  throw new Error('Usage: build-web-fixture.mjs <entry> <directory>')
await mkdir(directory, { recursive: true })
await build({
  ...webSettings,
  entryPoints: [entry],
  bundle: true,
  platform: 'browser',
  format: 'iife',
  jsx: 'automatic',
  outfile: join(directory, 'app.js'),
  sourcemap: true,
  define: {
    __DEV__: 'true',
    global: 'globalThis',
    'process.env': '{}',
    'process.env.NODE_ENV': JSON.stringify('development'),
    'process.env.TS_SENTRY_DSN': JSON.stringify('')
  },
  loader: { '.png': 'dataurl', '.jpg': 'dataurl', '.svg': 'dataurl' }
})
await cp('src/app/assets/fonts', join(directory, 'fonts'), { recursive: true })
await writeFile(
  join(directory, 'index.html'),
  await readFile('src/app/web/index.html')
)
