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
const { bundleBuildInfo } = require('./scripts/build-info.cjs')
process.env.TS_BUILD_INFO = bundleBuildInfo()

module.exports = {
  presets: ['module:@react-native/babel-preset'],
  plugins: [
    // Two variables, inlined at build time. Metro does not read the
    // environment on its own — `process.env.ANYTHING` is simply undefined in a
    // bundle — so without this the override documented in
    // `src/app/native/config.ts` would be a comment describing something that
    // cannot happen. `TS_CHAT_BENCH=1` makes the chat crypto bench build
    // (`src/app/dev/chatBench.native.ts`). Named explicitly rather than
    // inlining the whole environment, which would bake whatever is in the
    // shell into the app. `metro.config.js` keys its cache on the same two.
    [
      'transform-inline-environment-variables',
      { include: ['TS_API_BASE_URL', 'TS_BUILD_INFO', 'TS_CHAT_BENCH'] }
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
