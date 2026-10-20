/** A steady reading pace, with time to read both ends before the next pass. */
export function undoTickerTiming(
  width: number,
  contentWidth: number
):
  | {
      distance: number
      duration: number
      startPause: number
      endPause: number
    }
  | undefined {
  if (
    !Number.isFinite(width) ||
    !Number.isFinite(contentWidth) ||
    width <= 0 ||
    contentWidth <= width + 1
  )
    return undefined
  const distance = contentWidth - width
  return {
    distance,
    duration: (distance / 24) * 1000,
    startPause: 1000,
    endPause: 2000
  }
}
