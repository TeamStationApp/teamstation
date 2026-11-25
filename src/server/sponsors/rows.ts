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
import type { SponsoredTextColor } from '../../common/sponsors/types'
import { atomic } from '../db/atomic'
import type { Database } from '../db/database'
import { creditsFor } from './credits'

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
