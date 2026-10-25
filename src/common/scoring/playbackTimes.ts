import { storedRecordOf } from './gumbo'

/** Only historical board playback uses the session's historical clock. */
export function forPlayback<T>(play: T): T {
  const times = storedRecordOf(play)?.playbackTimes
  if (times == null) return play
  const copy = structuredClone(play) as Record<string, any>
  copy.teamStation.actionTimes = times
  return copy as T
}
