/**
 * Whether `Animated` may hand an animation to the platform.
 *
 * **No**, in a browser: there is no native driver to hand it to, and asking
 * for one reaches into React Native's bridge helper, which react-native-web
 * does not have, and brings the screen down with it.
 */
export const USE_NATIVE_DRIVER = false
