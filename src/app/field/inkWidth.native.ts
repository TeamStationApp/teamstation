import { estimateInkWidth } from './inkEstimate'

/**
 * How wide a line of nameplate text sets, in points.
 *
 * A phone has no canvas to measure on, so it is estimated from the font size.
 */
export const inkWidth = estimateInkWidth
