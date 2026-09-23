import type { HighlightSettings } from './settings'

/**
 * Highlights are never stored. They are worked out from the plays and the
 * current settings every time they are read, so a corrected lag, a nudged play
 * or a re-synced video fixes every highlight at once and nothing goes stale.
 *
 * A highlight is a **timestamp into the full video**, not a clip. The player
 * seeks there and keeps playing.
 */
/** One thing somebody did well, as stored on the event by the ingest. */
export interface CreditedOutcome {
  eventType: string
  /** `Single: Jordan P`. */
  label: string
  credit: {
    name: string
    role: string
    position: string | null
  } | null
  /** Which of our teams the credit belongs to, or null for an unknown one. */
  teamId: string | null
  /** Who did it, when the sender knew them as one of our users. */
  creditUserId: number | null
}

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
  /**
   * A play yields one or more.
   *
   * `undefined` and `[]` are **not** the same thing, and the difference
   * decides whether a highlight is shown. `[]` means the engine looked and
   * nobody did anything worth watching — an error, a wild pitch — so there is
   * nothing to show. `undefined` means nobody has looked yet, which is every
   * game ingested before credits existed: those keep their old wording rather
   * than disappearing from the app until somebody re-runs an import.
   */
  credits?: CreditedOutcome[]
}

/** Teams we would not show a highlight for: an opponent nobody runs. */
export interface TeamStanding {
  /** Invented from a name on somebody else's schedule. */
  isExternal: boolean
  /** Somebody in our records owns or manages it. */
  hasOwner: boolean
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
  /**
   * When the play happened, by the clock on the wall.
   *
   * The corrected moment, not the scorekeeper's tap: the same arithmetic the
   * offsets above are worked out from. A player's own page prints this beside
   * the highlight, and printing it from the raw tap would put a time on the
   * screen a second or two adrift from the frame the video seeks to.
   */
  playAt: Date
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
  settings: HighlightSettings,
  teams = new Map<string, TeamStanding>()
): Highlight[] {
  return withDropped(events, video, settings, teams).highlights
}

/**
 * The same, and how many plays were left out because nobody could be named.
 *
 * `No highlights` and `no highlights we can name` are different things, and a
 * game against an opponent we know nothing about looks broken without the
 * distinction.
 */
export function withDropped(
  events: HighlightEvent[],
  video: HighlightVideo,
  settings: HighlightSettings,
  teams = new Map<string, TeamStanding>()
): { highlights: Highlight[]; dropped: number } {
  let dropped = 0
  if (video.startAt == null) return { highlights: [], dropped }
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

    // A play yields one or more credited outcomes, and they are grouped back
    // together when they were logged close enough to be one moment: a walk
    // that forces a runner home is one tap, or two within a second, and two
    // rows there is two thumbnails of the same piece of video.
    const credited = event.credits
    const shown =
      credited == null
        ? []
        : credited.filter(outcome => worthShowing(outcome, teams))
    // Nobody to name, on a play somebody has looked at. Not shown.
    if (credited != null && shown.length === 0 && event.titleOverride == null) {
      if (credited.length > 0) dropped += 1
      continue
    }

    const label =
      event.titleOverride ??
      (shown.length === 0 ? titleFor(event) : joinOutcomes(shown))

    highlights.push({
      eventId: event.id,
      atBatIndex: event.atBatIndex,
      title: label,
      playAt: new Date(playMs),
      description: event.description,
      startOffsetSec: Math.max(0, startOffsetSec),
      playOffsetSec,
      eventType: event.eventType,
      isScoringPlay:
        event.isScoringPlay || shown.some(o => o.eventType === 'run')
    })
  }

  highlights.sort((a, b) => a.atBatIndex - b.atBatIndex)
  return { highlights, dropped }
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

/**
 * Whether a credited outcome is worth putting in front of somebody.
 *
 * Two reasons not to. **Nobody to name**: if we cannot say who did it, a row
 * saying `Ground out` is a thumbnail with no reason to press it. And **an
 * opponent nobody runs**: a team invented from a name typed into somebody
 * else's schedule, which nobody has claimed. Both of those at once — a real
 * team in the league is shown whether or not anybody has been recorded as
 * running it.
 */
function worthShowing(
  outcome: CreditedOutcome,
  teams: Map<string, TeamStanding>
): boolean {
  const name = outcome.credit?.name ?? ''
  if (name === '') return false
  if (outcome.teamId == null) return true
  const standing = teams.get(outcome.teamId)
  if (standing == null) return true
  // Both conditions, not either. A team that plays in the league is shown
  // whether or not anybody has been recorded as running it — and on real data
  // nobody has, so `external || !hasOwner` dropped every highlight in the app.
  return !(standing.isExternal && !standing.hasOwner)
}

/**
 * The outcomes of one play, as one line.
 *
 * A player already named by an earlier part is not named again: a home run
 * puts the batter across the plate, so without this it reads
 * `Home run: Hunter P · Run: Hunter P`.
 */
function joinOutcomes(outcomes: CreditedOutcome[]): string {
  const seen = new Set<string>()
  const parts: string[] = []
  for (const outcome of outcomes) {
    const name = outcome.credit?.name ?? ''
    if (outcome.eventType === 'run' && seen.has(name)) continue
    seen.add(name)
    parts.push(outcome.label)
  }
  return parts.join(' · ')
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
