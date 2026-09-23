/**
 * What `expo-gl` imports from `expo`: the `expo-modules-core` API, which the
 * real package re-exports, with `requireNativeViewManager` under the name
 * `requireNativeView`. See src2/MOBILE.md.
 */
const core = require('expo-modules-core')

module.exports = Object.assign({}, core, {
  requireNativeView: core.requireNativeViewManager
})
