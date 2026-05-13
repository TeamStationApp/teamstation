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
      // The mobile/ workspace is a React Native monorepo with its own
      // toolchain (RN babel, Metro, Hermes) and lint conventions that
      // diverge from the Node server's standard-kit config. It has its
      // own typecheck via `npm run lint` inside each app.
      'mobile/**'
    ]
  }
]
