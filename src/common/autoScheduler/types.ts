import type { Availability } from '../fieldAvailability'
import type { ScheduleSettings } from '../seasonScheduling'
import type { FieldSize } from '../venues'

/**
 * The Auto-Scheduler engine's input and output. The engine is pure and
 * deterministic for a given input: the server loads the input
 * (`src/server/autoScheduler/snapshot.ts`), runs `buildOptions`, and stores
 * what it returns. Instants are epoch milliseconds inside the engine and
 * ISO strings in its output, which is stored as JSON.
 */

/**
 * A season of the run, with the teams it schedules. A season is only dates:
 * its days, blackouts and game windows are read in the zone of the field a
 * game is placed on.
 */
export interface EngineSeason {
  id: string
  name: string
  settings: ScheduleSettings
  /** Unflagged teams: each plays `regularGames` and `exhibitionGames`. */
  participants: string[]
  /** Flagged teams: each plays only participants, only exhibition games. */
  exhibitionTeams: string[]
}

/** A chosen field, with its effective availability. */
export interface EngineField {
  id: string
  name: string
  venueName: string
  sizes: FieldSize[]
  availability: Availability
  /** Time a field needs between games of different sizes. */
  switchMinutes: number
}

/**
 * Something already holding a field or teams for a while that the run does
 * not count: another league's game on a chosen field, or a team's game in
 * another season. It only blocks time.
 */
export interface EngineBooking {
  key: string
  /** The field it holds, if it is on a chosen field. */
  fieldId: string | null
  size: FieldSize | null
  /** The run's teams it holds. */
  teamIds: string[]
  start: number
  end: number
}

/**
 * A game of a run's season that stays where it is and counts toward its
 * teams' totals: a played game, one kept by Work around, one a team outside
 * the league consented to, one added by hand, or a scheduler proposal still
 * waiting for consent. It also holds its field and teams.
 */
export interface FixedGame {
  key: string
  seasonId: string
  homeTeamId: string
  awayTeamId: string
  exhibition: boolean
  fieldId: string | null
  size: FieldSize | null
  start: number
  end: number
}

export interface EngineInput {
  seasons: EngineSeason[]
  fields: EngineField[]
  bookings: EngineBooking[]
  fixed: FixedGame[]
  /** Team names, for the reasons and unmet lines. */
  teamNames: Record<string, string>
  /**
   * A partial run: only these teams get new games. The others' needs are
   * zero. Left out, every team of the run gets its games.
   */
  teamIds?: string[]
  /** No game starts before this instant: the run never schedules the past. */
  notBefore: number
  /** The first of the seeds the search runs from. */
  seed: number
  /**
   * The matchups to place, and only these: a recalculation's rejected games,
   * or the games listed for rescheduling and the games a partial build
   * replaces. When set, the engine places exactly these matchups instead of
   * pairing teams by need; counts are whatever they come to.
   */
  required?: Array<{
    key: string
    seasonId: string
    homeTeamId: string
    awayTeamId: string
    exhibition: boolean
  }>
}

/** A game an option places. */
export interface PlannedGame {
  /** Stable within the option, e.g. `sea_a:tem_x:tem_y:2`. */
  key: string
  seasonId: string
  homeTeamId: string
  awayTeamId: string
  exhibition: boolean
  fieldId: string
  size: FieldSize
  /** ISO instants. */
  startAt: string
  endAt: string
}

/** One team's line in an option's fairness summary. */
export interface FairnessRow {
  teamId: string
  seasonId: string
  exhibitionTeam: boolean
  /** Its games in the option, fixed ones included. */
  regularGames: number
  exhibitionGames: number
  /** Games starting before 12:00, from 12:00 to 17:00, and after. */
  mornings: number
  afternoons: number
  evenings: number
  /** Games per weekday, Sunday first, each in its field's zone. */
  weekdays: number[]
  /** The fewest and most days between two of its games; null with fewer than two. */
  shortestGapDays: number | null
  longestGapDays: number | null
  doubleheaders: number
}

/** A count the option couldn't give, and why. */
export interface UnmetConstraint {
  seasonId: string
  /** "every team gets 11 of the 12 requested regular-season games" */
  message: string
  /** "not enough 50/70 field time to give every team 12 games" */
  cause: string
}

export interface ScheduleOption {
  /** Only the new games; fixed games stay where they are. */
  games: PlannedGame[]
  fairness: FairnessRow[]
  /** Why this option trails Option 1; empty for Option 1. */
  reasons: string[]
  unmet: UnmetConstraint[]
  /** The lexicographic score (lower is better), for tests and ordering. */
  score: number[]
}

export interface EngineResult {
  /** Up to three options, the recommended one first. */
  options: ScheduleOption[]
  /**
   * Set when no new game can be placed while some participant still needs
   * games; there are then no options. "not enough 50/70 field time to give
   * every team 30 games"
   */
  blocking: string | null
}
