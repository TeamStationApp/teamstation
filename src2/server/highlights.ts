import type { HighlightSettings } from './settings'

/**
 * Highlights are never stored. They are worked out from the plays and the
 * current settings every time they are read, so a corrected lag, a nudged play
 * or a re-synced video fixes every highlight at once and nothing goes stale.
 *
 * A highlight is a **timestamp into the full video**, not a clip. The player
 * seeks there and keeps playing.
 */
export interface HighlightEvent {
  id: string
  atBatIndex: number
  /** The scorekeeper's tap time. The play itself happened before this. */
  startTime: Date | null
  eventType: string | null
  description: string | null
  titleOverride: string | null
  timeNudgeSec: number
  hidden: boolean
  isScoringPlay: boolean
}

export interface HighlightVideo {
  startAt: Date | null
  syncOffsetSec: number
  durationSec: number | null
}

export interface Highlight {
  eventId: string
  atBatIndex: number
  title: string
  /** The whole sentence, for the panel under the video. */
  description: string | null
  /** Where the player should seek to, in seconds from the video's start. */
  startOffsetSec: number
  /** Where the play itself is, for a still or a marker. */
  playOffsetSec: number
  eventType: string | null
  isScoringPlay: boolean
}

/**
 * Turns plays into seek points in one video.
 *
 * The timing, in order:
 *
 * 1. The stored time is when the scorekeeper **tapped**, which is `lagSec`
 *    after the play. Subtract the lag to find the play.
 * 2. `timeNudgeSec` corrects one play whose tap was plainly wrong. It is a
 *    per-play correction, not a second lead setting.
 * 3. Back up by the lead for that event type, so the viewer sees the wind-up
 *    rather than landing on the contact.
 * 4. Convert to an offset in this video, allowing for the video's own clock
 *    correction.
 *
 * Plays are returned in game order, oldest first, which is how a game is read.
 */
export function computeHighlights(
  events: HighlightEvent[],
  video: HighlightVideo,
  settings: HighlightSettings
): Highlight[] {
  if (video.startAt == null) return []
  const videoStartMs = video.startAt.getTime()

  const highlights: Highlight[] = []
  for (const event of events) {
    if (event.hidden) continue
    if (event.startTime == null) continue

    const tapMs = event.startTime.getTime() + event.timeNudgeSec * 1000
    const playMs = tapMs - settings.lagSec * 1000
    const lead = leadFor(event.eventType, settings)
    const startMs = playMs - lead * 1000

    const playOffsetSec = toOffset(playMs, videoStartMs, video.syncOffsetSec)
    const startOffsetSec = toOffset(startMs, videoStartMs, video.syncOffsetSec)

    // A play before the recording started, or after it stopped, is not in this
    // video. That is normal for a game recorded in two parts.
    if (playOffsetSec < 0) continue
    if (video.durationSec != null && playOffsetSec > video.durationSec) continue

    highlights.push({
      eventId: event.id,
      atBatIndex: event.atBatIndex,
      title: titleFor(event),
      description: event.description,
      startOffsetSec: Math.max(0, startOffsetSec),
      playOffsetSec,
      eventType: event.eventType,
      isScoringPlay: event.isScoringPlay
    })
  }

  highlights.sort((a, b) => a.atBatIndex - b.atBatIndex)
  return highlights
}

export function leadFor(
  eventType: string | null,
  settings: HighlightSettings
): number {
  if (eventType == null) return settings.leadSec
  const specific = settings.leadSecByEventType[eventType]
  return typeof specific === 'number' && Number.isFinite(specific)
    ? specific
    : settings.leadSec
}

function toOffset(
  atMs: number,
  videoStartMs: number,
  syncOffsetSec: number
): number {
  return Math.round(((atMs - videoStartMs) / 1000 + syncOffsetSec) * 10) / 10
}

function titleFor(event: HighlightEvent): string {
  if (event.titleOverride != null && event.titleOverride !== '') {
    return event.titleOverride
  }
  if (event.description != null && event.description !== '') {
    return event.description
  }
  return event.eventType ?? 'Play'
}
