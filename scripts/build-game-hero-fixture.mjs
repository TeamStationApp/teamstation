import { cp, mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'

import { build } from 'esbuild'

import { webSettings } from './web-build-settings.mjs'

const directory = process.env.TS_HERO_FIXTURE_DIR
if (!directory) throw new Error('Supply TS_HERO_FIXTURE_DIR')
await mkdir(directory, { recursive: true })
await build({
  ...webSettings,
  entryPoints: ['src/test/gameHeroActions.fixture.tsx'],
  bundle: true,
  platform: 'browser',
  format: 'iife',
  jsx: 'automatic',
  outfile: path.join(directory, 'app.js'),
  define: {
    __DEV__: 'true',
    global: 'globalThis',
    'process.env': '{}',
    'process.env.NODE_ENV': JSON.stringify('development'),
    'process.env.TS_SENTRY_DSN': JSON.stringify('')
  },
  loader: { '.png': 'dataurl', '.jpg': 'dataurl', '.svg': 'dataurl' }
})
await cp('src/app/assets/fonts', path.join(directory, 'fonts'), {
  recursive: true
})
await writeFile(
  path.join(directory, 'index.html'),
  await readFile('src/app/web/index.html')
)
