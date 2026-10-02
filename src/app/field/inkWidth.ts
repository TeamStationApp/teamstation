import { fonts } from '../theme/fonts'
import { estimateInkWidth } from './inkEstimate'

let inkContext: CanvasRenderingContext2D | null = null

/**
 * How wide a line of nameplate text sets, in CSS pixels.
 *
 * A browser measures it on a canvas. Under Node, in the tests, there is no
 * canvas, so it is estimated from the font size.
 */
export function inkWidth(text: string, fontPx: number): number {
  if (text === '') return 0
  if (inkContext == null && typeof document !== 'undefined') {
    inkContext = document.createElement('canvas').getContext('2d')
  }
  if (inkContext != null) {
    inkContext.font = `400 ${fontPx}px ${fonts.spaceGrotesk}`
    return Math.ceil(inkContext.measureText(text).width)
  }
  return estimateInkWidth(text, fontPx)
}
