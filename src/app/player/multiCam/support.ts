import type { Engine } from '../controlGeometry'

/**
 * Whether the full-screen player is offered for `count` angles here.
 *
 * One angle everywhere: it is the player the videos page opens. More than one
 * not in Safari's engine — Safari on a Mac, and every browser on an iPhone or
 * iPad, which all run it. There several tiles at once flash black and
 * stutter, and until that is understood "All angles" says the grid is
 * unavailable and where to find it, and a link that names several angles
 * opens the single player. Every other browser and both apps keep the grid.
 */
export function multiAngleSupported(engine: Engine, count: number): boolean {
  return count <= 1 || engine !== 'webkit'
}
