import { type Engine, engineOf } from './controlGeometry'

/**
 * Whose control bar is on top of the picture.
 *
 * The gesture layer has holes cut in it where the player's own controls are,
 * and where those are depends on who drew them. In a browser that is the
 * engine, read from the user agent; on a phone it is the platform, and
 * `engine.native.ts` answers accordingly.
 */
export function playerEngine(): Engine {
  return engineOf(typeof navigator === 'undefined' ? '' : navigator.userAgent)
}
