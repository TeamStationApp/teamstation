const path = require('node:path')
const { getDefaultConfig, mergeConfig } = require('@react-native/metro-config')
const app = __dirname
const root = path.resolve(app, '..')
const runtime =
  /^(react|react-native|react-native-svg|react-native-video|react-native-safe-area-context|react-native-patina)(\/|$)/
module.exports = mergeConfig(getDefaultConfig(app), {
  watchFolders: [path.join(root, 'src'), path.join(root, 'node_modules')],
  resolver: {
    // Pin native modules and React while preserving nested package dependencies.
    resolveRequest(context, name, platform) {
      return context.resolveRequest(
        runtime.test(name)
          ? { ...context, originModulePath: path.join(app, 'index.js') }
          : context,
        name,
        platform
      )
    },
    nodeModulesPaths: [path.join(app, 'node_modules')],
    blockList: [/\/appletv\/(DerivedData|ios\/Pods|ios\/build)\//]
  }
})
