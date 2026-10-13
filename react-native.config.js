/**
 * Where the native projects are.
 *
 * The app's own native code lives inside these two projects rather than in a
 * package of its own, so there is nothing here to add to autolinking.
 */
module.exports = {
  dependencies: {
    // EventMap.android uses this SDK; iOS keeps the WebView map adapter.
    'react-native-maps': { platforms: { ios: null } }
  },
  project: {
    ios: { sourceDir: 'ios' },
    android: { sourceDir: 'android' }
  }
}
