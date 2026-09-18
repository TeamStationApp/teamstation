/**
 * Where the video goes, and where the highlights go.
 *
 * YouTube's numbers, because they are the product of more measurement than we
 * will ever do ourselves: one column under about a thousand pixels, and beyond
 * that a fixed column on the right with the video taking what is left.
 */

/** Two columns from here up. YouTube's own threshold. */
export const TWO_COLUMN_MIN = 1000
/** And back to one only below here, so dragging a window does not flap. */
export const TWO_COLUMN_EXIT = 960
/** YouTube's secondary column. */
export const SIDE_WIDTH = 402
/** What it may shrink to before the video gets uncomfortably narrow. */
export const SIDE_MIN = 300
export const GUTTER = 24
export const PAGE_MARGIN = 24
/**
 * The margin either side of a stacked picture.
 *
 * A pixel less than the 14 the card and the highlight rows use, so the picture
 * sits a hair wider than the things above and below it and covers them as they
 * pass underneath — a margin, not an edge-to-edge bleed.
 */
export const PHONE_MARGIN = 13
/** Where YouTube stops growing a player, and so do we. */
export const MAX_VIDEO_WIDTH = 1280

export type WatchMode = 'stacked' | 'sideBySide'

export interface WatchLayoutInput {
  width: number
  height: number
  /** The header, and anything else above the video that does not scroll. */
  chromeHeight: number
  /** `videoWidth / videoHeight`, from the file. 16/9 until it is known. */
  aspect: number
  previous: WatchMode
}

export interface WatchLayout {
  mode: WatchMode
  videoWidth: number
  videoHeight: number
  sideWidth: number
}

/**
 * The one honest wrinkle, and it is YouTube's too: at the crossover the picture
 * gets *smaller*, because the column on the right has to come from somewhere.
 * Moving the threshold only moves the step.
 */
export function watchLayout(input: WatchLayoutInput): WatchLayout {
  const { width, height, chromeHeight, aspect, previous } = input
  const mode: WatchMode =
    width >= TWO_COLUMN_MIN
      ? 'sideBySide'
      : width < TWO_COLUMN_EXIT
        ? 'stacked'
        : previous

  // The column takes what is left once the video has its floor, and never more
  // than YouTube's 402 or less than 300. Below that the video is the thing that
  // suffers, and the video is what the screen is for.
  const MIN_VIDEO_WIDTH = 600
  const sideWidth =
    mode === 'stacked'
      ? 0
      : Math.max(
          SIDE_MIN,
          Math.min(
            SIDE_WIDTH,
            width - 2 * PAGE_MARGIN - GUTTER - MIN_VIDEO_WIDTH
          )
        )

  // Stacked, the picture is edge to edge, the way a phone shows one
  // everywhere else: a margin either side leaves a sliver of the highlight
  // list showing past the pegged video, which reads as a mistake rather than
  // as a margin.
  const available =
    mode === 'sideBySide'
      ? width - 2 * PAGE_MARGIN - sideWidth - GUTTER
      : width - 2 * PHONE_MARGIN

  let videoWidth = Math.min(Math.max(240, available), MAX_VIDEO_WIDTH)
  let videoHeight = videoWidth / aspect

  // The one limit on growth: a picture taller than the room under the header
  // cannot be watched without scrolling, and cannot be pegged there either.
  // When it binds, the box narrows and keeps the file's own shape — the page's
  // background shows either side of it, which is not a black bar inside the
  // picture.
  const maxHeight = Math.max(150, height - chromeHeight)
  if (videoHeight > maxHeight) {
    videoHeight = maxHeight
    videoWidth = maxHeight * aspect
  }

  return {
    mode,
    videoWidth: Math.round(videoWidth),
    videoHeight: Math.round(videoHeight),
    sideWidth: Math.round(sideWidth)
  }
}
