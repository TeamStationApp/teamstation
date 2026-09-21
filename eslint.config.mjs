import standardConfig from 'eslint-config-standard-kit'

export default [
  ...standardConfig({
    prettier: true,
    sortImports: true,
    node: true,
    react: true,
    typescript: true
  }),

  // Global ignores need to be in their own block:
  {
    ignores: [
      '**/lib/**',
      '**/dist/**',
      '.cursor/**',
      // GameStation 1.0, frozen. It is kept for reference and has no build
      // configuration on this branch any more, so there is no tsconfig that
      // names its files and the typed rules cannot run over them. Its own
      // lint, with its own package, is on `paul/gameStation1` at `v1.0.0`.
      'src/**',
      'tools/**',
      // The mobile/ workspace is a React Native monorepo with its own
      // toolchain (RN babel, Metro, Hermes) and lint conventions that
      // diverge from the Node server's standard-kit config. It has its
      // own typecheck via `npm run lint` inside each app.
      'mobile/**'
    ]
  }
]
