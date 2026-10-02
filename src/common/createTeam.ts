/**
 * The body and answer of `POST /api/v1/teams`, which makes a team, puts it in
 * a season, and records the ids another system knows it by. Shared by the
 * server and any client, so both refuse the same bodies with the same words.
 */

/** A team's name is at most this long, after trimming. */
export const TEAM_NAME_MAX = 100

/** A season's name is at most this long, after trimming. */
export const SEASON_NAME_MAX = 100

/** At most this many external ids per team. */
export const CREATE_TEAM_EXTERNAL_IDS_MAX = 20

export type CreateTeamSeason = { id: string } | { name: string; year: number }

export interface CreateTeamExternalId {
  system: string
  id: string
  kind: string
}

export interface CreateTeamBody {
  name: string
  season: CreateTeamSeason
  externalIds: CreateTeamExternalId[]
}

/** The season a new team was put in, and whether this call made it. */
export interface CreatedTeamSeason {
  id: string
  name: string
  year: number
  created: boolean
}

/**
 * 201 when the team was made; 200, with `season: null`, when one of the
 * external ids already named a team, which is then the one answered.
 */
export type CreateTeamResponse =
  | { id: string; name: string; created: true; season: CreatedTeamSeason }
  | { id: string; name: string; created: false; season: null }

/** The rule `external_ids.system` holds everywhere. */
const SYSTEM_PATTERN = /^[a-z][a-zA-Z0-9]{0,31}$/

function isRecord(raw: unknown): raw is Record<string, unknown> {
  return typeof raw === 'object' && raw != null && !Array.isArray(raw)
}

function fail(message: string): never {
  throw new TypeError(message)
}

function asTrimmed(raw: unknown, field: string, max: number): string {
  if (typeof raw !== 'string') fail(`${field} must be a string`)
  const value = raw.trim()
  if (value.length < 1 || value.length > max) {
    fail(`${field} must be 1-${max} characters`)
  }
  return value
}

function asSeason(raw: unknown): CreateTeamSeason {
  if (!isRecord(raw)) fail('season must be an object')
  const hasId = raw.id !== undefined
  const hasName = raw.name !== undefined || raw.year !== undefined
  if (hasId === hasName) {
    fail('season needs either id, or name and year')
  }
  if (hasId) {
    if (typeof raw.id !== 'string' || raw.id.trim() === '') {
      fail('season.id must be a non-empty string')
    }
    return { id: raw.id.trim() }
  }
  const name = asTrimmed(raw.name, 'season.name', SEASON_NAME_MAX)
  const { year } = raw
  if (
    typeof year !== 'number' ||
    !Number.isInteger(year) ||
    year < 1900 ||
    year > 2200
  ) {
    fail('season.year must be a whole year from 1900 to 2200')
  }
  return { name, year }
}

function asExternalId(raw: unknown, index: number): CreateTeamExternalId {
  const at = `externalIds[${index}]`
  if (!isRecord(raw)) fail(`${at} must be an object`)
  const { system, id, kind } = raw
  if (typeof system !== 'string' || !SYSTEM_PATTERN.test(system)) {
    fail(`${at}.system must match ^[a-z][a-zA-Z0-9]{0,31}$`)
  }
  if (typeof kind !== 'string' || kind === '') {
    fail(`${at}.kind must be a non-empty string`)
  }
  if (typeof id !== 'string' || id === '') {
    fail(`${at}.id must be a non-empty string`)
  }
  return { system, id, kind }
}

/** The body, or a `TypeError` naming the field that is wrong. */
export function asCreateTeamBody(raw: unknown): CreateTeamBody {
  if (!isRecord(raw)) fail('The body must be an object')
  const name = asTrimmed(raw.name, 'name', TEAM_NAME_MAX)
  const season = asSeason(raw.season)
  let externalIds: CreateTeamExternalId[] = []
  if (raw.externalIds !== undefined) {
    if (!Array.isArray(raw.externalIds)) fail('externalIds must be an array')
    if (raw.externalIds.length > CREATE_TEAM_EXTERNAL_IDS_MAX) {
      fail(`externalIds holds at most ${CREATE_TEAM_EXTERNAL_IDS_MAX} ids`)
    }
    externalIds = raw.externalIds.map(asExternalId)
  }
  return { name, season, externalIds }
}
