import type { KeyboardShortcuts } from './keyboardShortcuts'

export type { KeyboardShortcuts }

/**
 * A phone has no keyboard, so there is nothing to bind.
 *
 * Not merely unnecessary — impossible. React Native defines `global.window`
 * but gives it no `addEventListener`, so the web version is a `TypeError` in
 * an effect that would run on every mount of the watch tab, and the screen it
 * takes down is the one the app is for.
 *
 * A hardware keyboard on an iPad is a real case and a real omission; it wants
 * `react-native-keyevent` or `UIKeyCommand` rather than a pretence that
 * `window` is a `Window`.
 */
export function useKeyboardShortcuts(_shortcuts: KeyboardShortcuts): void {
  // Nothing to listen to.
}
