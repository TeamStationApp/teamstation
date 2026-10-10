import { asArray, asObject } from 'cleaners'

import { asBats, asThrows } from './api'
import { POSITIONS } from './scoring/state'

/**
 * The positions a coach may give a player: the nine on the field, in the
 * scoring library's order, and the designated hitter, who bats and never
 * fields. Gumbo's abbreviations, so a lineup can read them as they are.
 */
export const PLAYER_POSITIONS = [...POSITIONS, 'DH'] as const
export type PlayerPosition = (typeof PLAYER_POSITIONS)[number]

/** The longest jersey number a roster row has room for. */
export const JERSEY_MAX_LENGTH = 3

export const PLAYER_NAME_MAX_LENGTH = 100

/** Both parts are sent together; a player must keep at least one name. */
export function asPlayerSettingsName(raw: unknown): {
  firstName: string
  lastName: string
} {
  const part = (value: unknown): string => {
    if (typeof value !== 'string') throw new TypeError('Expected a name')
    const name = value.trim()
    if (name.length > PLAYER_NAME_MAX_LENGTH) {
      throw new TypeError(
        `A name is at most ${PLAYER_NAME_MAX_LENGTH} characters`
      )
    }
    return name
  }
  const name = asObject({ firstName: part, lastName: part })(raw)
  if (name.firstName === '' && name.lastName === '') {
    throw new TypeError('Enter a player name.')
  }
  return name
}

/**
 * A jersey number as it is stored: trimmed, and `null` for none. An empty
 * field is no number rather than a number that is blank.
 */
export function asJersey(raw: unknown): string | null {
  if (raw === null) return null
  if (typeof raw !== 'string') throw new TypeError('Expected a jersey number')
  const jersey = raw.trim()
  if (jersey === '') return null
  if (jersey.length > JERSEY_MAX_LENGTH) {
    throw new TypeError(
      `A jersey number is at most ${JERSEY_MAX_LENGTH} characters`
    )
  }
  return jersey
}

/** Positions, each once, in `PLAYER_POSITIONS` order. */
export function asPlayerPositions(raw: unknown): PlayerPosition[] {
  const listed = asArray(raw => {
    if (!PLAYER_POSITIONS.includes(raw as PlayerPosition)) {
      throw new TypeError(`Not a position: ${String(raw)}`)
    }
    return raw as PlayerPosition
  })(raw)
  const chosen = new Set(listed)
  return PLAYER_POSITIONS.filter(position => chosen.has(position))
}

/**
 * What a coach may change about one player on one team. Every field is
 * optional, and only the ones sent change; a body that sends none asks for
 * nothing and is refused.
 *
 * `jersey` and `positions` belong to the player's place on this team; `name`,
 * `bats` and `throws` belong to the player and read the same on every team.
 */
export function asPlayerSettings(raw: unknown): PlayerSettings {
  if (raw == null || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new TypeError('Expected an object')
  }
  // Read by hand rather than through `asOptional`, which takes `null` for
  // "not sent": here `null` is an answer — no number, no hand known.
  const body = raw as Record<string, unknown>
  const sent: PlayerSettings = {}
  if (body.name !== undefined) {
    sent.name = field('name', asPlayerSettingsName, body)
  }
  if (body.jersey !== undefined) sent.jersey = field('jersey', asJersey, body)
  if (body.positions !== undefined) {
    sent.positions = field('positions', asPlayerPositions, body)
  }
  if (body.bats !== undefined) sent.bats = field('bats', asBats, body)
  if (body.throws !== undefined) sent.throws = field('throws', asThrows, body)
  if (Object.keys(sent).length === 0) {
    throw new TypeError('Nothing to change')
  }
  return sent
}

/**
 * What may be changed about a player away from any team: how they bat and
 * throw. `asPlayerSettings` restricted to those two, so a jersey or positions
 * sent here, which only mean something on a team, are refused rather than
 * dropped.
 */
export function asPersonSettings(raw: unknown): PersonSettings {
  if (raw != null && typeof raw === 'object' && !Array.isArray(raw)) {
    const body = raw as Record<string, unknown>
    for (const name of ['jersey', 'positions']) {
      if (body[name] !== undefined) {
        throw new TypeError(`${name}: Set on a team, not here`)
      }
    }
  }
  const { bats, throws } = asPlayerSettings(raw)
  return {
    ...(bats === undefined ? {} : { bats }),
    ...(throws === undefined ? {} : { throws })
  }
}

export type PersonSettings = Pick<PlayerSettings, 'bats' | 'throws'>

/** One field, with its name on the refusal. */
function field<T>(
  name: string,
  cleaner: (raw: unknown) => T,
  body: Record<string, unknown>
): T {
  try {
    return cleaner(body[name])
  } catch (error) {
    const reason = error instanceof Error ? error.message : 'Not valid'
    throw new TypeError(`${name}: ${reason}`)
  }
}

export interface PlayerSettings {
  /** Player-wide name, authorized separately from other settings. */
  name?: { firstName: string; lastName: string }
  jersey?: string | null
  positions?: PlayerPosition[]
  bats?: 'left' | 'right' | 'switch' | null
  throws?: 'left' | 'right' | null
}
