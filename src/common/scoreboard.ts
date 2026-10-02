import {
  asBoolean,
  asEither,
  asNumber,
  asObject,
  asOptional,
  asString,
  type Cleaner
} from 'cleaners'

import { asLiteral } from './asLiteral'

/**
 * A game's scoreboard: what it shows, where each part of that comes from, and
 * how long it lasts.
 *
 * This file imports nothing but `cleaners`, so TS Watcher's tests can load it
 * beside 1.0's `ScoreState`, which is Watcher's wire format and which these
 * fields match one for one.
 */

const asHalf = asLiteral('top', 'bottom', 'mid')

export const asScoreboardState = asObject({
  inGame: asBoolean,
  pitcherName: asString,
  batterName: asString,
  batterNumber: asNumber,
  batterNumHits: asNumber,
  batterAtBats: asNumber,
  numPitches: asNumber,
  balls: asNumber,
  strikes: asNumber,
  outs: asNumber,
  base1: asBoolean,
  base2: asBoolean,
  base3: asBoolean,
  inning: asNumber,
  half: asHalf,
  homeTeam: asString,
  awayTeam: asString,
  homeScore: asNumber,
  awayScore: asNumber,
  pitchSpeed: asNumber,
  exitVelocity: asNumber
})
export type ScoreboardState = ReturnType<typeof asScoreboardState>

/** What one packet may say: any of the fields, and only those. */
export const asScoreboardUpdate = asObject({
  inGame: asOptional(asBoolean),
  pitcherName: asOptional(asString),
  batterName: asOptional(asString),
  batterNumber: asOptional(asNumber),
  batterNumHits: asOptional(asNumber),
  batterAtBats: asOptional(asNumber),
  numPitches: asOptional(asNumber),
  balls: asOptional(asNumber),
  strikes: asOptional(asNumber),
  outs: asOptional(asNumber),
  base1: asOptional(asBoolean),
  base2: asOptional(asBoolean),
  base3: asOptional(asBoolean),
  inning: asOptional(asNumber),
  half: asOptional(asHalf),
  homeTeam: asOptional(asString),
  awayTeam: asOptional(asString),
  homeScore: asOptional(asNumber),
  awayScore: asOptional(asNumber),
  pitchSpeed: asOptional(asNumber),
  exitVelocity: asOptional(asNumber)
})
export type ScoreboardUpdate = Partial<ScoreboardState>

/** `state` with every field `update` defines copied over it. */
export function mergeScoreboard<T extends ScoreboardUpdate>(
  state: T,
  update: ScoreboardUpdate
): T {
  const merged: ScoreboardUpdate = { ...state }
  for (const [key, value] of Object.entries(update)) {
    if (value !== undefined) Object.assign(merged, { [key]: value })
  }
  return merged as T
}

/**
 * The fields the game's own scoring sets, which TS Watcher may report too.
 *
 * Only a packet carrying one of these makes its source the newer one. A
 * TagOne phone reporting pitch speed, which TeamStation's scoring never
 * reports, must not promote a count another source read minutes ago above the
 * count the scorer has just posted.
 */
export const CONTESTED_FIELDS = [
  'inGame',
  'balls',
  'strikes',
  'outs',
  'base1',
  'base2',
  'base3',
  'inning',
  'half',
  'homeScore',
  'awayScore',
  'batterName',
  'pitcherName',
  'numPitches'
] as const

export type ContestedField = (typeof CONTESTED_FIELDS)[number]

/** What the game's scoring says: every contested field, and nothing else. */
export type GameScoreboard = Pick<ScoreboardState, ContestedField>

export function carriesContested(update: ScoreboardUpdate): boolean {
  return CONTESTED_FIELDS.some(field => update[field] !== undefined)
}

/** The team names, which only the game record may set. */
export function withoutTeamNames(update: ScoreboardUpdate): ScoreboardUpdate {
  const { homeTeam, awayTeam, ...rest } = update
  return rest
}

/**
 * The override dashboard's tile groups, in 1.0's shape: a flag per group,
 * and the group's values once somebody has set them.
 *
 * Written out, as `ApiError` is, because `asOptional` leaves each group a
 * required key whose value may be undefined, and a dashboard that has set
 * no group sends none of them.
 */
export interface DashboardOverrides {
  overrideCountEnabled: boolean
  overrideBasesEnabled: boolean
  overrideTeamEnabled: boolean
  overrideScoreEnabled: boolean
  overrideInningEnabled: boolean
  overrideCount?: { balls: number; strikes: number; outs: number }
  overrideBases?: { base1: boolean; base2: boolean; base3: boolean }
  overrideTeam?: { homeTeam: string; awayTeam: string }
  overrideScore?: { homeScore: number; awayScore: number }
  overrideInning?: { inning: number; half: ScoreboardState['half'] }
}

export const asDashboardOverrides: Cleaner<DashboardOverrides> = asObject({
  overrideCountEnabled: asBoolean,
  overrideBasesEnabled: asBoolean,
  overrideTeamEnabled: asBoolean,
  overrideScoreEnabled: asBoolean,
  overrideInningEnabled: asBoolean,
  overrideCount: asOptional(
    asObject({ balls: asNumber, strikes: asNumber, outs: asNumber })
  ),
  overrideBases: asOptional(
    asObject({ base1: asBoolean, base2: asBoolean, base3: asBoolean })
  ),
  overrideTeam: asOptional(
    asObject({ homeTeam: asString, awayTeam: asString })
  ),
  overrideScore: asOptional(
    asObject({ homeScore: asNumber, awayScore: asNumber })
  ),
  overrideInning: asOptional(asObject({ inning: asNumber, half: asHalf }))
})

export const NO_OVERRIDES: DashboardOverrides = {
  overrideCountEnabled: false,
  overrideBasesEnabled: false,
  overrideTeamEnabled: false,
  overrideScoreEnabled: false,
  overrideInningEnabled: false
}

/** What the dashboard sends: the whole overrides object, or a reset. */
export const asDashboardCommand = asEither(
  asObject({ type: asLiteral('overrides'), data: asDashboardOverrides }),
  asObject({ type: asLiteral('reset') })
)
export type DashboardCommand = ReturnType<typeof asDashboardCommand>

/** One source's latest word, and when (milliseconds) it last contested. */
export interface SourceState {
  state: ScoreboardUpdate
  receivedAt: number
}

/** What the game record says: the teams, and the score it has stored. */
export interface ScoreboardBaseline {
  homeTeam: string
  awayTeam: string
  homeScore: number | null
  awayScore: number | null
}

const DEFAULTS: ScoreboardState = {
  inGame: false,
  pitcherName: '',
  batterName: '',
  batterNumber: 0,
  batterNumHits: 0,
  batterAtBats: 0,
  numPitches: 0,
  balls: 0,
  strikes: 0,
  outs: 0,
  base1: false,
  base2: false,
  base3: false,
  inning: 1,
  half: 'top',
  homeTeam: '',
  awayTeam: '',
  homeScore: 0,
  awayScore: 0,
  pitchSpeed: 0,
  exitVelocity: 0
}

/**
 * The one rule for what a scoreboard shows.
 *
 * The defaults, then the game record, then the two automated sources, oldest
 * first, so the newer wins every field it has sent and the other fills in
 * the rest. A tie goes to the game's own scoring. Neither source may name the
 * teams, so the record's names are laid on again. That is `automated`;
 * `final` adds each override group that is switched on.
 */
export function composeScoreboard(input: {
  baseline: ScoreboardBaseline
  game?: SourceState
  watcher?: SourceState
  overrides?: DashboardOverrides
}): { automated: ScoreboardState; final: ScoreboardState } {
  const { baseline, game, watcher } = input
  let automated = mergeScoreboard(DEFAULTS, {
    homeTeam: baseline.homeTeam,
    awayTeam: baseline.awayTeam,
    homeScore: baseline.homeScore ?? 0,
    awayScore: baseline.awayScore ?? 0
  })
  // Watcher first, so that a stable sort leaves the game last on a tie.
  const sources = [watcher, game].filter(
    (source): source is SourceState => source != null
  )
  sources.sort((a, b) => a.receivedAt - b.receivedAt)
  for (const source of sources)
    automated = mergeScoreboard(automated, source.state)
  automated = {
    ...automated,
    homeTeam: baseline.homeTeam,
    awayTeam: baseline.awayTeam
  }
  return {
    automated,
    final: applyOverrides(automated, input.overrides ?? NO_OVERRIDES)
  }
}

/** Each override group that is on, over `automated`, as 1.0's dashboard did. */
export function applyOverrides(
  automated: ScoreboardState,
  overrides: DashboardOverrides
): ScoreboardState {
  const final = { ...automated }
  if (overrides.overrideCountEnabled && overrides.overrideCount != null) {
    Object.assign(final, overrides.overrideCount)
  }
  if (overrides.overrideBasesEnabled && overrides.overrideBases != null) {
    Object.assign(final, overrides.overrideBases)
  }
  if (overrides.overrideTeamEnabled && overrides.overrideTeam != null) {
    Object.assign(final, overrides.overrideTeam)
  }
  if (overrides.overrideScoreEnabled && overrides.overrideScore != null) {
    Object.assign(final, overrides.overrideScore)
  }
  if (overrides.overrideInningEnabled && overrides.overrideInning != null) {
    Object.assign(final, overrides.overrideInning)
  }
  return final
}

/** The board the sample page draws, and what an operator places. */
export const SAMPLE_SCOREBOARD: ScoreboardState = {
  inGame: true,
  awayTeam: 'VISITORS',
  homeTeam: 'PIONEERS',
  awayScore: 2,
  homeScore: 3,
  inning: 5,
  half: 'top',
  balls: 2,
  strikes: 1,
  outs: 1,
  base1: false,
  base2: true,
  base3: false,
  batterName: 'A. RIVERA',
  batterNumber: 12,
  batterNumHits: 1,
  batterAtBats: 3,
  pitcherName: 'J. WILSON',
  numPitches: 64,
  pitchSpeed: 0,
  exitVelocity: 0
}

/**
 * Board size B: the CSS px box every scoreboard page occupies, drawn or not.
 *
 * It is the size 1.0's scoreboard (`src/client/Scoreboard.tsx` at 25f9496e) drew
 * `SAMPLE_SCOREBOARD` at in a 1920 × 1080 window, 606.53 × 247, rounded up
 * as Director's measure rounds it. TS Director assumes it when it first
 * places a scoreboard (`ScoreboardOverlaySource.boardSize`), and measures it
 * on every page.
 */
export const SCOREBOARD_BOARD_SIZE = { width: 607, height: 247 } as const

/** Why a scoreboard socket was closed. */
export const SCOREBOARD_CLOSE = {
  /** A message could not be read. */
  unreadable: 4400,
  /** Publishing and overriding need a signed-in caller. */
  notSignedIn: 4401,
  /** This caller does not run this game. */
  notAllowed: 4403,
  /** No such game, or its scoreboard has closed. */
  closed: 4404
} as const

const HOUR_MS = 3_600_000
/** How long a scoreboard stays open with nothing written: from its start. */
export const SCOREBOARD_OPEN_MS = 2 * HOUR_MS
/** The latest a scoreboard can close: this long after the game's start. */
export const SCOREBOARD_LIMIT_MS = 72 * HOUR_MS

/**
 * When a scoreboard written at `lastUpdateMs` closes: two hours after that
 * write, or after the start if that is later, and never past three days
 * after the start.
 */
export function scoreboardExpiry(
  startAtMs: number,
  lastUpdateMs: number
): number {
  return Math.min(
    Math.max(lastUpdateMs, startAtMs) + SCOREBOARD_OPEN_MS,
    startAtMs + SCOREBOARD_LIMIT_MS
  )
}

/**
 * A game's scoreboard is open from the moment the game exists. It stays open
 * until two hours after the start, and after that for as long as its state
 * has not expired. A cancelled game has none.
 */
export function scoreboardOpen(
  game: { startAt: number; status: string } | undefined,
  keyExists: boolean,
  nowMs: number
): boolean {
  if (game == null || game.status === 'cancelled') return false
  return keyExists || nowMs < game.startAt + SCOREBOARD_OPEN_MS
}
