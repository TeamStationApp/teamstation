import type { Kysely } from 'kysely'

import { badRequest, notFound } from '../../common/errors'
import { makeId } from '../../common/ids'
import {
  canEditPlacement,
  messageProblem,
  startsAtProblem,
  titleProblem,
  urlProblem
} from '../../common/sponsors/sponsorRules'
import type {
  SponsoredRow,
  SponsoredTextColor
} from '../../common/sponsors/types'
import type { VisibleScopes } from '../access'
import { atomic } from '../db/atomic'
import type { Database } from '../db/database'
import type { SpaceSettings } from '../media/spacesHls'
import { creditsFor, mediaUrl } from './credits'

/** A sponsored row as the admin sends it. */
export interface SponsorRowBody {
  logoMediaId: string
  backgroundMediaId: string
  title: string
  message: string
  url: string
  textColor: SponsoredTextColor
  startsAt: string
}

/** The sentence a row that has passed its 24 hours is refused with. */
export const ROW_EDIT_CLOSED =
  'This placement is more than 24 hours old; it can only be deleted.'

/** Every field's sentence, together, or nothing. */
function checkFields(
  row: Pick<SponsorRowBody, 'title' | 'message' | 'url' | 'startsAt'>
): void {
  const problems = [
    titleProblem(row.title),
    messageProblem(row.message),
    urlProblem(row.url),
    startsAtProblem(row.startsAt)
  ].filter(problem => problem != null)
  if (problems.length > 0) throw badRequest(problems.join(' '))
}

/** Refuses an upload that is not the league's own, of `purpose`. */
async function checkMedia(
  db: Kysely<Database>,
  leagueId: string,
  mediaId: string,
  purpose: 'rowLogo' | 'rowBackground'
): Promise<void> {
  const media = await db
    .selectFrom('sponsor_media')
    .select('id')
    .where('id', '=', mediaId)
    .where('league_id', '=', leagueId)
    .where('purpose', '=', purpose)
    .executeTakeFirst()
  if (media == null)
    throw badRequest(
      purpose === 'rowLogo'
        ? "Upload the row's logo first; that file isn't one of this league's."
        : "Upload the row's background first; that file isn't one of this league's."
    )
}

/** Slots the league has left: its total, less listed rows and kept slots. */
async function slotsLeft(
  db: Kysely<Database>,
  leagueId: string,
  credits: { event_slots: number; kept_slots: number }
): Promise<number> {
  const { listed } = await db
    .selectFrom('sponsor_rows')
    .select(eb => eb.fn.countAll<number>().as('listed'))
    .where('league_id', '=', leagueId)
    .where('deleted_at', 'is', null)
    .executeTakeFirstOrThrow()
  return credits.event_slots - Number(listed) - credits.kept_slots
}

/** Places a row in the league's event stream, using one slot. */
export async function addSponsorRow(
  db: Kysely<Database>,
  leagueId: string,
  body: SponsorRowBody,
  now: Date
): Promise<string> {
  checkFields(body)
  return await atomic(db, async trx => {
    const credits = await creditsFor(trx, leagueId, { lock: true })
    if ((await slotsLeft(trx, leagueId, credits)) <= 0)
      throw badRequest('All event stream slots are used.')
    await checkMedia(trx, leagueId, body.logoMediaId, 'rowLogo')
    await checkMedia(trx, leagueId, body.backgroundMediaId, 'rowBackground')
    const id = makeId('sponsorRow')
    await trx
      .insertInto('sponsor_rows')
      .values({
        id,
        league_id: leagueId,
        logo_media_id: body.logoMediaId,
        background_media_id: body.backgroundMediaId,
        title: body.title,
        message: body.message,
        url: body.url,
        text_color: body.textColor,
        starts_at: new Date(body.startsAt),
        placed_at: now
      })
      .execute()
    return id
  })
}

/** The league a listed row belongs to, or a 404. */
export async function sponsorRowLeague(
  db: Kysely<Database>,
  rowId: string
): Promise<string> {
  const row = await db
    .selectFrom('sponsor_rows')
    .select('league_id')
    .where('id', '=', rowId)
    .where('deleted_at', 'is', null)
    .executeTakeFirst()
  if (row == null) throw notFound()
  return row.league_id
}

interface ListedRow {
  title: string
  message: string
  url: string
  starts_at: Date
  placed_at: Date
  logo_media_id: string
  background_media_id: string
  text_color: SponsoredTextColor
}

/** A listed row, locked for the change, or a 404. */
async function listedRow(
  db: Kysely<Database>,
  rowId: string
): Promise<ListedRow> {
  const row = await db
    .selectFrom('sponsor_rows')
    .select([
      'title',
      'message',
      'url',
      'starts_at',
      'placed_at',
      'logo_media_id',
      'background_media_id',
      'text_color'
    ])
    .where('id', '=', rowId)
    .where('deleted_at', 'is', null)
    .forUpdate()
    .executeTakeFirst()
  if (row == null) throw notFound()
  return row
}

/**
 * Changes any of a row's fields, only within 24 hours of placing it. A media
 * id left out keeps the row's current picture.
 */
export async function editSponsorRow(
  db: Kysely<Database>,
  leagueId: string,
  rowId: string,
  patch: Partial<SponsorRowBody>,
  now: Date
): Promise<void> {
  await atomic(db, async trx => {
    await creditsFor(trx, leagueId, { lock: true })
    const row = await listedRow(trx, rowId)
    if (!canEditPlacement({ placedAt: row.placed_at.toISOString() }, now))
      throw badRequest(ROW_EDIT_CLOSED)
    const next = {
      title: patch.title ?? row.title,
      message: patch.message ?? row.message,
      url: patch.url ?? row.url,
      startsAt: patch.startsAt ?? row.starts_at.toISOString()
    }
    checkFields(next)
    if (patch.logoMediaId != null)
      await checkMedia(trx, leagueId, patch.logoMediaId, 'rowLogo')
    if (patch.backgroundMediaId != null)
      await checkMedia(trx, leagueId, patch.backgroundMediaId, 'rowBackground')
    await trx
      .updateTable('sponsor_rows')
      .set({
        title: next.title,
        message: next.message,
        url: next.url,
        starts_at: new Date(next.startsAt),
        text_color: patch.textColor ?? row.text_color,
        logo_media_id: patch.logoMediaId ?? row.logo_media_id,
        background_media_id: patch.backgroundMediaId ?? row.background_media_id
      })
      .where('id', '=', rowId)
      .execute()
  })
}

/**
 * Deletes a row. Within 24 hours of placing it the slot returns; after that
 * the slot stays used, counted in `kept_slots`.
 */
export async function deleteSponsorRow(
  db: Kysely<Database>,
  leagueId: string,
  rowId: string,
  now: Date
): Promise<void> {
  await atomic(db, async trx => {
    await creditsFor(trx, leagueId, { lock: true })
    const row = await listedRow(trx, rowId)
    await trx
      .updateTable('sponsor_rows')
      .set({ deleted_at: now })
      .where('id', '=', rowId)
      .execute()
    if (!canEditPlacement({ placedAt: row.placed_at.toISOString() }, now))
      await trx
        .updateTable('league_sponsor_credits')
        .set(eb => ({ kept_slots: eb('kept_slots', '+', 1) }))
        .where('league_id', '=', leagueId)
        .execute()
  })
}

/** Every team a season holds, whether or not it still plays in it. */
export async function seasonTeamIds(
  db: Kysely<Database>,
  seasonId: string
): Promise<string[]> {
  const rows = await db
    .selectFrom('season_teams')
    .select('team_id')
    .where('season_id', '=', seasonId)
    .execute()
  return rows.map(row => row.team_id)
}

/**
 * The teams whose games a person's own Schedule reads, as `GET /events`
 * filters it with `visibleGamesWhere`: their teams, and every team of their
 * seasons. `null` for a site administrator, whose Schedule reads every game.
 */
export async function scheduleTeamIds(
  db: Kysely<Database>,
  scopes: VisibleScopes
): Promise<string[] | null> {
  if (scopes.isAdmin) return null
  const seasonIds = [...scopes.seasonIds]
  const seasons =
    seasonIds.length === 0
      ? []
      : await db
          .selectFrom('season_teams')
          .select('team_id')
          .where('season_id', 'in', seasonIds)
          .execute()
  return [...new Set([...scopes.teamIds, ...seasons.map(row => row.team_id)])]
}

/**
 * The live sponsored rows of every league that manages one of `teamIds`
 * (`teams.league_id`), by start; every league's for `null`. A team in no
 * league brings none.
 */
export async function sponsoredRowsFor(
  db: Kysely<Database>,
  space: SpaceSettings,
  teamIds: readonly string[] | null
): Promise<SponsoredRow[]> {
  if (teamIds?.length === 0) return []
  let query = db
    .selectFrom('sponsor_rows')
    .innerJoin('sponsor_media as logo', 'logo.id', 'sponsor_rows.logo_media_id')
    .innerJoin(
      'sponsor_media as background',
      'background.id',
      'sponsor_rows.background_media_id'
    )
    .select([
      'sponsor_rows.id',
      'sponsor_rows.league_id',
      'sponsor_rows.title',
      'sponsor_rows.message',
      'sponsor_rows.url',
      'sponsor_rows.text_color',
      'sponsor_rows.starts_at',
      'logo.object_key as logo_key',
      'background.object_key as background_key'
    ])
    .where('sponsor_rows.deleted_at', 'is', null)
  if (teamIds != null) {
    const ids = [...teamIds]
    query = query.where('sponsor_rows.league_id', 'in', eb =>
      eb
        .selectFrom('teams')
        .select('teams.league_id')
        .where('teams.id', 'in', ids)
        .where('teams.league_id', 'is not', null)
    )
  }
  const rows = await query
    .orderBy('sponsor_rows.starts_at')
    .orderBy('sponsor_rows.id')
    .execute()
  return rows.map(row => ({
    id: row.id,
    leagueId: row.league_id,
    logoUrl: mediaUrl(space, row.logo_key),
    backgroundUrl: mediaUrl(space, row.background_key),
    title: row.title,
    message: row.message,
    url: row.url,
    textColor: row.text_color,
    startsAt: row.starts_at.toISOString()
  }))
}
