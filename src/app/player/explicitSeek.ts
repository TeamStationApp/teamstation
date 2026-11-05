/**
 * Explicit viewer seeks take precedence over anything the player was about to
 * do with the position by itself: a pending initial live join, or putting a
 * reloaded stream back where it was. Several of those can wait on one player.
 */
const listeners = new WeakMap<object, Set<(seconds: number) => void>>()

export function onExplicitSeek(
  video: object,
  listener: (seconds: number) => void
): () => void {
  const held = listeners.get(video) ?? new Set<() => void>()
  held.add(listener)
  listeners.set(video, held)
  return () => {
    held.delete(listener)
  }
}

/** Shared by highlight selection and the player's seek gestures. */
export function seekTo(video: { currentTime: number }, seconds: number): void {
  listeners.get(video)?.forEach(listener => {
    listener(seconds)
  })
  video.currentTime = seconds
}
