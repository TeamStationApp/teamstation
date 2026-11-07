import type { RecapClip } from '../../common/gameRecap'
import { leadFor, toOffset } from '../highlights'
import type { HighlightSettings } from '../settings'

export interface RecapEvent {
  atBatIndex: number
  endTime: Date | null
  startTime: Date | null
  eventType: string | null
  timeNudgeSec: number
  isScoringPlay: boolean | null
  hidden: boolean
}
export interface RecapVideo {
  id: string
  start_at: Date | null
  sync_offset_sec: number
  duration_sec: number | null
}

/** Uses highlight's corrected tap and lead, with recap's next-scoring-play end. */
export function recapClips(
  events: RecapEvent[],
  videos: RecapVideo[],
  settings: HighlightSettings
): Record<string, RecapClip> {
  const ordered = [...events].sort((a, b) => a.atBatIndex - b.atBatIndex)
  const at = (e: RecapEvent): number | null => {
    const tap = e.endTime ?? e.startTime
    return tap == null
      ? null
      : new Date(tap).getTime() / 1000 + e.timeNudgeSec - settings.lagSec
  }
  const out: Record<string, RecapClip> = {}
  for (let i = 0; i < ordered.length; i++) {
    const event = ordered[i]
    const play = at(event)
    if (event.hidden || play == null) continue
    const next = ordered
      .slice(i + 1)
      .find(e => e.isScoringPlay === true && at(e) != null)
    const end = next == null ? play + 12 : at(next)! - 5
    for (const video of videos) {
      if (
        video.start_at == null ||
        video.duration_sec == null ||
        video.duration_sec <= 0
      )
        continue
      const offset = (time: number): number =>
        toOffset(
          time * 1000,
          new Date(video.start_at!).getTime(),
          video.sync_offset_sec
        )
      const moment = offset(play)
      const start = Math.max(
        0,
        offset(play - leadFor(event.eventType, settings))
      )
      const stop = Math.min(video.duration_sec, offset(end))
      if (moment < 0 || moment > video.duration_sec || stop <= start) continue
      out[String(event.atBatIndex)] = { videoId: video.id, start, end: stop }
      break
    }
  }
  return out
}
