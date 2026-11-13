import standardConfig from 'eslint-config-standard-kit'

export default [
  ...standardConfig({
    prettier: true,
    sortImports: true,
    node: true,
    react: true,
    typescript: true
  }),

  // **Type-aware rules must see the same types `npm run typecheck` does.**
  //
  // `standard-kit` turns on the project service, which picks the *nearest*
  // tsconfig — the one at the root, whose `moduleResolution` is `node`.
  // `tsconfig.app.json` deliberately resolves the way a bundler does, because
  // react-native 0.87 declares its types only inside its `exports` map and
  // Node10 resolution ignores them. Under the wrong one every
  // `from 'react-native'` is an implicit `any`, and the rules that read types
  // then draw exactly the wrong conclusions: fourteen `strict-boolean-expressions`
  // on values that are not `any` at all, and `no-unnecessary-type-assertion`
  // on three casts that are load-bearing — `--fix` removed them and broke the
  // build.
  {
    files: [
      'src/app/**/*.ts',
      'src/app/**/*.tsx',
      'src/common/**/*.ts',
      // The app's own test helpers, in its project.
      'src/test/chatWakeCases.ts',
      'src/test/fakeScoreboardSocket.ts',
      'src/test/PagedListStandIn.tsx',
      'src/test/responderDrag.ts',
      'src/test/scoringHelpers.ts',
      'src/test/scoreboardServer.e2e.ts'
    ],
    languageOptions: {
      parserOptions: { projectService: false, project: './tsconfig.app.json' }
    }
  },

  // Every modal of the app's is counted while on show (`modalPresence`), so
  // the ask about notifications never stacks on one: React Native's own
  // `Modal` is drawn only through the app's.
  {
    files: ['src/app/**/*.ts', 'src/app/**/*.tsx'],
    ignores: ['src/app/components/Modal.tsx', 'src/app/**/*.test.*'],
    rules: {
      // By name, so the TV code's `import * as ReactNative` stays allowed.
      'no-restricted-syntax': [
        'error',
        {
          selector:
            "ImportDeclaration[source.value='react-native'] > ImportSpecifier[imported.name='Modal']",
          message: "Use the app's Modal (src/app/components/Modal)."
        }
      ]
    }
  },

  // The server and its tests read their types from the server's own project,
  // as `npm run typecheck` does. Under the root tsconfig every one of them
  // would share a program holding the whole app as well, and one ESLint
  // process holding both ran out of an 8 GB heap.
  {
    files: ['src/server/**/*.ts', 'src/migrate/**/*.ts', 'src/test/**/*.ts'],
    ignores: [
      'src/test/chatWakeCases.ts',
      'src/test/fakeScoreboardSocket.ts',
      'src/test/scoringHelpers.ts',
      'src/test/scoreboardServer.e2e.ts',
      'src/test/scoringBrowser.e2e.ts',
      'src/test/chatBrowserLegacyActions.e2e.ts',
      'src/test/nativeLocationFailure.ts',
      'src/test/responderDrag.ts'
    ],
    languageOptions: {
      parserOptions: {
        projectService: false,
        project: './tsconfig.server.test.json'
      }
    }
  },

  {
    files: ['scripts/deploy.ts', 'scripts/deploy/**/*.ts'],
    languageOptions: {
      parserOptions: {
        projectService: false,
        project: './tsconfig.deploy.json'
      }
    }
  },
  {
    files: ['e2e/**/*.ts', 'e2e/**/*.tsx'],
    languageOptions: {
      parserOptions: {
        projectService: false,
        project: './tsconfig.e2e.json'
      }
    }
  },

  // The browser tests' helpers, outside `src`: the marker reader runs in a
  // page as well as in Node.
  {
    files: ['scripts/e2e/**/*.ts'],
    languageOptions: {
      parserOptions: {
        projectService: false,
        project: './tsconfig.e2eScripts.json'
      }
    }
  },

  {
    files: [
      'scripts/stampWallClockSei.ts',
      'scripts/chat-history-recovery-fixtures.ts',
      'scripts/chat-history-recovery-link.ts',
      'scripts/chat-history-recovery-native-scenes.ts',
      'scripts/chat-history-recovery-peer.ts',
      'scripts/chat-history-recovery-ui-scenes.ts',
      'scripts/chat-history-recovery-chat2.ts',
      'scripts/chat-history-recovery-relay.ts',
      'scripts/pushWakeVectors.ts',
      'scripts/e2e/**/*.ts',
      'scripts/splash/**/*.ts',
      'scripts/testModels.test.ts',
      'scripts/testTiers.test.ts',
      'scripts/testTools.test.ts'
    ],
    languageOptions: {
      parserOptions: {
        projectService: false,
        project: './tsconfig.scripts.json'
      }
    }
  },

  {
    files: ['Masonfile.ts', 'types/mason-pipeline.d.ts'],
    languageOptions: {
      parserOptions: { projectService: false, project: './tsconfig.mason.json' }
    }
  },

  // Global ignores need to be in their own block:
  {
    ignores: [
      '**/lib/**',
      '**/dist/**',
      '.cursor/**',
      '.test-tools/**',
      'tools/**',
      // Rust: the chat crypto core and its build products.
      'crates/**',
      // The mobile/ workspace is a React Native monorepo with its own
      // toolchain (RN babel, Metro, Hermes) and lint conventions that
      // diverge from the Node server's standard-kit config. It has its
      // own typecheck via `npm run lint` inside each app.
      'mobile/**'
    ]
  }
]
