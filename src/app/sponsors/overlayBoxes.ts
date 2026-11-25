// Where a sponsor's picture is drawn over the sample video, as fractions of
// the video's frame: `x` and `y` from its upper-left corner, `width` and
// `height` of its size.
import { defaultScoreboardSettings } from '../../common/nodeSettings'

export interface OverlayBox {
  x: number
  y: number
  width: number
  height: number
}

/** The sample video's frame: 16:9, as every recording is shown. */
export const VIDEO_ASPECT = 16 / 9

/** The margin above a logo, of the frame's height, and to its right, of its width. */
export const LOGO_MARGIN = 0.05
/** The largest share of the frame's width, and of its height, a logo takes. */
export const LOGO_MAX = 0.25

/**
 * A logo in the frame's upper-right corner: 5% of the height above it and
 * 5% of the width to its right, as large as fits in a quarter of the width
 * and a quarter of the height, its own proportions kept.
 */
export function logoBox(
  image: { width: number; height: number },
  aspect = VIDEO_ASPECT
): OverlayBox {
  // In units of the frame's height: the frame is `aspect` wide and 1 high.
  const widest = LOGO_MAX * aspect
  const tallest = LOGO_MAX
  const ratio =
    image.width > 0 && image.height > 0 ? image.width / image.height : 1
  const height = Math.min(tallest, widest / ratio)
  const width = height * ratio
  return {
    x: 1 - LOGO_MARGIN - width / aspect,
    y: LOGO_MARGIN,
    width: width / aspect,
    height
  }
}

/**
 * A reel in the scoreboard's place over a single landscape camera, a third
 * of the frame each way: 640 × 360 of a 1080p picture.
 */
export function reelBox(): OverlayBox {
  const { x, y } = defaultScoreboardSettings.single
  return { x, y, width: 1 / 3, height: 1 / 3 }
}
