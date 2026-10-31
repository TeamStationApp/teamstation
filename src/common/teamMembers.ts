/**
 * The bodies and answers of the routes that add a team's people by the ids
 * another system knows them by: `POST /api/v1/teams/:teamId/players` and
 * `POST /api/v1/teams/:teamId/adults`. Shared by the server and any client,
 * so both refuse the same bodies with the same words.
 *
 * A body is cleaned whole: one malformed row refuses the call, with a message
 * naming the row and the field.
 */

import { asExternalIdAt, type ExternalIdBody } from './externalIds'
import { JERSEY_MAX_LENGTH } from './playerSettings'
import type { Role } from './roles'

/** At most this many rows per call, and at least one. */
export const TEAM_MEMBERS_MAX = 200

/** A first or last name is at most this long, after trimming. */
export const PERSON_NAME_MAX = 100

/** An address is at most this long, after trimming. */
export const EMAIL_MAX = 254

/** One adult guards at most this many players in one row. */
export const GUARDIAN_OF_MAX = 50

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
      userId: string
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

export interface TeamAdultRow {
  /** Trimmed; may be empty. */
  firstName: string
  /** Trimmed; may be empty. */
  lastName: string
  /** Trimmed and lower-cased, with an `@`; null for none. */
  email: string | null
  externalId: TeamMemberExternalId
  /** The external ids of the players this adult is a guardian of. */
  guardianOf: TeamMemberExternalId[]
  /** Given the coach and scorekeeper roles on the team. */
  staff: boolean
}

export interface TeamAdultsBody {
  adults: TeamAdultRow[]
}

/** What one adult row did, whatever its result. */
export interface TeamAdultGains {
  /** A membership of the team was made by this row. */
  joined: boolean
  /** Guardian links this row made. */
  guardianLinks: number
  /** `guardianOf` ids that named no player of this team. */
  guardiansMissing: number
  /**
   * `guardianOf` players this row was not made a guardian of: the player
   * had a guardian before the call, or the adult is the caller.
   */
  guardiansRefused: number
  /** Roles this row added on the team. */
  rolesAdded: Role[]
  /** Staff it asked for and was not given: the team holds them by an open add. */
  rolesRefused?: true
}

export type TeamAdultResult =
  | (TeamAdultGains & {
      index: number
      /**
       * `created`: a new user. `matched`: an existing user who gained
       * something here. `unchanged`: an existing user who gained nothing.
       */
      result: 'created' | 'matched' | 'unchanged'
      userId: string
      /** The row's address belongs to somebody else, and was left there. */
      emailHeldElsewhere?: true
      /**
       * The row's address is held by nobody, and was not attached: the
       * account was already here, and the caller is not a site
       * administrator or the account already has an address.
       */
      emailNotAttached?: true
      /**
       * The row's external id was not recorded: the account was found by
       * its address, and only a site administrator may give an account the
       * call did not make another system's id.
       */
      externalIdNotAttached?: true
    })
  | (TeamAdultGains & {
      index: number
      result: 'error'
      error: TeamMemberError
    })

export interface TeamAdultsCounts {
  created: number
  matched: number
  unchanged: number
  error: number
  /** Guardian links this call made. */
  guardianLinks: number
  /** Guardian links this call refused, as each row's `guardiansRefused`. */
  guardiansRefused: number
  /** Rows refused staff, as each row's `rolesRefused`. */
  rolesRefused: number
  /** Adults who gained at least one role in this call. */
  staff: number
}

export interface TeamAdultsResponse {
  results: TeamAdultResult[]
  counts: TeamAdultsCounts
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

function asEmailAt(raw: unknown, field: string): string | null {
  if (raw === undefined || raw === null) return null
  if (typeof raw !== 'string') fail(`${field} must be a string`)
  const email = raw.trim().toLowerCase()
  if (!email.includes('@')) fail(`${field} must be an address, with an @`)
  if (email.length > EMAIL_MAX) {
    fail(`${field} must be at most ${EMAIL_MAX} characters`)
  }
  return email
}

function asGuardianOf(raw: unknown, field: string): TeamMemberExternalId[] {
  if (raw === undefined) return []
  if (!Array.isArray(raw)) fail(`${field} must be an array`)
  if (raw.length > GUARDIAN_OF_MAX) {
    fail(`${field} holds at most ${GUARDIAN_OF_MAX} players`)
  }
  return raw.map((one, index) => asExternalIdAt(one, `${field}[${index}]`))
}

function asTeamAdultRow(raw: unknown, index: number): TeamAdultRow {
  const at = `adults[${index}]`
  if (!isRecord(raw)) fail(`${at} must be an object`)
  const staff = raw.staff ?? false
  if (typeof staff !== 'boolean') fail(`${at}.staff must be true or false`)
  return {
    ...asPersonNames(raw, at),
    email: asEmailAt(raw.email, `${at}.email`),
    externalId: asExternalIdAt(raw.externalId, `${at}.externalId`),
    guardianOf: asGuardianOf(raw.guardianOf, `${at}.guardianOf`),
    staff
  }
}

/** The body, or a `TypeError` naming the row and field that is wrong. */
export function asTeamAdultsBody(raw: unknown): TeamAdultsBody {
  return {
    adults: asTeamMemberRows(raw, 'adults', 'adult').map(asTeamAdultRow)
  }
}
