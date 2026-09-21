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
 */
const config = {
  resolver: {
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
