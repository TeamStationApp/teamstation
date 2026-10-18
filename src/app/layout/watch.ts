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
/**
 * The narrowest picture worth giving two columns to.
 *
 * Below this the side-by-side arrangement is costing the picture more than
 * the list is gaining, and the window is better off stacked.
 */
export const MIN_SHORT_VIDEO = 320
/**
 * The least room worth drawing the score card in.
 *
 * Below this the card would be squeezed to nothing, so its contents go into
 * the column beside the picture instead. It is what separates a phone on its
 * side from a laptop, which a comparison of widths cannot do.
 */
export const CARD_MIN_HEIGHT = 120
/**
 * The tallest window that can be "short" at all.
 *
 * Measured under the chrome. A phone on its side has about 340 points there;
 * a laptop at 1366x768 has 696. Without this the card-room test alone hid the
 * score card on two of the commonest laptop resolutions, because at that size
 * a full-width picture really does leave little room above it — the window is
 * not short, the *picture* is greedy, and the answer is to shrink the picture
 * rather than to drop the card.
 *
 * It also stops a header of an unexpected height deciding the layout, which
 * the card-room test alone did not: that turned on 14 points, and a header
 * measuring 72 rather than the 48 a test assumed was enough to hide the card
 * on two of the commonest laptop resolutions.
 *
 * **Do not read 500 as headroom.** Against a *phone* it is enormous — 340
 * against 500 — but the gate turns between a 540-tall window and a 560-tall
 * one, and half of a 1080 monitor is 540. So against something somebody
 * actually does the margin is ten or twenty points. Both sides of that
 * boundary are sensible, which is why it is left alone; it is not slack to
 * spend.
 */
export const SHORT_WINDOW_MAX = 500
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
  /** Chrome without controls that are shown only after choosing short mode. */
  shortChromeHeight?: number
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
    shortChromeHeight = chromeHeight,
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
  //
  // **`short` means there is no room for a card above the picture.** Say that,
  // rather than comparing widths and hoping it follows.
  //
  // Two earlier versions compared widths. The first asked whether the picture
  // at its full height-bound width would fit beside a column, which said no
  // on a phone that had room to spare once the picture was allowed to shrink.
  // The second asked whether `heightBound < stackedWidth` — but that is true
  // of *every* 16:9 and 16:10 window, because it is the definition of one. It
  // is not "a phone on its side", and it took the score card off every common
  // laptop: gone at 1366x768 and 1920x1080, drawn at 1920x1200, with the
  // two-column arrangement otherwise byte-identical either side of the flip.
  // The slack in the first version had been doing that work by accident.
  //
  // So: work out the picture this window would actually get side by side,
  // and ask what is left above it.
  //
  // The column's floor keys off the **width**, not off `short`. A list has to
  // be 300 wide to be worth reading on a desktop and may go to 260 on a phone
  // that has not got 300 to give; tying that to `short` handed the phone's
  // floor to any desktop window that happened to be short, and a 1366-wide
  // laptop was showing a 260-point list.
  const sideFloor = width >= TWO_COLUMN_MIN ? SIDE_MIN : SIDE_MIN_SHORT

  const splitVideoWidth = Math.min(
    row - sideFloor,
    Math.max(MIN_VIDEO_HEIGHT, height - shortChromeHeight - belowVideo) *
      aspect,
    MAX_VIDEO_WIDTH
  )
  const roomForCard =
    height - shortChromeHeight - belowVideo - splitVideoWidth / aspect

  const short =
    // A window that is actually short. Without this the test below fires on a
    // laptop, where a full-width picture genuinely does crowd the card — but
    // there the right answer is to shrink the picture, not drop the card.
    height - shortChromeHeight <= SHORT_WINDOW_MAX &&
    // Nowhere to put the card, so the card's contents move into the column.
    roomForCard < CARD_MIN_HEIGHT &&
    // And what is left is still a picture worth giving two columns to.
    splitVideoWidth >= MIN_SHORT_VIDEO

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
            sideFloor,
            Math.min(
              SIDE_WIDTH,
              row - Math.min(heightBound, MAX_VIDEO_WIDTH, row - sideFloor)
            )
          )
        : Math.max(sideFloor, Math.min(SIDE_WIDTH, row - MIN_VIDEO_WIDTH))

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
