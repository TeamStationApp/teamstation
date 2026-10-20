/**
 * A rectangle, and which player engine draws the picture: shared by the
 * scoreboard's layouts and the full-screen player's support rules.
 *
 * This file used to measure where each engine's own controls sat over the
 * picture, so a tap layer could cut holes for them. The videos page's picture
 * no longer shows a player's controls at all, and the full-screen player draws
 * its own bar, so nothing is measured here any more.
 */

export interface Rect {
  x: number
  y: number
  w: number
  h: number
}

export type Engine = 'chrome' | 'webkit' | 'avplayer' | 'exoplayer' | 'unknown'

export function engineOf(userAgent: string): Engine {
  if (/Chrom(e|ium)|Edg\//.test(userAgent)) return 'chrome'
  if (userAgent.includes('Safari') && !/Chrom(e|ium)/.test(userAgent)) {
    return 'webkit'
  }
  return 'unknown'
}
