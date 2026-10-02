import type { Engine } from '../controlGeometry'

/**
 * Whether the multi-camera grid is offered on this player.
 *
 * Not in Safari's engine — Safari on a Mac, and every browser on an iPhone or
 * iPad, which all run it. There four tiles at once flash black and stutter,
 * and until that is understood the angles are offered one at a time: "All
 * angles" says the grid is unavailable and where to find it, and a link that
 * names angles opens the single player. Every other browser and both apps
 * keep the grid.
 */
export function multiAngleSupported(engine: Engine): boolean {
  return engine !== 'webkit'
}
