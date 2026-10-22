import type { Kysely, Selectable } from 'kysely'

import {
  DEFAULT_EVENT_DURATION_MS,
  eventLocalRange
} from '../../common/eventTime'
import {
  coversGame,
  effectiveAvailability
} from '../../common/fieldAvailability'
import { calendarDateText } from '../../common/groupCreation'
import { asFieldSize, asWeeklyHours, fieldSizeLabel } from '../../common/venues'
import type { Database, GamesTable } from '../db/database'
import { type Clock, realClock } from '../groups/requests'
import { schedulingRecipients } from '../groups/rights'
import { collides, occupancy } from './occupancy'
import { recordNotice } from './venueNotices'
import { venueDefaults } from './venues'

export type FieldWarningKind =
  'conflict' | 'outsideAvailability' | 'fieldDeleted' | 'sizeRemoved'

/** Something wrong with a game's field, said plainly. */
export interface FieldWarning {
  kind: FieldWarningKind
  /** The conflicting game's id; empty for the warnings with no other side. */
  otherRef: string
  message: string
}

type GameRow = Pick<
  Selectable<GamesTable>,
  | 'id'
  | 'field_id'
  | 'field_size'
  | 'status'
  | 'start_at'
  | 'end_at'
  | 'home_team_id'
  | 'away_team_id'
  | 'timezone'
>

interface FieldFacts {
  id: string
  name: string
  venueName: string
  sizes: string[]
  deleted: boolean
  switchMs: number
  availability: ReturnType<typeof effectiveAvailability>
}

async function fieldFacts(
  db: Kysely<Database>,
  fieldIds: string[]
): Promise<Map<string, FieldFacts>> {
  if (fieldIds.length === 0) return new Map()
  const rows = await db
    .selectFrom('venue_fields')
    .innerJoin('venues', 'venues.id', 'venue_fields.venue_id')
    .selectAll('venues')
    .select([
      'venue_fields.id as field_id',
      'venue_fields.name as field_name',
      'venue_fields.sizes',
      'venue_fields.starts_on',
      'venue_fields.ends_on',
      'venue_fields.hours',
      'venue_fields.blackouts',
      'venue_fields.deleted_at'
    ])
    .where('venue_fields.id', 'in', fieldIds)
    .execute()
  return new Map(
    rows.map(row => [
      row.field_id,
      {
        id: row.field_id,
        name: row.field_name,
        venueName: row.name,
        sizes: row.sizes,
        deleted: row.deleted_at != null,
        switchMs: row.size_switch_minutes * 60 * 1000,
        availability: effectiveAvailability(venueDefaults(row), {
          startsOn: calendarDateText(row.starts_on),
          endsOn: calendarDateText(row.ends_on),
          hours: row.hours == null ? null : asWeeklyHours(row.hours),
          blackouts: Array.isArray(row.blackouts)
            ? row.blackouts.map(value => calendarDateText(value)!)
            : []
        })
      }
    ])
  )
}

/** Whether a game is one its warnings still matter for. */
function upcoming(game: GameRow, now: Date): boolean {
  return (
    game.field_id != null &&
    game.status === 'scheduled' &&
    game.start_at.getTime() > now.getTime()
  )
}

/**
 * The warnings of the games asked for: a field deleted, a field that can no
 * longer be set up in the game's size, a field not open then, and other
 * bookings of the field that run into the game. Only upcoming, scheduled
 * games have any.
 */
export async function warningsOf(
  db: Kysely<Database>,
  games: GameRow[],
  clock: Clock = realClock
): Promise<Map<string, FieldWarning[]>> {
  const now = clock.now()
  const live = games.filter(game => upcoming(game, now))
  const fieldIds = [...new Set(live.map(game => game.field_id!))]
  const facts = await fieldFacts(db, fieldIds)
  const bookings = await occupancy(db, { fieldIds, from: now }, clock)
  const result = new Map<string, FieldWarning[]>(
    games.map(game => [game.id, []])
  )
  for (const game of live) {
    const field = facts.get(game.field_id!)
    if (field == null) continue
    const where = `${field.name} at ${field.venueName}`
    const warnings = result.get(game.id)!
    if (field.deleted) {
      warnings.push({
        kind: 'fieldDeleted',
        otherRef: '',
        message: `${where} was deleted. Choose another field for this game.`
      })
      continue
    }
    if (game.field_size != null && !field.sizes.includes(game.field_size))
      warnings.push({
        kind: 'sizeRemoved',
        otherRef: '',
        message: `${where} can no longer be set up as ${fieldSizeLabel(asFieldSize(game.field_size))}. Choose another field or size for this game.`
      })
    const start = game.start_at.getTime()
    const end = game.end_at?.getTime() ?? start + DEFAULT_EVENT_DURATION_MS
    if (
      !coversGame(
        field.availability,
        new Date(start).toISOString(),
        new Date(end).toISOString()
      )
    )
      warnings.push({
        kind: 'outsideAvailability',
        otherRef: '',
        message: `${where} is not open for all of this game.`
      })
    for (const other of bookings) {
      if (other.key === game.id || other.fieldId !== game.field_id) continue
      const mine = { start, end, size: game.field_size }
      if (!collides(mine, other, field.switchMs)) continue
      const overlap = collides(mine, other, 0)
      warnings.push({
        kind: 'conflict',
        otherRef: other.key,
        message: overlap
          ? `Another game is booked on ${where} at the same time.`
          : `Another game on ${where} is too close to this one to change the field’s size.`
      })
    }
  }
  return result
}

const GAME_COLUMNS = [
  'id',
  'field_id',
  'field_size',
  'status',
  'start_at',
  'end_at',
  'home_team_id',
  'away_team_id',
  'timezone'
] as const

/** One game's warnings, for its page. */
export async function gameFieldWarnings(
  db: Kysely<Database>,
  gameId: string,
  clock: Clock = realClock
): Promise<FieldWarning[]> {
  const game = await db
    .selectFrom('games')
    .select([...GAME_COLUMNS])
    .where('id', '=', gameId)
    .executeTakeFirst()
  if (game == null) return []
  return (await warningsOf(db, [game], clock)).get(game.id) ?? []
}

/**
 * Brings the announced warnings of the games on these fields, and of any
 * other games named, up to date: a new warning is told to the staff of
 * both teams once, and a warning that has cleared is forgotten, so it is
 * told again if it comes back. Runs in the transaction of the write that
 * changed the field or its games.
 */
export async function refreshFieldWarnings(
  db: Kysely<Database>,
  fieldIds: Array<string | null | undefined>,
  clock: Clock = realClock,
  gameIds: string[] = []
): Promise<void> {
  const fields = [...new Set(fieldIds.filter((id): id is string => id != null))]
  if (fields.length === 0 && gameIds.length === 0) return
  // The fields' upcoming games, the ones still holding a warning told
  // before (so it is forgotten once they are past), and the games named.
  const games = await db
    .selectFrom('games')
    .select([...GAME_COLUMNS])
    .where(eb =>
      eb.or([
        ...(fields.length === 0
          ? []
          : [
              eb.and([
                eb('field_id', 'in', fields),
                eb.or([
                  eb.and([
                    eb('status', '=', 'scheduled'),
                    eb('start_at', '>', clock.now())
                  ]),
                  eb(
                    'id',
                    'in',
                    eb.selectFrom('game_field_warnings').select('game_id')
                  )
                ])
              ])
            ]),
        ...(gameIds.length === 0 ? [] : [eb('id', 'in', gameIds)])
      ])
    )
    .execute()
  if (games.length === 0) return
  const current = await warningsOf(db, games, clock)
  const told = await db
    .selectFrom('game_field_warnings')
    .selectAll()
    .where(
      'game_id',
      'in',
      games.map(game => game.id)
    )
    .execute()
  const names = new Map(
    (
      await db
        .selectFrom('teams')
        .select(['id', 'name'])
        .where('id', 'in', [
          ...new Set(
            games.flatMap(game => [game.home_team_id, game.away_team_id])
          )
        ])
        .execute()
    ).map(team => [team.id, team.name])
  )
  for (const game of games) {
    const warnings = current.get(game.id) ?? []
    const key = (kind: string, ref: string): string => `${kind}\u0000${ref}`
    const wanted = new Set(warnings.map(w => key(w.kind, w.otherRef)))
    const had = told.filter(row => row.game_id === game.id)
    for (const row of had)
      if (!wanted.has(key(row.kind, row.other_ref)))
        await db
          .deleteFrom('game_field_warnings')
          .where('game_id', '=', row.game_id)
          .where('kind', '=', row.kind)
          .where('other_ref', '=', row.other_ref)
          .execute()
    const known = new Set(had.map(row => key(row.kind, row.other_ref)))
    for (const warning of warnings) {
      if (known.has(key(warning.kind, warning.otherRef))) continue
      await db
        .insertInto('game_field_warnings')
        .values({
          game_id: game.id,
          kind: warning.kind,
          other_ref: warning.otherRef
        })
        .onConflict(oc =>
          oc.columns(['game_id', 'kind', 'other_ref']).doNothing()
        )
        .execute()
      await recordNotice(db, {
        type: 'fieldWarning',
        actorId: null,
        recipients: await schedulingRecipients(db, [
          { kind: 'team', id: game.home_team_id },
          { kind: 'team', id: game.away_team_id }
        ]),
        title: `Field warning: ${names.get(game.away_team_id) ?? 'Away'} at ${names.get(game.home_team_id) ?? 'Home'}`,
        description: `${warning.message} ${eventLocalRange(
          game.start_at.toISOString(),
          game.end_at?.toISOString(),
          game.timezone
        )}.`,
        metadata: { gameId: game.id, kind: warning.kind }
      })
    }
  }
}
