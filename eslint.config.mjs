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
    files: ['src/app/**/*.ts', 'src/app/**/*.tsx', 'src/common/**/*.ts'],
    languageOptions: {
      parserOptions: { projectService: false, project: './tsconfig.app.json' }
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

  // Global ignores need to be in their own block:
  {
    ignores: [
      '**/lib/**',
      '**/dist/**',
      '.cursor/**',
      'tools/**',
      // The mobile/ workspace is a React Native monorepo with its own
      // toolchain (RN babel, Metro, Hermes) and lint conventions that
      // diverge from the Node server's standard-kit config. It has its
      // own typecheck via `npm run lint` inside each app.
      'mobile/**'
    ]
  }
]
