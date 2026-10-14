import { readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { resolve } from 'node:path'
const root = process.cwd()
process.chdir(root)
const require = createRequire(resolve('package.json'))
const { build } = require('esbuild')
const { webSettings } = await import(root + '/scripts/web-build-settings.mjs')
const base = process.env.TS_SETTINGS3_BASE_WEB
if (base == null)
  throw new Error(
    'Supply TS_SETTINGS3_BASE_WEB pointing to the sealed parent bundle'
  )
const map = JSON.parse(
  readFileSync(
    base + '/' + readdirSync(base).find(f => /^app-.*\.js\.map$/.test(f)),
    'utf8'
  )
)
const frozen = new Map(
  map.sources.map((s, i) => [resolve('dist', s), map.sourcesContent[i]])
)
for (const file of [
  'components/DateRangePicker.tsx',
  'components/StatFilterModal.tsx',
  'components/RolesModal.tsx',
  'components/EventScheduleFields.tsx',
  'screens/PromoteExternalScreen.tsx',
  'screens/GroupLinkScreen.tsx',
  'screens/GameFormScreen.tsx',
  'screens/PlaceholderTeamForm.tsx',
  'screens/GroupLocationPage.tsx',
  'screens/GroupPeoplePage.tsx'
]) {
  if (!frozen.has(resolve('src/app', file)))
    throw new Error('Parent source missing for ' + file)
}
for (const phase of ['before', 'after']) {
  const out = phase === 'before' ? base : resolve('dist')
  await build({
    ...webSettings,
    plugins: [
      ...(phase === 'before'
        ? [
            {
              name: 'sealed-parent-source',
              setup(b) {
                b.onLoad({ filter: /\.[jt]sx?$/ }, a =>
                  frozen.has(a.path)
                    ? {
                        contents: frozen.get(a.path),
                        loader: /tsx?$/.test(a.path)
                          ? a.path.endsWith('tsx')
                            ? 'tsx'
                            : 'ts'
                          : 'jsx'
                      }
                    : undefined
                )
              }
            }
          ]
        : []),
      ...webSettings.plugins
    ],
    entryPoints: ['src/app/settingsCancelVisual.e2e.tsx'],
    outfile: out + '/cancel-visual.js',
    bundle: true,
    format: 'iife',
    jsx: 'automatic',
    target: ['es2021'],
    define: {
      __DEV__: 'false',
      'process.env.NODE_ENV': '"production"',
      'process.env.TS_SENTRY_DSN': '""',
      'process.env.TS_BUILD_INFO': 'undefined',
      TS_FIELD_PREVIEW: 'false',
      TS_PASSWORD_WORKER_URL: '""',
      TS_API_BASE_URL: '"/api/v1"',
      global: 'globalThis'
    },
    loader: {
      '.png': 'dataurl',
      '.jpg': 'dataurl',
      '.svg': 'dataurl',
      '.ttf': 'dataurl'
    }
  })
  writeFileSync(
    out + '/cancel-visual.html',
    readFileSync('src/app/web/index.html', 'utf8').replace(
      '/app.js',
      '/cancel-visual.js'
    )
  )
}
