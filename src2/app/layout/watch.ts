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
/**
 * What it may shrink to on a window that is short rather than wide.
 *
 * `SIDE_MIN` is the floor on a desktop, where the only thing a narrower list
 * buys is a wider video. A phone turned on its side has no such trade: the
 * picture is as big as the height lets it be whatever the list does, so the
 * list takes what is left — and on a 667pt phone that is less than 300.
 */
export const SIDE_MIN_SHORT = 260
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
/** Below this a picture is not worth pegging, whatever the window is doing. */
export const MIN_VIDEO_HEIGHT = 150

export type WatchMode = 'stacked' | 'sideBySide'

export interface WatchLayoutInput {
  width: number
  height: number
  /** The header the picture pegs under, and anything else above it. */
  chromeHeight: number
  /**
   * What is pegged under the picture and has to stay on the screen with it —
   * the row of camera-angle buttons. The picture gives up the height rather
   * than pushing them off the bottom.
   */
  belowVideo?: number
  /** `videoWidth / videoHeight`, from the file. 16/9 until it is known. */
  aspect: number
  previous: WatchMode
}

export interface WatchLayout {
  mode: WatchMode
  videoWidth: number
  videoHeight: number
  sideWidth: number
  /**
   * The window is short rather than wide: the height decides the picture and
   * there is no room under it. A description belongs in the scrolling column
   * on such a window, because pegged under the picture it is simply off the
   * bottom of the screen.
   */
  short: boolean
}

/**
 * The one honest wrinkle, and it is YouTube's too: at the crossover the picture
 * gets *smaller*, because the column on the right has to come from somewhere.
 * Moving the threshold only moves the step.
 */
export function watchLayout(input: WatchLayoutInput): WatchLayout {
  const {
    width,
    height,
    chromeHeight,
    belowVideo = 0,
    aspect,
    previous
  } = input

  // How tall the picture may be and still leave its buttons on the screen,
  // and the width that height allows it.
  const maxHeight = Math.max(
    MIN_VIDEO_HEIGHT,
    height - chromeHeight - belowVideo
  )
  const heightBound = maxHeight * aspect
  /** The width a stacked picture would take: the window, less its margins. */
  const stackedWidth = width - 2 * PHONE_MARGIN
  /** The width the picture and the list share when they share a line. */
  const row = width - 2 * PAGE_MARGIN - GUTTER

  /**
   * A phone on its side, and the reason width alone cannot decide this.
   *
   * Stacked, the picture is as wide as the window; turned sideways a phone has
   * no height to give it, so the picture shrinks to keep its shape and leaves a
   * strip of empty page either side — with the highlight list, which is the
   * full width of the window, showing past both edges of the thing pegged over
   * it. Whenever that strip is wide enough to hold a column, the highlights go
   * in it instead and the picture moves to the left, which is the same two
   * columns a desktop gets and for the same reason.
   */
  const short = heightBound + GUTTER + SIDE_MIN_SHORT <= stackedWidth

  const mode: WatchMode = short
    ? 'sideBySide'
    : width >= TWO_COLUMN_MIN
      ? 'sideBySide'
      : width < TWO_COLUMN_EXIT
        ? 'stacked'
        : previous

  // The column takes what is left once the video has its floor, and never more
  // than YouTube's 402 or less than 300. Below that the video is the thing that
  // suffers, and the video is what the screen is for.
  //
  // Short, that trade does not exist — the height has already settled how wide
  // the picture is — so the list simply takes the rest of the row.
  const MIN_VIDEO_WIDTH = 600
  const sideWidth =
    mode === 'stacked'
      ? 0
      : short
        ? Math.max(
            SIDE_MIN_SHORT,
            Math.min(
              SIDE_WIDTH,
              row - Math.min(heightBound, MAX_VIDEO_WIDTH, row - SIDE_MIN_SHORT)
            )
          )
        : Math.max(SIDE_MIN, Math.min(SIDE_WIDTH, row - MIN_VIDEO_WIDTH))

  // Stacked, the picture is edge to edge, the way a phone shows one
  // everywhere else: a margin either side leaves a sliver of the highlight
  // list showing past the pegged video, which reads as a mistake rather than
  // as a margin.
  const available = mode === 'sideBySide' ? row - sideWidth : stackedWidth

  let videoWidth = Math.min(Math.max(240, available), MAX_VIDEO_WIDTH)
  let videoHeight = videoWidth / aspect

  // The one limit on growth: a picture taller than the room under the header
  // cannot be watched without scrolling, and cannot be pegged there either.
  // When it binds, the box narrows and keeps the file's own shape — the page's
  // background shows either side of it, which is not a black bar inside the
  // picture.
  if (videoHeight > maxHeight) {
    videoHeight = maxHeight
    videoWidth = maxHeight * aspect
  }

  return {
    mode,
    videoWidth: Math.round(videoWidth),
    videoHeight: Math.round(videoHeight),
    sideWidth: Math.round(sideWidth),
    short
  }
}
