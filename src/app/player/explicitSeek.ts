/** Explicit viewer seeks take precedence over a pending initial live join. */
const listeners = new WeakMap<object, () => void>()

export function onExplicitSeek(
  video: object,
  listener: () => void
): () => void {
  listeners.set(video, listener)
  return () => {
    listeners.delete(video)
  }
}

/** Shared by highlight selection and the player's seek gestures. */
export function seekTo(video: { currentTime: number }, seconds: number): void {
  listeners.get(video)?.()
  video.currentTime = seconds
}
