import { Platform } from 'react-native'

import type { Engine } from './controlGeometry'

/**
 * Whose control bar is on top of the picture.
 *
 * Not the browser engine here but the platform's own player: AVPlayer on iOS
 * draws the same control bar Safari does, because Safari's *is* AVPlayer's,
 * and ExoPlayer draws Android's.
 */
export function playerEngine(): Engine {
  return Platform.OS === 'ios' ? 'avplayer' : 'exoplayer'
}
