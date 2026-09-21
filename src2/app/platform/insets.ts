/**
 * What the hardware takes out of the window, shared by both `safeArea` files.
 *
 * In a third module because a native sibling cannot import from its own web
 * twin: Metro resolves `./safeArea` inside `safeArea.native.ts` back to
 * itself, and the binding is `undefined` at run time.
 */
export interface Insets {
  top: number
  bottom: number
  left: number
  right: number
}
