const path = require('path')

const { getDefaultConfig, mergeConfig } = require('@react-native/metro-config')

const { appOrigin } = require('./scripts/appOrigin.cjs')

/**
 * Metro bundles `src/app/` and `src/common/` — the same sources the web
 * build uses. Its project root is the repository root, because that is where
 * the package is.
 *
 * Nothing here redirects `react-native`: on a phone it is the real thing, and
 * the alias to `react-native-web` lives in `build.mjs` where it belongs.
 *
 * The block list keeps Metro out of the parts of the repository that are not
 * the app: the server's build output, the web bundle, the two native build
 * directories — thousands of files that change on every compile — and the
 * separate native apps in `mobile/`, which have nothing to do with this app.
 *
 * `expo-asset` and `expo-file-system` resolve to one stand-in: Fiber's native
 * entry imports them, and the app installs no Expo package beyond
 * `expo-modules-core` and `expo-gl` (see `src/MOBILE.md`).
 *
 * `three` resolves to its ES module. Babel turns every `import` into a
 * `require`, so Metro asks for the `require` export, and three's CommonJS
 * entry calls Node's `process.emitWarning` and throws on a phone.
 *
 * A `node_modules` directory next to the app sources is closer to those
 * files than the repository install, so hierarchical lookup would load a
 * second React for `src/app` while React Native's renderer keeps the
 * repository copy. The renderer installs the hook dispatcher on its own
 * copy, and the app's first `useState` then reads null and the phone
 * quits on launch. A resolution that lands in that nearer directory is
 * tried again from the repository root, where the renderer looks.
 */
const expoStandIn = path.resolve(
  __dirname,
  'src/app/native/expoStandIn/assets.js'
)
const strayModules = path.resolve(__dirname, 'src', 'node_modules') + path.sep
const repositoryOrigin = path.join(__dirname, 'package.json')
const config = {
  // Everything Babel inlines that can change between builds of the same
  // source, so a new value is a new transform rather than a cached old one.
  cacheVersion: JSON.stringify([
    process.env.TS_API_BASE_URL ?? 'production',
    appOrigin(),
    process.env.TS_CREATION_NATIVE_LOCATION_FAILURE ?? 'provider'
  ]),
  resolver: {
    resolveRequest: (context, moduleName, platform) => {
      // An explicit test build can exercise provider failures through the real
      // native locality screen. Release bundles still call the native provider.
      if (
        ['unavailable', 'timeout'].includes(
          process.env.TS_CREATION_NATIVE_LOCATION_FAILURE
        ) &&
        /\/platform\/getRoughLocation$/.test(moduleName)
      )
        return {
          type: 'sourceFile',
          filePath: path.resolve(__dirname, 'src/test/nativeLocationFailure.ts')
        }
      if (/^expo-(asset|file-system)(\/legacy)?$/.test(moduleName))
        return { type: 'sourceFile', filePath: expoStandIn }
      if (moduleName === 'three')
        return context.resolveRequest(
          { ...context, unstable_conditionNames: ['import'] },
          moduleName,
          platform
        )
      const resolved = context.resolveRequest(context, moduleName, platform)
      if (resolved?.filePath?.startsWith(strayModules))
        return context.resolveRequest(
          { ...context, originModulePath: repositoryOrigin },
          moduleName,
          platform
        )
      return resolved
    },
    blockList: [
      new RegExp(`^${escape(strayModules)}.*$`),
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
