/**
 * Where the native projects are.
 *
 * The app's own native code lives inside these two projects rather than in a
 * package of its own, so there is nothing here to add to autolinking.
 *
 * react-native-maps links on both platforms: Google's SDK on Android, and on
 * iOS only its default subspec, the Apple Maps (MapKit) view, with no Google
 * Maps SDK pod.
 */
module.exports = {
  project: {
    ios: { sourceDir: 'ios' },
    android: { sourceDir: 'android' }
  }
}
