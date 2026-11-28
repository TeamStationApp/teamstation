import { type DescribedCredit, describePlay } from '../../common/describePlay'
import {
  type CurrentPlay,
  type GumboPlay,
  isRealPlay
} from '../../common/gumboPlay'
import { isTurnAtBat } from '../../common/scoring/importedRecord'
import {
  halfOutcomes,
  type InningSide,
  lineScore,
  ordinal,
  withHalfOuts
} from '../../common/scoring/linescore'
import { lstrings, plural, sprintf } from '../locales/strings'

/**
 * A game's plays as the Plays tab streams them: half-innings in play order,
 * one line per turn at bat, each with the pitches and other events of the
 * at-bat, and a summary at the end of each half that has ended. Worked out
 * from the stored plays and the at-bat in progress, as
 * `GET /games/:gameId/events` answers them, and nothing else.
 */

export interface PlaysStreamInput {
  plays: GumboPlay[]
  currentPlay: CurrentPlay | null
  away: { name: string }
  home: { name: string }
  /** The game is over, so its last half has ended too. */
  final: boolean
}

export interface PitchRow {
  kind: 'pitch'
  pitchNumber: number
  /** `Called Strike`, `In play, out(s)`. */
  call: string
  balls: number
  strikes: number
  /** Miles per hour, when the pitch was clocked. */
  speed?: number
  /** `Four-Seam Fastball`, when the pitch's type is known. */
  pitchType?: string
  /** On the in-play pitch, the ball's speed off the bat in mph. */
  exitVelocity?: number
}

/** Something that happened among the pitches: a steal, a mound visit. */
export interface EventRow {
  kind: 'event'
  description: string
}

export type PlayRow = PitchRow | EventRow

export interface PlayLine {
  atBatIndex: number
  batter: { gumboId: number | null; name: string }
  sentence: string
  /** The outs after the play, or so far for the at-bat in progress. */
  outs: number | null
  pitcher: string | null
  /** On a scoring play: `Harbor Hawks 2, Canyon Owls 1`. */
  score?: string
  rows: PlayRow[]
  /** Whether it has pitches to open; an imported play may have none. */
  expandable: boolean
  inProgress: boolean
}

/** A finished half's figures; one the line score cannot say is absent. */
export interface HalfSummary {
  runs?: number
  hits?: number
  errors?: number
  leftOnBase?: number
}

export interface HalfInning {
  /** `top-1`, `bottom-3`. */
  key: string
  inning: number
  half: 'top' | 'bottom'
  /** `Top 1st`, `Bottom 3rd`. */
  label: string
  battingTeam: string
  lines: PlayLine[]
  /** Only for a half that has ended. */
  summary?: HalfSummary
}

/** A play or the at-bat in progress, read loosely: both keep extra keys. */
interface PlayDocument {
  about: {
    atBatIndex: number
    inning?: number | null
    halfInning?: 'top' | 'bottom' | null
    isScoringPlay?: boolean
  }
  result?: {
    eventType?: string
    description?: string
    awayScore?: number | null
    homeScore?: number | null
  }
  count?: {
    outs?: number | null
    balls?: number | null
    strikes?: number | null
  }
  matchup?: {
    batter?: { id?: number | null; fullName?: string }
    pitcher?: { id?: number | null; fullName?: string }
  }
  credits?: unknown[]
  playEvents?: unknown[]
}

interface PlayEvent {
  type?: string
  isPitch?: boolean
  pitchNumber?: number
  details?: {
    call?: { description?: string }
    description?: string
    isInPlay?: boolean
    type?: { description?: string }
  }
  count?: { balls?: number; strikes?: number }
  pitchData?: { startSpeed?: number }
  hitData?: { launchSpeed?: number; trajectory?: string }
}

/** How the ball left the bat, after the batter's clause. */
const TRAJECTORY_PHRASES: Record<string, string> = {
  line_drive: 'on a line drive',
  fly_ball: 'on a fly ball',
  ground_ball: 'on a ground ball',
  popup: 'on a pop up',
  bunt_grounder: 'on a bunt',
  bunt_popup: 'on a bunt',
  bunt_line_drive: 'on a bunt'
}

function eventsOf(play: PlayDocument): PlayEvent[] {
  return (play.playEvents ?? []).filter(
    (event): event is PlayEvent => event != null && typeof event === 'object'
  )
}

function isNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value)
}

/** The rows of one play's events, pitches numbered in order. */
function rowsOf(play: PlayDocument): PlayRow[] {
  const rows: PlayRow[] = []
  let pitches = 0
  for (const event of eventsOf(play)) {
    if (event.isPitch === true) {
      pitches += 1
      const details = event.details ?? {}
      const row: PitchRow = {
        kind: 'pitch',
        pitchNumber: isNumber(event.pitchNumber) ? event.pitchNumber : pitches,
        call: details.call?.description ?? details.description ?? '',
        balls: event.count?.balls ?? 0,
        strikes: event.count?.strikes ?? 0
      }
      if (isNumber(event.pitchData?.startSpeed))
        row.speed = event.pitchData.startSpeed
      if (details.type?.description != null)
        row.pitchType = details.type.description
      if (details.isInPlay === true && isNumber(event.hitData?.launchSpeed))
        row.exitVelocity = event.hitData.launchSpeed
      rows.push(row)
      continue
    }
    // The marker that closes a half says nothing a reader needs.
    if (/inning[ _]ended/i.test(event.type ?? '')) continue
    const description = event.details?.description
    if (description != null && description !== '')
      rows.push({ kind: 'event', description })
  }
  return rows
}

function namedCredits(play: PlayDocument): DescribedCredit[] {
  return (play.credits ?? []).filter(
    (credit): credit is DescribedCredit =>
      credit != null &&
      typeof credit === 'object' &&
      typeof (credit as { label?: unknown }).label === 'string'
  )
}

/**
 * `describePlay` without its half-inning and score, with the trajectory of
 * the in-play pitch after the first clause:
 * `Dylan C singles on a line drive. Nasim N scores.`
 */
function sentenceOf(play: PlayDocument): string {
  const eventType = play.result?.eventType ?? null
  const credits = namedCredits(play)
  const inPlay = eventsOf(play).findLast(
    event => event.details?.isInPlay === true
  )
  const phrase = TRAJECTORY_PHRASES[inPlay?.hitData?.trajectory ?? '']
  if (phrase == null) return describePlay({ eventType, credits })
  const [first, ...rest] = credits
  const head = describePlay({
    eventType,
    credits: first == null ? [] : [first]
  }).replace(/\.$/, '')
  return rest.length === 0
    ? `${head} ${phrase}.`
    : `${head} ${phrase}. ${describePlay({ eventType, credits: rest })}`
}

function batterOf(play: PlayDocument): PlayLine['batter'] {
  const batter = play.matchup?.batter
  return { gumboId: batter?.id ?? null, name: batter?.fullName ?? '' }
}

function lineOf(play: PlayDocument, input: PlaysStreamInput): PlayLine {
  const rows = rowsOf(play)
  const line: PlayLine = {
    atBatIndex: play.about.atBatIndex,
    batter: batterOf(play),
    sentence: sentenceOf(play),
    outs: play.count?.outs ?? null,
    pitcher: play.matchup?.pitcher?.fullName ?? null,
    rows,
    expandable: rows.some(row => row.kind === 'pitch'),
    inProgress: false
  }
  const away = play.result?.awayScore
  const home = play.result?.homeScore
  if (play.about.isScoringPlay === true && isNumber(away) && isNumber(home))
    line.score = `${input.away.name} ${away}, ${input.home.name} ${home}`
  return line
}

function inProgressLineOf(play: PlayDocument): PlayLine {
  const rows = rowsOf(play)
  const batter = batterOf(play)
  const outs = play.count?.outs ?? 0
  return {
    atBatIndex: play.about.atBatIndex,
    batter,
    sentence: sprintf(
      lstrings.plays_batting,
      batter.name,
      play.count?.balls ?? 0,
      play.count?.strikes ?? 0,
      plural(outs, lstrings.plays_outs_one, lstrings.plays_outs_other)
    ),
    outs,
    pitcher: play.matchup?.pitcher?.fullName ?? null,
    rows,
    expandable: rows.some(row => row.kind === 'pitch'),
    inProgress: true
  }
}

/**
 * The rows a play that is not a turn at bat stands for: its own events, or
 * its result, or the sentence for its type.
 */
function changeRowsOf(play: PlayDocument): PlayRow[] {
  const rows = rowsOf(play)
  if (rows.length > 0) return rows
  const description =
    play.result?.description ??
    describePlay({
      eventType: play.result?.eventType ?? null,
      credits: namedCredits(play)
    })
  return [{ kind: 'event', description }]
}

/** Plays that stand for no turn at bat and change nobody: a score put right. */
function isPlaceholder(play: PlayDocument): boolean {
  return isRealPlay(play) && !isTurnAtBat(play as GumboPlay)
}

function halfKey(inning: number, half: 'top' | 'bottom'): string {
  return `${half}-${inning}`
}

function figures(side: InningSide | undefined): HalfSummary {
  const summary: HalfSummary = {}
  if (isNumber(side?.runs)) summary.runs = side.runs
  if (isNumber(side?.hits)) summary.hits = side.hits
  if (isNumber(side?.leftOnBase)) summary.leftOnBase = side.leftOnBase
  return summary
}

/** The stream of a game's plays, oldest first, grouped by half-inning. */
export function playsStream(input: PlaysStreamInput): HalfInning[] {
  const stored = [...(input.plays as PlayDocument[])]
    .filter(
      play =>
        isNumber(play.about.inning) &&
        (play.about.halfInning === 'top' ||
          play.about.halfInning === 'bottom') &&
        !isPlaceholder(play)
    )
    .sort((a, b) => a.about.atBatIndex - b.about.atBatIndex)
  const current = input.currentPlay as PlayDocument | null
  const ordered =
    current != null &&
    isNumber(current.about.inning) &&
    (current.about.halfInning === 'top' ||
      current.about.halfInning === 'bottom')
      ? [...stored, current]
      : stored

  const halves: HalfInning[] = []
  const byKey = new Map<string, HalfInning>()
  // Lineup changes wait for the next line of their half.
  let waiting: { key: string; rows: PlayRow[] } | null = null
  const flush = (): void => {
    if (waiting == null) return
    const half = byKey.get(waiting.key)
    const last = half?.lines[half.lines.length - 1]
    if (last != null) last.rows.push(...waiting.rows)
    waiting = null
  }

  for (const play of ordered) {
    const inning = play.about.inning!
    const side = play.about.halfInning!
    const key = halfKey(inning, side)
    if (waiting != null && waiting.key !== key) flush()
    const inProgress = play === current
    if (!inProgress && !isTurnAtBat(play as GumboPlay)) {
      const rows = changeRowsOf(play)
      if (waiting == null) waiting = { key, rows }
      else waiting.rows.push(...rows)
      continue
    }
    let half = byKey.get(key)
    if (half == null) {
      half = {
        key,
        inning,
        half: side,
        label: `${side === 'top' ? 'Top' : 'Bottom'} ${ordinal(inning)}`,
        battingTeam: side === 'top' ? input.away.name : input.home.name,
        lines: []
      }
      byKey.set(key, half)
      halves.push(half)
    }
    const line = inProgress ? inProgressLineOf(play) : lineOf(play, input)
    if (waiting != null) {
      line.rows.unshift(...waiting.rows)
      waiting = null
    }
    half.lines.push(line)
  }
  flush()
  summarize(halves, input)
  return halves
}

/** Ends each half that has ended with its runs, hits, errors and runners left. */
function summarize(halves: HalfInning[], input: PlaysStreamInput): void {
  const ended = halves.filter(
    (_half, index) => input.final || index < halves.length - 1
  )
  if (ended.length === 0) return
  let away: number | null = null
  let home: number | null = null
  for (const play of input.plays) {
    away = play.result.awayScore ?? away
    home = play.result.homeScore ?? home
  }
  const plays = withHalfOuts(input.plays)
  const innings = lineScore(plays, halfOutcomes(plays), away, home).innings
  for (const half of ended) {
    const inning = innings.find(one => one.num === half.inning)
    const batting = half.half === 'top' ? inning?.away : inning?.home
    const fielding = half.half === 'top' ? inning?.home : inning?.away
    const summary = figures(batting)
    // Errors are charged to the side in the field.
    if (isNumber(fielding?.errors)) summary.errors = fielding.errors
    half.summary = summary
  }
}
