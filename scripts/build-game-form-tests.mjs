import { existsSync, mkdirSync } from 'node:fs'

import { build } from 'esbuild'

import { webSettings } from './web-build-settings.mjs'

const suites = [
  'src/app/screens/TeamSelectorScene.test.tsx',
  'src/app/screens/gameDraft.test.ts',
  'src/app/screens/GameFormScreen.create.test.tsx',
  'src/app/screens/GameFormScreen.edit.test.tsx',
  'src/app/App.createGame.test.tsx',
  'src/app/App.eventSettings.test.tsx',
  'src/app/screens/EventSettingsScreen.test.tsx',
  'src/app/screens/EventDetailsForm.test.tsx',
  'src/app/components/EventScheduleFields.test.tsx',
  'src/app/components/EventVenueFields.test.tsx',
  'src/app/navigation/routes.test.ts',
  'src/app/screens/format.test.ts',
  'src/app/screens/EventRsvpModal.test.tsx',
  'src/app/screens/teamSchedule.test.tsx',
  'src/app/screens/TeamScreen.pending.test.tsx',
  'src/app/screens/GamesFeedScreen.test.tsx',
  'src/app/screens/GameScreen.eventInfo.test.tsx',
  'src/app/components/EventRsvpPill.test.tsx',
  'src/app/components/SegmentedPill.test.tsx',
  'src/app/screens/EventInfoTab.test.tsx',
  'src/app/screens/homeAddCreate.test.tsx',
  'src/app/screens/gameCreation.test.tsx'
].filter(existsSync)
mkdirSync('lib', { recursive: true })
await build({
  ...webSettings,
  alias: {
    ...webSettings.alias,
    'react-native-webview': './src/test/eventWebViewStub.tsx',
    '@react-native-clipboard/clipboard': './src/test/eventClipboardStub.ts'
  },
  stdin: {
    contents: suites.map(file => `import './${file}'`).join('\n'),
    resolveDir: process.cwd(),
    sourcefile: 'game-form-test-entry.ts'
  },
  outfile: 'lib/game-form-tests.cjs',
  platform: 'node',
  format: 'cjs',
  bundle: true,
  sourcemap: true,
  jsx: 'automatic',
  external: [
    'react',
    'react-dom',
    'jsdom',
    'mocha',
    'chai',
    'three',
    '@react-three/fiber',
    '@react-three/test-renderer',
    'leaflet/package.json'
  ],
  define: {
    __DEV__: 'true',
    TS_API_BASE_URL: JSON.stringify('/api/v1'),
    'process.env.NODE_ENV': JSON.stringify('test'),
    'process.env.TS_SENTRY_DSN': JSON.stringify('')
  },
  loader: { '.png': 'dataurl', '.jpg': 'dataurl', '.svg': 'dataurl' }
})
