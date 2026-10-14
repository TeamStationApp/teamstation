import type { LoadedChatPicture } from './AttachmentView'
import type { ChatBounds } from './chatInteractionModel'

export interface MessageSource {
  bounds: ChatBounds
  measure: (accept: (bounds: ChatBounds | undefined) => void) => () => void
  pictures?: () => ReadonlyMap<string, LoadedChatPicture> | undefined
}

export interface MessageMeasurer {
  measureInWindow: (
    accept: (x: number, y: number, width: number, height: number) => void
  ) => void
}

/** A detached, cancelled or unmeasurable source can only produce a fade. */
export function captureMessageBounds(
  node: MessageMeasurer | null,
  valid: () => boolean,
  accept: (bounds: ChatBounds | undefined) => void
): () => void {
  let active = true
  const finish = (bounds?: ChatBounds): void => {
    if (!active) return
    active = false
    clearTimeout(timeout)
    accept(valid() ? bounds : undefined)
  }
  const timeout = setTimeout(() => {
    finish()
  }, 80)
  if (node == null) finish()
  else
    node.measureInWindow((x, y, width, height) => {
      finish(
        [x, y, width, height].every(Number.isFinite) && width > 0 && height > 0
          ? { x, y, width, height }
          : undefined
      )
    })
  return () => {
    active = false
    clearTimeout(timeout)
  }
}
