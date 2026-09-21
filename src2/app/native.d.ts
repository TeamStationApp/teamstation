/**
 * The globals a React Native runtime defines and a browser does not.
 *
 * `tsconfig.native.json` deliberately has no `dom` library, which is what
 * makes every stray `window` and `document` a compile error rather than a
 * crash on the device. That leaves the handful of genuinely-native globals to
 * be declared, and this is the whole list.
 */
// React Native's own name for it, so the format is not ours to pick.
// eslint-disable-next-line @typescript-eslint/naming-convention
declare const __DEV__: boolean
