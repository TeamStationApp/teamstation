import {
  asArray,
  asBoolean,
  asNumber,
  asObject,
  asOptional,
  asString
} from 'cleaners'

import { asLiteral } from './asLiteral'
import {
  asEventLocationFields,
  type EventLocationFields,
  withEventMetadata
} from './eventInfo'
import {
  asCalendarDate,
  asGroupRef,
  type GroupRef,
  isRecord
} from './groupCreation'
import { asSwapEffect } from './scoring/playsLost'
import { asFieldSizeChoice } from './venues'
const nullableText = (raw: unknown): string | null =>
  raw == null ? null : asString(raw)
/** A missing key stays missing; `null` stays `null`, which clears the field. */
const fieldKey = (raw: unknown): string | null | undefined =>
  raw === undefined ? undefined : raw === null ? null : asString(raw)
const asGameIntentBase = withEventMetadata(
  asObject({
    homeTeamId: asString,
    awayTeamId: asString,
    seasonId: nullableText,
    startAt: asString,
    venue: nullableText,
    outsideTournament: nullableText,
    exhibition: asOptional(asBoolean, false),
    timezone: asOptional(asString, 'UTC'),
    status: asLiteral('scheduled', 'cancelled')
  })
)
/** A game as the API carries it, with its field when it has one. */
export function asGameIntent(raw: unknown): ReturnType<
  typeof asGameIntentBase
> & {
  fieldId?: string | null
  fieldSize?: string | null
} {
  const game = asGameIntentBase(raw)
  if (!isRecord(raw)) return game
  const fieldId = fieldKey(raw.fieldId)
  const fieldSize = fieldKey(raw.fieldSize)
  return {
    ...game,
    ...(fieldId === undefined ? {} : { fieldId }),
    ...(fieldSize === undefined ? {} : { fieldSize })
  }
}
const asGameSchedulingBase = asObject({
  game: asGameIntent,
  version: asString,
  canPropose: asBoolean,
  withdrawTeamIds: asArray(asString),
  administeredTeamIds: asOptional(asArray(asString), () => []),
  /** Whether the caller may swap home and away at once. Older servers: no. */
  canSwap: asOptional(asBoolean, false),
  /** What a swap's reset would delete, and the plays it would confirm. */
  plays: asOptional(
    asObject({
      atBats: asNumber,
      innings: asNumber,
      playsDigest: asString,
      generation: asNumber,
      /** Whether a swap resets the game. Older servers: when it loses at-bats. */
      resets: asOptional(asBoolean),
      /** What a swap would do (`swapEffect`). Older servers send none. */
      swap: asSwapEffect
    })
  )
})
const asGameFieldSummary = asObject({
  venueId: asString,
  venueName: asString,
  fieldId: asString,
  fieldName: asString,
  size: asString,
  address: asString
})
/** A game's registry field, as its form names it. */
export type GameFieldSummary = ReturnType<typeof asGameFieldSummary>
/** A game's scheduling state, with its field when it has one. */
export function asGameScheduling(raw: unknown): ReturnType<
  typeof asGameSchedulingBase
> & {
  field?: GameFieldSummary | null
} {
  const scheduling = asGameSchedulingBase(raw)
  if (!isRecord(raw) || raw.field === undefined) return scheduling
  return {
    ...scheduling,
    field: raw.field === null ? null : asGameFieldSummary(raw.field)
  }
}
export const asGameScheduleProposal = asObject({
  requestId: asString,
  gameId: nullableText,
  game: asGameIntent,
  previous: (value: unknown): GameIntent | null =>
    value == null ? null : asGameIntent(value),
  status: asString,
  sentAt: asString,
  canDelete: asBoolean,
  version: nullableText
})
export type GameScheduleProposal = ReturnType<typeof asGameScheduleProposal>

export interface GameIntent extends EventLocationFields {
  homeTeamId: string
  awayTeamId: string
  seasonId: string | null
  startAt: string
  venue: string | null
  outsideTournament: string | null
  exhibition?: boolean
  timezone?: string
  status: 'scheduled' | 'cancelled'
  /**
   * The registry field the game is on, and the size it is set up in. Left
   * out, an edit keeps the game's field; `null` clears it.
   */
  fieldId?: string | null
  fieldSize?: string | null
}
export interface GameProposal {
  sender: GroupRef
  game: GameIntent
  gameId?: string
  expected?: string
  initiatingTeamId?: string
  idempotencyKey: string
}
export interface GameRequestTerms {
  kind: 'game'
  game: GameIntent
  affectedTeamIds: string[]
  hostSeasonIds: string[]
  gameId: string | null
  expected: string | null
  previous: GameIntent | null
  /** Only the proposed participants give game consent. Other IDs are projections. */
  consentTeamIds?: string[]
  /** Reserved before publication, so pending new events keep one identity. */
  proposedGameId?: string
  replacesGameId?: string | null
  hostingAuthorizerUserId?: string
  hostingAuthorizationSource?: 'initiator' | 'legacyReceipt'
  /**
   * The Auto-Scheduler preview that proposed this game. Set only by the
   * server when it publishes a preview; a client can't send it.
   */
  schedulePreviewId?: string
  /**
   * A scorekeeper's swap of home and away, accepted as it was sent, with no
   * scheduling authority asked for. Set only by the server; a client can't
   * send it.
   */
  scorerSwap?: true
}

export function asGameTimezone(raw: unknown): string {
  if (typeof raw !== 'string' || raw.length > 100 || raw.length === 0)
    throw new TypeError('Choose a valid timezone')
  try {
    new Intl.DateTimeFormat('en', { timeZone: raw }).format()
  } catch {
    throw new TypeError('Choose a valid timezone')
  }
  return raw
}
const requiredId = (value: unknown): string => {
  if (typeof value !== 'string' || value.length < 1 || value.length > 100)
    throw new TypeError('Choose a valid team or season')
  return value
}
const optionalText = (value: unknown, label: string): string | null => {
  if (value == null || value === '') return null
  if (typeof value !== 'string' || value.trim().length > 200)
    throw new TypeError(`${label} must be at most 200 characters`)
  return value.trim()
}
export function asGameProposal(raw: unknown): GameProposal {
  if (!isRecord(raw) || !isRecord(raw.game))
    throw new TypeError('Enter game details')
  const sender = asGroupRef(raw.sender)
  if (sender.kind === 'league')
    throw new TypeError('Choose the season that hosts this game')
  const homeTeamId = requiredId(raw.game.homeTeamId)
  const awayTeamId = requiredId(raw.game.awayTeamId)
  if (homeTeamId === awayTeamId)
    throw new TypeError('Choose two different teams')
  if (
    typeof raw.game.startAt !== 'string' ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}.*(Z|[+-]\d{2}:\d{2})$/.test(
      raw.game.startAt
    ) ||
    !Number.isFinite(new Date(raw.game.startAt).getTime())
  )
    throw new TypeError('Choose a valid date, time and timezone')
  asCalendarDate(raw.game.startAt.slice(0, 10))
  if (raw.game.seasonId === undefined)
    throw new TypeError('Choose a season or explicitly select an outside game')
  if (
    typeof raw.idempotencyKey !== 'string' ||
    raw.idempotencyKey.length < 8 ||
    raw.idempotencyKey.length > 120
  )
    throw new TypeError('Sending needs a retry key')
  const seasonId =
    raw.game.seasonId == null ? null : requiredId(raw.game.seasonId)
  const outsideTournament = optionalText(
    raw.game.outsideTournament,
    'Outside tournament label'
  )
  if (seasonId != null && outsideTournament != null)
    throw new TypeError(
      'Outside tournament labels belong to games outside TeamStation seasons'
    )
  if (
    raw.game.status != null &&
    raw.game.status !== 'scheduled' &&
    raw.game.status !== 'cancelled'
  )
    throw new TypeError('Choose scheduled or cancelled')
  if (raw.game.exhibition != null && typeof raw.game.exhibition !== 'boolean')
    throw new TypeError('Exhibition must be true or false')
  const fieldId = raw.game.fieldId
  if (fieldId !== undefined && fieldId !== null && typeof fieldId !== 'string')
    throw new TypeError('Choose a field')
  const fieldSize =
    raw.game.fieldSize === undefined || raw.game.fieldSize === null
      ? raw.game.fieldSize
      : asFieldSizeChoice(raw.game.fieldSize)
  if (fieldId === null && fieldSize != null)
    throw new TypeError('A field size needs a field')
  const result: GameProposal = {
    sender,
    game: {
      ...asEventLocationFields(raw.game, raw.game.startAt),
      homeTeamId,
      awayTeamId,
      seasonId,
      startAt: new Date(raw.game.startAt).toISOString(),
      venue: optionalText(raw.game.venue, 'Venue'),
      outsideTournament,
      status: raw.game.status === 'cancelled' ? 'cancelled' : 'scheduled',
      ...(raw.game.exhibition == null
        ? {}
        : { exhibition: raw.game.exhibition }),
      ...(raw.game.timezone == null
        ? {}
        : { timezone: asGameTimezone(raw.game.timezone) }),
      ...(fieldId === undefined ? {} : { fieldId }),
      ...(fieldSize === undefined
        ? fieldId === null
          ? { fieldSize: null }
          : {}
        : { fieldSize })
    },
    idempotencyKey: raw.idempotencyKey
  }
  if (raw.gameId != null) {
    result.gameId = requiredId(raw.gameId)
    if (
      typeof raw.expected !== 'string' ||
      !/^[a-f0-9]{64}$/.test(raw.expected)
    )
      throw new TypeError('Review the current game before proposing a change')
    result.expected = raw.expected
  }
  if (raw.initiatingTeamId != null)
    result.initiatingTeamId = requiredId(raw.initiatingTeamId)
  return result
}

/**
 * Cancellations the system made: a team's withdrawal, a game replaced by a
 * change that dropped a team, and a game the Auto-Scheduler took away when
 * it rescheduled. Nothing sets such a game back to scheduled, so its
 * matchup can't be duplicated.
 */
export const SYSTEM_CANCELLATIONS = [
  'withdrawal',
  'replacement',
  'rescheduled'
] as const

export function systemCancelled(reason: string | null | undefined): boolean {
  return (SYSTEM_CANCELLATIONS as readonly string[]).includes(reason ?? '')
}
