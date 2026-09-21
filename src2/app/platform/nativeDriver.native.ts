/**
 * Whether `Animated` may hand an animation to the platform.
 *
 * **Yes**, on a phone, for the two animations that use it — a pill's opacity
 * and a sweep's `translateX`, both of which the animation thread can run on
 * its own. Left on the JavaScript thread they would stutter whenever anything
 * else was happening, which on the screens they appear on is a list scrolling
 * and a video decoding.
 */
export const USE_NATIVE_DRIVER = true
