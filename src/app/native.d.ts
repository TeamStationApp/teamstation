/**
 * The globals a React Native runtime defines and its types leave out.
 *
 * `tsconfig.native.json` deliberately has no `dom` library, which is what
 * makes every stray `window` and `document` a compile error rather than a
 * crash on the device. That leaves the handful of globals the phone really has
 * to be declared, and this is the whole list.
 */
// React Native's own name for it, so the format is not ours to pick.
// eslint-disable-next-line @typescript-eslint/naming-convention
declare const __DEV__: boolean
/** React Native installs this timer primitive in its runtime. */
declare function queueMicrotask(callback: () => void): void
/**
 * React Native installs `performance.now()` at startup (`setUpPerformance`),
 * a monotonic clock, though its types leave it out.
 */
declare const performance: { now: () => number }
