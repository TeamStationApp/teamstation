/**
 * The bodies and answers of the routes that add a team's people by the ids
 * another system knows them by: `POST /api/v1/teams/:teamId/players`. Shared
 * by the server and any client, so both refuse the same bodies with the same
 * words.
 *
 * A body is cleaned whole: one malformed row refuses the call, with a message
 * naming the row and the field.
 */

import { asExternalIdAt, type ExternalIdBody } from './externalIds'
import { JERSEY_MAX_LENGTH } from './playerSettings'

/** At most this many rows per call, and at least one. */
export const TEAM_MEMBERS_MAX = 200

/** A first or last name is at most this long, after trimming. */
export const PERSON_NAME_MAX = 100

/** One id another system has for a person. */
export type TeamMemberExternalId = ExternalIdBody

export type Bats = 'left' | 'right' | 'switch'
export type Throws = 'left' | 'right'

export interface TeamPlayerRow {
  /** Trimmed; may be empty. */
  firstName: string
  /** Trimmed; may be empty. */
  lastName: string
  /** Trimmed, at most three characters; null for none. */
  jersey: string | null
  bats: Bats | null
  throws: Throws | null
  externalId: TeamMemberExternalId
}

export interface TeamPlayersBody {
  players: TeamPlayerRow[]
}

/** Why one row was refused while the others still applied. */
export interface TeamMemberError {
  code: 'conflict'
  message: string
}

export type TeamPlayerResult =
  | {
      index: number
      /**
       * `created`: a new user. `joined`: an existing user newly a player
       * here. `unchanged`: already a player here.
       */
      result: 'created' | 'joined' | 'unchanged'
      userId: number
    }
  | { index: number; result: 'error'; error: TeamMemberError }

export interface TeamPlayersCounts {
  created: number
  joined: number
  unchanged: number
  error: number
}

export interface TeamPlayersResponse {
  results: TeamPlayerResult[]
  counts: TeamPlayersCounts
}

function isRecord(raw: unknown): raw is Record<string, unknown> {
  return typeof raw === 'object' && raw != null && !Array.isArray(raw)
}

function fail(message: string): never {
  throw new TypeError(message)
}

/** A name, trimmed. Missing is empty; anything but a string is refused. */
function asName(raw: unknown, field: string): string {
  if (raw === undefined || raw === null) return ''
  if (typeof raw !== 'string') fail(`${field} must be a string`)
  const value = raw.trim()
  if (value.length > PERSON_NAME_MAX) {
    fail(`${field} must be at most ${PERSON_NAME_MAX} characters`)
  }
  return value
}

function asJerseyAt(raw: unknown, field: string): string | null {
  if (raw === undefined || raw === null) return null
  if (typeof raw !== 'string') fail(`${field} must be a string`)
  const jersey = raw.trim()
  if (jersey === '') return null
  if (jersey.length > JERSEY_MAX_LENGTH) {
    fail(`${field} must be at most ${JERSEY_MAX_LENGTH} characters`)
  }
  return jersey
}

function asBatsAt(raw: unknown, field: string): Bats | null {
  if (raw === undefined || raw === null) return null
  if (raw !== 'left' && raw !== 'right' && raw !== 'switch') {
    fail(`${field} must be left, right or switch`)
  }
  return raw
}

function asThrowsAt(raw: unknown, field: string): Throws | null {
  if (raw === undefined || raw === null) return null
  if (raw !== 'left' && raw !== 'right') fail(`${field} must be left or right`)
  return raw
}

/** The list under `key`: an array of 1 to 200 rows, each still raw. */
export function asTeamMemberRows(
  raw: unknown,
  key: string,
  noun: string
): unknown[] {
  if (!isRecord(raw)) fail(`The body must be { ${key}: [...] }`)
  const rows = raw[key]
  if (!Array.isArray(rows)) fail(`${key} must be an array`)
  if (rows.length === 0) fail(`${key} must hold at least one ${noun}`)
  if (rows.length > TEAM_MEMBERS_MAX) {
    fail(`${key} holds at most ${TEAM_MEMBERS_MAX} ${noun}s per call`)
  }
  return rows
}

/** Both names of a row, trimmed. */
export function asPersonNames(
  raw: Record<string, unknown>,
  at: string
): { firstName: string; lastName: string } {
  return {
    firstName: asName(raw.firstName, `${at}.firstName`),
    lastName: asName(raw.lastName, `${at}.lastName`)
  }
}

function asTeamPlayerRow(raw: unknown, index: number): TeamPlayerRow {
  const at = `players[${index}]`
  if (!isRecord(raw)) fail(`${at} must be an object`)
  return {
    ...asPersonNames(raw, at),
    jersey: asJerseyAt(raw.jersey, `${at}.jersey`),
    bats: asBatsAt(raw.bats, `${at}.bats`),
    throws: asThrowsAt(raw.throws, `${at}.throws`),
    externalId: asExternalIdAt(raw.externalId, `${at}.externalId`)
  }
}

/** The body, or a `TypeError` naming the row and field that is wrong. */
export function asTeamPlayersBody(raw: unknown): TeamPlayersBody {
  return {
    players: asTeamMemberRows(raw, 'players', 'player').map(asTeamPlayerRow)
  }
}
