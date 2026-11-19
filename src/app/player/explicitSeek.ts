import type { SeekKind } from '../../common/observability/contract'
import { markSeek } from './playbackSession'

/**
 * Explicit viewer seeks take precedence over anything the player was about to
 * do with the position by itself: a pending initial live join, or putting a
 * reloaded stream back where it was. Several of those can wait on one player.
 */
const listeners = new WeakMap<object, Set<() => void>>()

export function onExplicitSeek(
  video: object,
  listener: () => void
): () => void {
  const held = listeners.get(video) ?? new Set<() => void>()
  held.add(listener)
  listeners.set(video, held)
  return () => {
    held.delete(listener)
  }
}

/**
 * Shared by highlight selection and the player's seek gestures. `kind` is the
 * reason the playback telemetry gives the seek; `replace: false` keeps one a
 * caller already gave, a jump to live going through the scrub's seeks.
 */
export function seekTo(
  video: { currentTime: number },
  seconds: number,
  kind: SeekKind = 'other',
  replace = kind !== 'other'
): void {
  markSeek(video, kind, replace)
  listeners.get(video)?.forEach(listener => {
    listener()
  })
  video.currentTime = seconds
}
