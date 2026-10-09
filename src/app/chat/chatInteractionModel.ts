export interface ChatBounds {
  x: number
  y: number
  width: number
  height: number
}

/** Keep a popup in the viewport, preferring the space below its trigger. */
export function menuPosition(
  anchor: ChatBounds,
  panel: { width: number; height: number },
  viewport: { width: number; height: number }
): { left: number; top: number } {
  const margin = 8
  const left = Math.max(
    margin,
    Math.min(
      anchor.x + anchor.width - panel.width,
      viewport.width - panel.width - margin
    )
  )
  const below = anchor.y + anchor.height + margin
  const top =
    below + panel.height <= viewport.height - margin
      ? below
      : anchor.y - panel.height - margin
  return {
    left,
    top: Math.max(
      margin,
      Math.min(top, viewport.height - panel.height - margin)
    )
  }
}
