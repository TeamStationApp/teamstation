/**
 * A moment of silence. A browser such as iPhone Safari lets an audio element
 * play later only once it has played inside a tap, so the replay's players
 * play this on their elements in the volume button's tap.
 */
export const SILENCE =
  'data:audio/wav;base64,UklGRiQAAABXQVZFZm10IBAAAAABAAEAQB8AAEAfAAABAAgAZGF0YQAAAAA='

/**
 * Plays, or does not: a browser may refuse sound before a tap, or have no
 * audio at all, and either way the replay goes on silent.
 */
export function start(audio: HTMLAudioElement): void {
  try {
    ;(audio.play() as Promise<void> | undefined)?.catch(() => undefined)
  } catch {
    // Nothing to play with.
  }
}
