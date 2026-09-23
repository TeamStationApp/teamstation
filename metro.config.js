const path = require('path')

const { getDefaultConfig, mergeConfig } = require('@react-native/metro-config')

/**
 * Metro bundles `src2/app/` and `src2/common/` — the same sources the web
 * build uses. Its project root is the repository root, because that is where
 * the package is.
 *
 * Nothing here redirects `react-native`: on a phone it is the real thing, and
 * the alias to `react-native-web` lives in `build.mjs` where it belongs.
 *
 * The block list keeps Metro out of the parts of the repository that are not
 * the app: the server's build output, the web bundle, the two native build
 * directories — thousands of files that change on every compile — and the two
 * trees that have nothing to do with this app, GameStation 1.0 in `src/` and
 * the separate native apps in `mobile/`.
 *
 * `expo-asset` and `expo-file-system` resolve to one stand-in: Fiber's native
 * entry imports them, and the app installs no Expo package beyond
 * `expo-modules-core` and `expo-gl` (see `src2/MOBILE.md`).
 *
 * `three` resolves to its ES module. Babel turns every `import` into a
 * `require`, so Metro asks for the `require` export, and three's CommonJS
 * entry calls Node's `process.emitWarning` and throws on a phone.
 */
const expoStandIn = path.resolve(
  __dirname,
  'src2/app/native/expoStandIn/assets.js'
)
const config = {
  resolver: {
    resolveRequest: (context, moduleName, platform) => {
      if (/^expo-(asset|file-system)(\/legacy)?$/.test(moduleName))
        return { type: 'sourceFile', filePath: expoStandIn }
      if (moduleName === 'three')
        return context.resolveRequest(
          { ...context, unstable_conditionNames: ['import'] },
          moduleName,
          platform
        )
      return context.resolveRequest(context, moduleName, platform)
    },
    blockList: [
      new RegExp(`^${escape(path.resolve(__dirname, 'src'))}/.*$`),
      new RegExp(`^${escape(path.resolve(__dirname, 'mobile'))}/.*$`),
      new RegExp(`^${escape(path.resolve(__dirname, 'lib'))}/.*$`),
      new RegExp(`^${escape(path.resolve(__dirname, 'dist'))}/.*$`),
      new RegExp(`^${escape(path.resolve(__dirname, 'ios', 'build'))}/.*$`),
      new RegExp(`^${escape(path.resolve(__dirname, 'ios', 'Pods'))}/.*$`),
      new RegExp(`^${escape(path.resolve(__dirname, 'android', 'build'))}/.*$`),
      new RegExp(
        `^${escape(path.resolve(__dirname, 'android', 'app', 'build'))}/.*$`
      )
    ]
  }
}

/** A path, safe to drop into a regular expression. */
function escape(text) {
  return text.replace(/[/\-\\^$*+?.()|[\]{}]/g, '\\$&')
}

module.exports = mergeConfig(getDefaultConfig(__dirname), config)
