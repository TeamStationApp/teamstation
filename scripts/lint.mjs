// Lints the repository in three ESLint processes, one per TypeScript project
// the type-aware rules read: the app's, the server's, and the root one for
// everything else. One process holding all three ran out of an 8 GB heap.
//
//   node scripts/lint.mjs [eslint arguments…]   (`npm run lint`; e.g. --fix)
import { spawnSync } from 'node:child_process'

// In tsconfig.app.json, though they sit under src/test.
const appHelpers = [
  'src/test/chatWakeCases.ts',
  'src/test/fakeScoreboardSocket.ts',
  'src/test/PagedListStandIn.tsx',
  'src/test/responderDrag.ts',
  'src/test/scoringHelpers.ts',
  'src/test/scoreboardServer.e2e.ts'
]
// Under src/test, but left out of tsconfig.server.test.json.
const serverExcluded = [
  ...appHelpers,
  'src/test/scoringBrowser.e2e.ts',
  'src/test/chatBrowserLegacyActions.e2e.ts',
  'src/test/nativeLocationFailure.ts'
]
const ignore = patterns => patterns.flatMap(p => ['--ignore-pattern', p])

const passes = [
  ['app', ['src/app', 'src/common', ...appHelpers]],
  [
    'server',
    ['src/server', 'src/migrate', 'src/test/**/*.ts', ...ignore(serverExcluded)]
  ],
  [
    'rest',
    [
      '.',
      ...ignore([
        'src/app/**',
        'src/common/**',
        'src/server/**',
        'src/migrate/**',
        'src/test/**/*.ts',
        ...serverExcluded
          .filter(file => !appHelpers.includes(file))
          .map(file => `!${file}`),
        ...appHelpers
      ])
    ]
  ]
]

let failed = false
for (const [name, args] of passes) {
  const started = Date.now()
  const run = spawnSync(
    process.execPath,
    [
      '--max-old-space-size=8192',
      'node_modules/eslint/bin/eslint.js',
      ...args,
      ...process.argv.slice(2)
    ],
    { stdio: 'inherit' }
  )
  console.log(`lint ${name}: ${Math.round((Date.now() - started) / 1000)} s`)
  if (run.status !== 0) failed = true
}
process.exit(failed ? 1 : 0)
