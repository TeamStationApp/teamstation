/** Native focus/back are handled by accessible views and BackHandler. */
import type { ChatBounds } from './chatInteractionModel'
export const immediatePressProps = {}
export const messageTooltipProps = (_label: string): object => ({})
export function bindMessageTooltips(_view: unknown): () => void {
  return () => {}
}
export function isRestoringPopupFocus(): boolean {
  return false
}
export function bindPopupKeys(_view: unknown, _close: () => void): () => void {
  return () => {}
}
export function isFinePointer(): boolean {
  return false
}
export function bindUserScroll(_view: unknown, _read: () => void): () => void {
  return () => {}
}
export function bindMessageHover(
  _view: unknown,
  _update: (visible: boolean) => void
): () => void {
  return () => {}
}
export function watchMessageAnchor(
  _view: unknown,
  _update: (bounds: ChatBounds) => void,
  _close: () => void
): () => void {
  return () => {}
}
