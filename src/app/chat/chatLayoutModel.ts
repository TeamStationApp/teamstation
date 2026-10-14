export interface ChatLayoutInput {
  header: number
  paneHeader: number
  pins: number
  composer: number
  navigation: number
  navigationBottom: number
  safeBottom: number
  keyboardOpen: boolean
  keyboardOverlap: number
  gap: number
}

const positive = (value: number): number =>
  Number.isFinite(value) ? Math.max(0, value) : 0

/** The scroll frame fills the pane; only its content clears the overlays. */
export function chatLayout(input: ChatLayoutInput): {
  readableTop: number
  contentTop: number
  composerBottom: number
  contentBottom: number
} {
  const gap = positive(input.gap)
  const readableTop =
    positive(input.header) + positive(input.paneHeader) + positive(input.pins)
  const composerBottom = input.keyboardOpen
    ? positive(input.keyboardOverlap) + gap / 2
    : positive(input.navigation) > 0
      ? positive(input.navigationBottom) + positive(input.navigation) + gap
      : positive(input.safeBottom) + gap
  return {
    readableTop,
    contentTop: readableTop + gap,
    composerBottom,
    contentBottom: composerBottom + positive(input.composer) + gap
  }
}

/** A resized Android frame already clears the keyboard; iOS may be covered. */
export function keyboardOverlap(
  frameBottom: number,
  keyboardTop: number | undefined
): number {
  return keyboardTop == null ? 0 : positive(frameBottom - keyboardTop)
}

/** Only a newly covering top band may move a previously readable row edge. */
export function anchorAfterChromeChange(
  relativeY: number,
  previousTop: number,
  nextTop: number,
  gap: number
): number {
  return nextTop > previousTop &&
    relativeY >= previousTop &&
    relativeY < nextTop
    ? nextTop + positive(gap)
    : relativeY
}
