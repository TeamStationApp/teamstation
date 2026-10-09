/** Native focus/back are handled by accessible views and BackHandler. */
export const immediatePressProps = {}
export function isRestoringPopupFocus(): boolean {
  return false
}
export function bindPopupKeys(_view: unknown, _close: () => void): () => void {
  return () => {}
}
