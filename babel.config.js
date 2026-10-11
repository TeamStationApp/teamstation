/**
 * Metro's Babel configuration, and nothing else's.
 *
 * The web bundle is esbuild's (`build.mjs`), which passes `configFile: false`
 * to the one Babel call it makes, and the tests run through sucrase. So this
 * file is read by Metro alone.
 *
 * `react-native-worklets/plugin` must stay last: it rewrites the functions
 * Reanimated runs on the UI thread, and it has to see them after every other
 * transform has had its turn.
 */
const { appOrigin } = require('./scripts/appOrigin.cjs')
const { bundleBuildInfo } = require('./scripts/build-info.cjs')
process.env.TS_BUILD_INFO = bundleBuildInfo()
process.env.TS_APP_ORIGIN = appOrigin()

module.exports = {
  presets: ['module:@react-native/babel-preset'],
  plugins: [
    // Explicit variables, inlined at build time. Metro does not read the
    // environment on its own — `process.env.ANYTHING` is simply undefined in a
    // bundle — so without this the override documented in
    // `src/app/native/config.ts` would be a comment describing something that
    // cannot happen. Named explicitly rather than inlining the whole
    // environment, which would bake whatever is in the shell into the app.
    [
      'transform-inline-environment-variables',
      {
        include: [
          'TS_API_BASE_URL',
          'TS_APP_ORIGIN',
          'TS_BUILD_INFO',
          'TS_CREATION_NATIVE_LOCATION_FAILURE',
          'TS_SENTRY_DSN'
        ]
      }
    ],
    // three.js, which the scoring field draws with, declares static blocks
    // inside its classes, and neither React Native's preset nor Hermes
    // understands them.
    '@babel/plugin-transform-class-static-block',
    // Last, always: it rewrites the functions Reanimated runs on the UI
    // thread, and it has to see them after every other transform has had its
    // turn.
    'react-native-worklets/plugin'
  ]
}
