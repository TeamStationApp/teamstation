import {
  asArray,
  asBoolean,
  asEither,
  asNull,
  asNumber,
  asObject,
  asOptional,
  asString
} from 'cleaners'

import { asLiteral } from './asLiteral'
import type { PlannedGame, ScheduleOption } from './autoScheduler/types'
import { isRecord } from './groupCreation'
import { asFieldSize, type FieldSize } from './venues'

/** What happens to a season's upcoming games when a schedule is built. */
export type ExistingGames = 'replace' | 'workAround'

/** What a build asks for. */
export interface PreviewRequest {
  mode: 'full' | 'partial'
  existing?: ExistingGames
  /** A partial build's teams: only their games are placed again. */
  teamIds?: string[]
  /** Recalculating an open preview's option after rejecting or adding games. */
  fromPreviewId?: string
  option?: number
}

function asIds(raw: unknown, what: string): string[] {
  if (
    !Array.isArray(raw) ||
    raw.length > 200 ||
    raw.some(id => typeof id !== 'string' || id === '')
  )
    throw new TypeError(`Choose the ${what}`)
  return [...new Set(raw as string[])]
}

function asOptionIndex(raw: unknown): number {
  if (typeof raw !== 'number' || !Number.isInteger(raw) || raw < 0 || raw > 2)
    throw new TypeError('Choose an option')
  return raw
}

export function asPreviewRequest(raw: unknown): PreviewRequest {
  if (!isRecord(raw)) throw new TypeError('Choose how to build the schedule')
  if (raw.mode !== 'full' && raw.mode !== 'partial')
    throw new TypeError('Choose a full or a partial build')
  if (
    raw.existing !== undefined &&
    raw.existing !== 'replace' &&
    raw.existing !== 'workAround'
  )
    throw new TypeError('Choose to replace or work around existing games')
  const request: PreviewRequest = { mode: raw.mode }
  if (raw.existing !== undefined) request.existing = raw.existing
  if (raw.teamIds !== undefined) {
    if (raw.mode !== 'partial')
      throw new TypeError('Only a partial build names its teams')
    request.teamIds = asIds(raw.teamIds, 'teams')
  }
  if (raw.fromPreviewId !== undefined) {
    if (typeof raw.fromPreviewId !== 'string' || raw.fromPreviewId === '')
      throw new TypeError('Choose the preview to recalculate')
    request.fromPreviewId = raw.fromPreviewId
    request.option = asOptionIndex(raw.option)
  }
  if (
    request.mode === 'partial' &&
    request.teamIds == null &&
    request.fromPreviewId == null
  )
    throw new TypeError('Choose the teams to schedule again')
  return request
}

/** A game an admin adds to a preview by hand. */
export interface AddedGame {
  seasonId: string
  homeTeamId: string
  awayTeamId: string
  exhibition: boolean
  fieldId: string
  size: FieldSize
  startAt: string
  endAt: string
}

function asInstant(raw: unknown, what: string): string {
  if (typeof raw !== 'string' || !Number.isFinite(Date.parse(raw)))
    throw new TypeError(`Choose ${what}`)
  return new Date(raw).toISOString()
}

export function asAddedGame(raw: unknown): AddedGame {
  if (!isRecord(raw)) throw new TypeError('Choose the game to add')
  const text = (value: unknown, what: string): string => {
    if (typeof value !== 'string' || value === '')
      throw new TypeError(`Choose ${what}`)
    return value
  }
  const game: AddedGame = {
    seasonId: text(raw.seasonId, 'a season'),
    homeTeamId: text(raw.homeTeamId, 'the home team'),
    awayTeamId: text(raw.awayTeamId, 'the away team'),
    exhibition: raw.exhibition === true,
    fieldId: text(raw.fieldId, 'a field'),
    size: (() => {
      try {
        return asFieldSize(raw.size)
      } catch {
        throw new TypeError('Choose a field size')
      }
    })(),
    startAt: asInstant(raw.startAt, 'a start'),
    endAt: asInstant(raw.endAt, 'an end')
  }
  if (game.homeTeamId === game.awayTeamId)
    throw new TypeError('Choose two different teams')
  if (Date.parse(game.endAt) <= Date.parse(game.startAt))
    throw new TypeError('The game must end after it starts')
  if (new Date(game.startAt).getUTCMinutes() % 5 !== 0)
    throw new TypeError('Start games on a 5-minute step')
  return game
}

/** The edits made to one option of a preview. */
export interface PreviewEdits {
  option: number
  rejectedGameKeys: string[]
  addedGames: Array<AddedGame & { key: string }>
}

export function asPreviewEditsBody(raw: unknown): {
  option: number
  rejectedGameKeys: string[]
  addedGames: AddedGame[]
} {
  if (!isRecord(raw)) throw new TypeError('Choose the changes to the preview')
  if (raw.addedGames !== undefined && !Array.isArray(raw.addedGames))
    throw new TypeError('Choose the games to add')
  const added = (raw.addedGames ?? []) as unknown[]
  if (added.length > 50) throw new TypeError('Add at most 50 games at once')
  return {
    option: asOptionIndex(raw.option),
    rejectedGameKeys:
      raw.rejectedGameKeys === undefined
        ? []
        : asIds(raw.rejectedGameKeys, 'games to reject'),
    addedGames: added.map(asAddedGame)
  }
}

const asWirePlannedGame = asObject({
  key: asString,
  seasonId: asString,
  homeTeamId: asString,
  awayTeamId: asString,
  exhibition: asBoolean,
  fieldId: asString,
  size: asFieldSize,
  startAt: asString,
  endAt: asString
})

const asNullableNumber = asEither(asNull, asNumber)

const asWireOption = asObject({
  games: asArray(asWirePlannedGame),
  fairness: asArray(
    asObject({
      teamId: asString,
      seasonId: asString,
      exhibitionTeam: asBoolean,
      regularGames: asNumber,
      exhibitionGames: asNumber,
      mornings: asNumber,
      afternoons: asNumber,
      evenings: asNumber,
      weekdays: asArray(asNumber),
      shortestGapDays: asNullableNumber,
      longestGapDays: asNullableNumber,
      doubleheaders: asNumber
    })
  ),
  reasons: asArray(asString),
  unmet: asArray(
    asObject({ seasonId: asString, message: asString, cause: asString })
  ),
  score: asArray(asNumber)
})

/** Where one published game stands. */
export type PublishedState =
  'scheduled' | 'awaiting' | 'needsRescheduling' | 'rejected' | 'resolved'

export const asSchedulePreview = asObject({
  id: asString,
  leagueId: asString,
  mode: asLiteral('full', 'partial'),
  existing: asEither(asNull, asLiteral('replace', 'workAround')),
  status: asLiteral('open', 'published', 'discarded'),
  createdAt: asString,
  options: asArray(asWireOption),
  blocking: asEither(asNull, asString),
  edits: asObject({
    option: asNumber,
    rejectedGameKeys: asArray(asString),
    addedGames: asArray(asWirePlannedGame)
  }),
  /** Upcoming games this build replaces when it is published. */
  replacing: asNumber,
  publishedOption: asEither(asNull, asNumber),
  publishedAt: asEither(asNull, asString),
  /** Each published game's state, by its key. */
  published: asOptional(
    asArray(
      asObject({
        gameKey: asString,
        gameId: asEither(asNull, asString),
        state: asLiteral(
          'scheduled',
          'awaiting',
          'needsRescheduling',
          'rejected',
          'resolved'
        )
      })
    ),
    []
  ),
  teams: asArray(asObject({ id: asString, name: asString })),
  seasons: asArray(
    asObject({
      id: asString,
      name: asString,
      timezone: asString,
      gameMinutes: asNumber,
      /**
       * The season's first day, `YYYY-MM-DD`. Optional, so an answer from a
       * server that does not send it yet still reads; the weeks then count
       * from the first game.
       */
      startsOn: asOptional(asString),
      participants: asArray(asString),
      exhibitionTeams: asArray(asString)
    })
  ),
  fields: asArray(
    asObject({
      id: asString,
      name: asString,
      venueName: asString,
      sizes: asArray(asFieldSize),
      /** The field's zone: its games are placed and read in its local time. */
      timezone: asString
    })
  )
})
export type SchedulePreview = ReturnType<typeof asSchedulePreview>

/**
 * An option's games as they stand after its edits: its own games less the
 * rejected ones, and the added games, in start order.
 */
export function editedGames(
  option: Pick<ScheduleOption, 'games'>,
  edits: {
    option: number
    rejectedGameKeys: string[]
    addedGames: PlannedGame[]
  },
  index: number
): PlannedGame[] {
  if (edits.option !== index) return option.games
  return [
    ...option.games.filter(game => !edits.rejectedGameKeys.includes(game.key)),
    ...edits.addedGames
  ].sort((a, b) =>
    a.startAt === b.startAt
      ? a.key.localeCompare(b.key)
      : a.startAt.localeCompare(b.startAt)
  )
}

/** A publication's outcome. */
export const asPublication = asObject({
  preview: asSchedulePreview,
  /** Games on the schedule at once. */
  scheduled: asNumber,
  /** Games waiting for a team's approval. */
  awaiting: asNumber,
  /** Upcoming games the build replaced. */
  removed: asNumber
})
export type Publication = ReturnType<typeof asPublication>

/** Why a published game is listed for rescheduling. */
export type RescheduleReason =
  | 'declined'
  | 'withdrawn'
  | 'expired'
  | 'cancelled'
  | 'teamWithdrew'
  | 'rejected'

export const asGameToReschedule = asObject({
  previewId: asString,
  gameKey: asString,
  gameId: asEither(asNull, asString),
  seasonId: asString,
  homeTeamId: asString,
  awayTeamId: asString,
  homeTeamName: asString,
  awayTeamName: asString,
  startAt: asString,
  endAt: asEither(asNull, asString),
  timezone: asString,
  exhibition: asBoolean,
  /** The field it was on, if any. */
  fieldId: asEither(asNull, asString),
  reason: asLiteral(
    'declined',
    'withdrawn',
    'expired',
    'cancelled',
    'teamWithdrew',
    'rejected'
  )
})
export type GameToReschedule = ReturnType<typeof asGameToReschedule>

export function rescheduleReasonLabel(reason: RescheduleReason): string {
  return reason === 'declined'
    ? 'Declined'
    : reason === 'withdrawn'
      ? 'Withdrawn'
      : reason === 'expired'
        ? 'Not answered in time'
        : reason === 'cancelled'
          ? 'Canceled'
          : reason === 'teamWithdrew'
            ? 'A team withdrew'
            : 'Rejected'
}
