/** Native focus/back are handled by accessible views and BackHandler. */
import type { ChatBounds } from './chatInteractionModel'
export function readDocumentActive(): boolean {
  return true
}
export function watchReadDocumentActive(
  _update: (active: boolean) => void
): () => void {
  return () => {}
}
export const immediatePressProps = {}
export const messageTooltipProps = (_label: string): object => ({})
export function bindMessageTooltips(_view: unknown): () => void {
  return () => {}
}
export function isRestoringPopupFocus(): boolean {
  return false
}
export function bindPopupKeys(
  _view: unknown,
  _close: () => void,
  _trap = true,
  _initialField = false,
  _rowSelector?: string
): () => void {
  return () => {}
}
export function isFinePointer(): boolean {
  return false
}
export function bindComposerKeys(
  _view: unknown,
  _onSend: () => void
): () => void {
  return () => {}
}
export function bindUserScroll(
  _view: unknown,
  _read: () => void,
  _position?: (offset: number) => void,
  _motion?: () => void
): () => void {
  return () => {}
}
/** Native rows are measured relative to the native scroll viewport instead. */
export function readMessageScrollPosition(
  _view: unknown,
  _rows: ReadonlyMap<string, unknown>
):
  | {
      offset: number
      anchor: { id: string; relativeY: number } | undefined
      geometry?: { height: number; content: number }
    }
  | undefined {
  return undefined
}
export function cancelUserScroll(_view: unknown): void {}
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

export function focusPopupControl(_view: unknown): void {}

export function watchVisualViewport(
  _update: (value: { bottom: number; keyboardOpen: boolean }) => void
): () => void {
  return () => {}
}

export function setComposerSelection(
  view: unknown,
  selection: { start: number; end: number }
): void {
  ;(
    view as {
      setNativeProps?: (props: { selection: typeof selection }) => void
    } | null
  )?.setNativeProps?.({ selection })
}
