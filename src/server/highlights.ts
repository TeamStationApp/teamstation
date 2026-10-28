import type { Selectable } from 'kysely'

import { describePlay } from '../common/describePlay'
import { completedPlayTag, type TagDocument } from '../common/eventTags'
import { eventTypeName } from '../common/gumboEventTypes'
import { creditLabel, type NameOf } from '../common/scoring/storedNames'
import type { EventsTable } from './db/database'
import type { HighlightSettings } from './settings'

/**
 * Highlights are never stored. They are worked out from the plays and the
 * current settings every time they are read, so a corrected lag, a nudged play
 * or a re-synced video fixes every highlight at once and nothing goes stale.
 *
 * A highlight is a **timestamp into the full video**, not a clip. The player
 * seeks there and keeps playing.
 */
/**
 * One thing somebody did well, as `"eventCredits"` holds it: the structure
 * its label is worded from (`creditLabel`), and nobody's name but a typed
 * one, for a person with no id.
 */
export interface CreditedOutcome {
  eventType: string
  /** The label's first words, `Ground out`. */
  head: string
  /** Words after the person and position, ` pitching`. */
  suffix: string | null
  /** The fielders who assisted, by id, or by typed name with none. */
  assists: Array<{
    creditUserId: number | null
    position: string | null
    name?: string
  }>
  /** `from A (SS), B (2B)`, or an outside scorer's `to A (1B) to B (2B)`. */
  assistWord: 'from' | 'to' | null
  credit: {
    /** The typed name of a person with no id; an id's is read from users. */
    name?: string
    role: string
    position: string | null
  } | null
  /** Which of our teams the credit belongs to, or null for an unknown one. */
  teamId: string | null
  /** Who did it, when the sender knew them as one of our users. */
  creditUserId: number | null
}

/** A credited outcome as a highlight shows it: worded, with its names. */
export interface NamedOutcome {
  eventType: string
  /** `Single: Jordan P`. */
  label: string
  credit: { name: string; role: string; position: string | null } | null
  teamId: string | null
  creditUserId: number | null
}

/**
 * A credit named from a name book: its label worded from its structure, and
 * its person's name, by id or as typed.
 */
export function namedOutcome(
  outcome: CreditedOutcome,
  nameOf: NameOf
): NamedOutcome {
  const typed = outcome.credit?.name
  const name =
    outcome.creditUserId == null
      ? (typed ?? '')
      : (nameOf(outcome.creditUserId) ?? '')
  return {
    eventType: outcome.eventType,
    label: creditLabel(
      {
        creditUserId: outcome.creditUserId,
        head: outcome.head,
        ...(outcome.suffix == null ? {} : { suffix: outcome.suffix }),
        credit:
          outcome.credit == null
            ? null
            : {
                position: outcome.credit.position,
                ...(outcome.creditUserId == null && typed != null
                  ? { name: typed }
                  : {})
              },
        assists: outcome.assists,
        ...(outcome.assistWord == null
          ? {}
          : { assistWord: outcome.assistWord })
      },
      nameOf
    ),
    credit:
      outcome.credit == null
        ? null
        : {
            name,
            role: outcome.credit.role,
            position: outcome.credit.position
          },
    teamId: outcome.teamId,
    creditUserId: outcome.creditUserId
  }
}

export interface HighlightEvent {
  tag?: string | null
  id: string
  atBatIndex: number
  /**
   * When the play began. For a play imported from GameChanger this is close
   * to the play itself; for one scored in TeamStation it is the previous
   * play's tap, the start of the at-bat.
   */
  startTime: Date | null
  /** The scorekeeper's tap time. The play itself happened before this. */
  endTime: Date | null
  eventType: string | null
  /** For the sentence TeamStation writes about the play. */
  inning: number | null
  halfInning: string | null
  awayScore: number | null
  homeScore: number | null
  titleOverride: string | null
  timeNudgeSec: number
  hidden: boolean
  isScoringPlay: boolean
  /**
   * A play yields one or more.
   *
   * `undefined` and `[]` are **not** the same thing, and the difference
   * decides whether a highlight is shown. `[]` means the stored play carries
   * an empty `credits` array: nobody did anything worth watching — an error,
   * a wild pitch — so there is nothing to show. `undefined` means no post of
   * the play at this index has carried a `credits` key, or the row predates
   * migration 031: those plays are shown by their type. A re-post without the
   * key keeps the list stored before it (`withKeptCredits`).
   */
  credits?: NamedOutcome[]
}

/** The `events` columns a highlight is worked out from. */
export const HIGHLIGHT_EVENT_COLUMNS = [
  'events.id',
  'events.atBatIndex',
  'events.startTime',
  'events.endTime',
  'events.eventType',
  'events.inning',
  'events.halfInning',
  'events.awayScore',
  'events.homeScore',
  'events.titleOverride',
  'events.timeNudgeSec',
  'events.hidden',
  'events.isScoringPlay',
  'events.gumbo'
] as const

type HighlightEventRow = Pick<
  Selectable<EventsTable>,
  | 'id'
  | 'atBatIndex'
  | 'startTime'
  | 'endTime'
  | 'eventType'
  | 'inning'
  | 'halfInning'
  | 'awayScore'
  | 'homeScore'
  | 'titleOverride'
  | 'timeNudgeSec'
  | 'hidden'
  | 'isScoringPlay'
> & { gumbo?: unknown }

/**
 * A row read with `HIGHLIGHT_EVENT_COLUMNS`, with its play's credits named
 * from its game's name book (`gameNames`).
 */
export function highlightEvent(
  row: HighlightEventRow,
  credits: CreditedOutcome[] | undefined,
  nameOf: NameOf
): HighlightEvent {
  return {
    tag: row.gumbo == null ? null : completedPlayTag(row.gumbo as TagDocument),
    id: row.id,
    atBatIndex: row.atBatIndex,
    startTime: row.startTime == null ? null : new Date(row.startTime),
    endTime: row.endTime == null ? null : new Date(row.endTime),
    eventType: row.eventType,
    inning: row.inning,
    halfInning: row.halfInning,
    awayScore: row.awayScore,
    homeScore: row.homeScore,
    titleOverride: row.titleOverride,
    timeNudgeSec: row.timeNudgeSec,
    hidden: row.hidden,
    isScoringPlay: row.isScoringPlay === true,
    credits: credits?.map(outcome => namedOutcome(outcome, nameOf))
  }
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
  tag?: string | null
  eventId: string
  atBatIndex: number
  title: string
  /**
   * The play in a sentence, for the panel under the video: TeamStation's own
   * reading of its type, credits, half-inning and score (`describePlay`),
   * written now and never stored.
   */
  description: string
  /** Where the player should seek to, in seconds from the video's start. */
  startOffsetSec: number
  /** Where the play itself is, for a still or a marker. */
  playOffsetSec: number
  /**
   * Where the highlight stops: `tailSec` past the play, or the end of the
   * recording where that comes first.
   */
  endOffsetSec: number
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
 * 1. The end time, or the start time when there is none, is when the
 *    scorekeeper **tapped**, which is `lagSec` after the play. Subtract the
 *    lag to find the play.
 * 2. `timeNudgeSec` corrects one play whose tap was plainly wrong. It is a
 *    per-play correction, not a second lead setting.
 * 3. Back up by the lead for that event type, so the viewer sees the wind-up
 *    rather than landing on the contact.
 * 4. Convert to an offset in this video, allowing for the video's own clock
 *    correction.
 * 5. Stop `tailSec` after the play, or where the recording stops.
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
    const tappedAt = event.endTime ?? event.startTime
    if (tappedAt == null) continue
    // A fielding error is nobody's highlight: not the fielder's, and not the
    // batter's either, who reached on somebody else's mistake. A person who
    // gave the play a title of their own has said otherwise, and that stands.
    if (event.eventType === 'field_error' && event.titleOverride == null) {
      continue
    }

    const tapMs = tappedAt.getTime() + event.timeNudgeSec * 1000
    const playMs = tapMs - settings.lagSec * 1000
    const lead = leadFor(event.eventType, settings)
    const startMs = playMs - lead * 1000

    const playOffsetSec = toOffset(playMs, videoStartMs, video.syncOffsetSec)
    const startOffsetSec = toOffset(startMs, videoStartMs, video.syncOffsetSec)
    const tailOffsetSec = toOffset(
      playMs + settings.tailSec * 1000,
      videoStartMs,
      video.syncOffsetSec
    )

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
      tag: event.tag ?? null,
      eventId: event.id,
      atBatIndex: event.atBatIndex,
      title: label,
      description: describePlay({
        eventType: event.eventType,
        inning: event.inning,
        halfInning: event.halfInning,
        awayScore: event.awayScore,
        homeScore: event.homeScore,
        credits: shown
      }),
      playAt: new Date(playMs),
      startOffsetSec: Math.max(0, startOffsetSec),
      playOffsetSec,
      endOffsetSec:
        video.durationSec == null
          ? tailOffsetSec
          : Math.min(tailOffsetSec, video.durationSec),
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
 * Two reasons not to. **Nobody to name**: if the credit names nobody, by id
 * or by a typed name, a row saying `Ground out` is a thumbnail with no reason
 * to press it. And **an
 * opponent nobody runs**: a team invented from a name typed into somebody
 * else's schedule, which nobody has claimed. Both of those at once — a real
 * team in the league is shown whether or not anybody has been recorded as
 * running it.
 */
function worthShowing(
  outcome: NamedOutcome,
  teams: Map<string, TeamStanding>
): boolean {
  if (personOf(outcome) == null) return false
  if (outcome.teamId == null) return true
  const standing = teams.get(outcome.teamId)
  if (standing == null) return true
  // Both conditions, not either. A team that plays in the league is shown
  // whether or not anybody has been recorded as running it — and on real data
  // nobody has, so `external || !hasOwner` dropped every highlight in the app.
  return !(standing.isExternal && !standing.hasOwner)
}

/**
 * Who a credit names: his id, or the name typed for somebody with none, or
 * undefined for nobody.
 */
function personOf(outcome: NamedOutcome): string | undefined {
  if (outcome.creditUserId != null) return `id:${outcome.creditUserId}`
  const typed = outcome.credit?.name ?? ''
  return typed === '' ? undefined : `typed:${typed}`
}

/**
 * The outcomes of one play, as one line.
 *
 * A player already named by an earlier part is not named again: a home run
 * puts the batter across the plate, so without this it reads
 * `Home run: Hunter P · Run: Hunter P`. A player is the same person by his
 * id, or, with none, by the name typed for him; two players whose names read
 * alike are not.
 */
function joinOutcomes(outcomes: NamedOutcome[]): string {
  const seen = new Set<string | undefined>()
  const parts: string[] = []
  for (const outcome of outcomes) {
    const person = personOf(outcome)
    if (outcome.eventType === 'run' && seen.has(person)) continue
    seen.add(person)
    parts.push(outcome.label)
  }
  return parts.join(' · ')
}

function titleFor(event: HighlightEvent): string {
  if (event.titleOverride != null && event.titleOverride !== '') {
    return event.titleOverride
  }
  return eventTypeName(event.eventType)
}
