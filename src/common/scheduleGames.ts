/**
 * The body and answer of `POST /api/v1/teams/:teamId/games`, which schedules
 * games for one team. Shared by the server and any schedule editor, so both
 * refuse the same rows with the same words.
 *
 * Each row is cleaned on its own: one malformed row is that row's `invalid`
 * answer, and the rest still apply.
 */

import { isFenceDistance, MAX_FENCE_DISTANCE_FT } from './fenceDistance'

/** At most this many rows per call. */
export const SCHEDULE_GAMES_MAX = 200

export type ScheduleSide = 'home' | 'away'
export type ScheduleStatus = 'scheduled' | 'cancelled'

export type ScheduleOpponent = { teamId: string } | { name: string }

export interface ScheduleExternalId {
  system: string
  id: string
  kind: string
}

export interface ScheduleGameRow {
  opponent?: ScheduleOpponent
  side?: ScheduleSide
  /** ISO 8601 with `Z` or an offset, as sent. */
  startAt: string
  seasonId?: string
  /** Undefined or null keeps a held game's venue. */
  venue?: string | null
  /** Undefined means `scheduled` on create and "keep" on update. */
  status?: ScheduleStatus
  externalId?: ScheduleExternalId
  /**
   * Feet to this game's fence, whole, 1 to 600. Undefined leaves it to the
   * season or league on create, and keeps a held game's.
   */
  fenceDistanceFt?: number
}

export type ScheduleErrorCode =
  'invalid' | 'notFound' | 'conflict' | 'noSeason' | 'forbidden'

export const SCHEDULE_ERROR_CODES: ScheduleErrorCode[] = [
  'invalid',
  'notFound',
  'conflict',
  'noSeason',
  'forbidden'
]

export type GameStatus = 'scheduled' | 'inProgress' | 'final' | 'cancelled'

export type ScheduleGameResult =
  | {
      index: number
      result: 'created' | 'updated' | 'unchanged'
      gameId: string
      status: GameStatus
    }
  | {
      index: number
      result: 'error'
      error: { code: ScheduleErrorCode; message: string }
    }

export interface ScheduleGamesCounts {
  created: number
  updated: number
  unchanged: number
  error: number
}

export interface ScheduleGamesResponse {
  results: ScheduleGameResult[]
  counts: ScheduleGamesCounts
}

const NAME_PATTERN = /^[a-z][a-zA-Z0-9]{0,31}$/
/** A date and time with `Z` or a `±hh:mm` offset; nothing looser. */
const START_PATTERN =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{1,9})?)?(Z|[+-]\d{2}:\d{2})$/

function isRecord(raw: unknown): raw is Record<string, unknown> {
  return typeof raw === 'object' && raw != null && !Array.isArray(raw)
}

function fail(message: string): never {
  throw new TypeError(message)
}

function asOpponent(raw: unknown): ScheduleOpponent {
  if (!isRecord(raw)) fail('opponent must be an object')
  const hasTeamId = raw.teamId !== undefined
  const hasName = raw.name !== undefined
  if (hasTeamId === hasName) {
    fail('opponent needs exactly one of teamId and name')
  }
  if (hasTeamId) {
    if (typeof raw.teamId !== 'string' || raw.teamId.trim() === '') {
      fail('opponent.teamId must be a non-empty string')
    }
    return { teamId: raw.teamId.trim() }
  }
  if (typeof raw.name !== 'string') fail('opponent.name must be a string')
  const name = raw.name.trim()
  if (name.length < 1 || name.length > 120) {
    fail('opponent.name must be 1-120 characters')
  }
  return { name }
}

function asExternalId(raw: unknown): ScheduleExternalId {
  if (!isRecord(raw)) fail('externalId must be an object')
  const { system, id } = raw
  const kind = raw.kind ?? 'event'
  if (typeof system !== 'string' || !NAME_PATTERN.test(system)) {
    fail('externalId.system must match ^[a-z][a-zA-Z0-9]{0,31}$')
  }
  if (typeof kind !== 'string' || !NAME_PATTERN.test(kind)) {
    fail('externalId.kind must match ^[a-z][a-zA-Z0-9]{0,31}$')
  }
  if (typeof id !== 'string' || id.length < 1 || id.length > 200) {
    fail('externalId.id must be 1-200 characters')
  }
  return { system, id, kind }
}

function asStartAt(raw: unknown): string {
  if (typeof raw !== 'string') fail('startAt is required, as a date-time')
  if (!START_PATTERN.test(raw)) {
    fail('startAt must be an ISO 8601 date-time with Z or a ±hh:mm offset')
  }
  if (Number.isNaN(new Date(raw).getTime())) {
    fail('startAt is not a real date-time')
  }
  return raw
}

/** One row of the body, or a `TypeError` naming the field that is wrong. */
export function asScheduleGameRow(raw: unknown): ScheduleGameRow {
  if (!isRecord(raw)) fail('a game must be an object')
  const row: ScheduleGameRow = { startAt: asStartAt(raw.startAt) }
  if (raw.opponent !== undefined) row.opponent = asOpponent(raw.opponent)
  if (raw.side !== undefined) {
    if (raw.side !== 'home' && raw.side !== 'away') {
      fail('side must be home or away')
    }
    row.side = raw.side
  }
  if (raw.seasonId !== undefined) {
    if (typeof raw.seasonId !== 'string' || raw.seasonId === '') {
      fail('seasonId must be a non-empty string')
    }
    row.seasonId = raw.seasonId
  }
  if (raw.venue !== undefined && raw.venue !== null) {
    if (typeof raw.venue !== 'string' || raw.venue.length > 200) {
      fail('venue must be a string of at most 200 characters')
    }
    row.venue = raw.venue
  } else if (raw.venue === null) {
    row.venue = null
  }
  if (raw.status !== undefined) {
    if (raw.status !== 'scheduled' && raw.status !== 'cancelled') {
      fail('status must be scheduled or cancelled')
    }
    row.status = raw.status
  }
  if (raw.externalId !== undefined) {
    row.externalId = asExternalId(raw.externalId)
  }
  if (raw.fenceDistanceFt !== undefined) {
    if (!isFenceDistance(raw.fenceDistanceFt)) {
      fail(
        `fenceDistanceFt must be whole feet from 1 to ${MAX_FENCE_DISTANCE_FT}`
      )
    }
    row.fenceDistanceFt = raw.fenceDistanceFt
  }
  return row
}

/** The whole body: `{ games: [...] }` with 1-200 items, each still raw. */
export function asScheduleGamesBody(raw: unknown): { games: unknown[] } {
  if (!isRecord(raw)) fail('The body must be { games: [...] }')
  const { games } = raw
  if (!Array.isArray(games)) fail('games must be an array')
  if (games.length === 0) fail('games must hold at least one game')
  if (games.length > SCHEDULE_GAMES_MAX) {
    fail(`games holds at most ${SCHEDULE_GAMES_MAX} games per call`)
  }
  return { games }
}

const RESULTS = ['created', 'updated', 'unchanged']
const STATUSES = ['scheduled', 'inProgress', 'final', 'cancelled']

function asResult(raw: unknown): ScheduleGameResult {
  if (!isRecord(raw) || typeof raw.index !== 'number') {
    fail('a result needs an index')
  }
  const { index } = raw
  if (raw.result === 'error') {
    const error = raw.error
    if (
      !isRecord(error) ||
      typeof error.message !== 'string' ||
      !SCHEDULE_ERROR_CODES.includes(error.code as ScheduleErrorCode)
    ) {
      fail('an error result needs a known code and a message')
    }
    return {
      index,
      result: 'error',
      error: { code: error.code as ScheduleErrorCode, message: error.message }
    }
  }
  if (
    typeof raw.result !== 'string' ||
    !RESULTS.includes(raw.result) ||
    typeof raw.gameId !== 'string' ||
    typeof raw.status !== 'string' ||
    !STATUSES.includes(raw.status)
  ) {
    fail('a result needs a known result, a gameId and a status')
  }
  return {
    index,
    result: raw.result as 'created' | 'updated' | 'unchanged',
    gameId: raw.gameId,
    status: raw.status as GameStatus
  }
}

export function asScheduleGamesResponse(raw: unknown): ScheduleGamesResponse {
  if (!isRecord(raw) || !Array.isArray(raw.results) || !isRecord(raw.counts)) {
    fail('a schedule answer needs results and counts')
  }
  const counts = raw.counts
  const count = (key: keyof ScheduleGamesCounts): number => {
    const value = counts[key]
    if (typeof value !== 'number') fail(`counts.${key} must be a number`)
    return value
  }
  return {
    results: raw.results.map(asResult),
    counts: {
      created: count('created'),
      updated: count('updated'),
      unchanged: count('unchanged'),
      error: count('error')
    }
  }
}
