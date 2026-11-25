import { type Kysely, sql } from 'kysely'

import { badRequest, notFound } from '../../common/errors'
import { makeId } from '../../common/ids'
import {
  allocationProblem,
  type CreditNoun,
  type CreditRow,
  NAME_LIMIT
} from '../../common/sponsors/sponsorRules'
import type { SponsorState } from '../../common/sponsors/types'
import { atomic } from '../db/atomic'
import type { Database } from '../db/database'
import { mediaBase, type SpaceSettings } from '../media/spacesHls'

/** A league's credits row, as `creditsFor` reads it. */
export interface LeagueCredits {
  league_id: string
  logo_credits: number
  reel_credits: number
  event_slots: number
  kept_slots: number
  logo_turn: number
  reel_turn: number
}

/**
 * Gives `leagueId` its starting credits — 300 game logos, 1,000 reel
 * broadcasts and 10 event stream slots — unless it already has a row. Run in
 * the transaction that creates the league.
 */
export async function grantStartingCredits(
  db: Kysely<Database>,
  leagueId: string
): Promise<void> {
  await db
    .insertInto('league_sponsor_credits')
    .values({ league_id: leagueId })
    .onConflict(oc => oc.column('league_id').doNothing())
    .execute()
}

/**
 * A league's credits. Leagues are inserted outside `createGroup` too (the
 * fixtures, and any later path), so the row is made with its defaults first
 * when it is missing, and `lock` then always has a row to lock: the
 * transaction holding it is the only one changing the league's sponsor rows.
 */
export async function creditsFor(
  db: Kysely<Database>,
  leagueId: string,
  options: { lock?: boolean } = {}
): Promise<LeagueCredits> {
  await grantStartingCredits(db, leagueId)
  let query = db
    .selectFrom('league_sponsor_credits')
    .selectAll()
    .where('league_id', '=', leagueId)
  if (options.lock === true) query = query.forUpdate()
  return await query.executeTakeFirstOrThrow()
}

/** An object's public address. Sponsor media are `public-read`. */
export function mediaUrl(space: SpaceSettings, key: string): string {
  return `${mediaBase(space)}/${key}`
}

/** Everything the league's sponsor screens show, in one answer. */
export async function sponsorState(
  db: Kysely<Database>,
  space: SpaceSettings,
  leagueId: string
): Promise<SponsorState> {
  const credits = await creditsFor(db, leagueId)
  const logos = await db
    .selectFrom('sponsor_logos')
    .innerJoin('sponsor_media', 'sponsor_media.id', 'sponsor_logos.media_id')
    .select([
      'sponsor_logos.id',
      'sponsor_logos.name',
      'sponsor_logos.allocation',
      'sponsor_logos.used',
      'sponsor_logos.active',
      'sponsor_media.object_key'
    ])
    .where('sponsor_logos.league_id', '=', leagueId)
    .orderBy('sponsor_logos.position')
    .execute()
  const reels = await db
    .selectFrom('sponsor_reels')
    .innerJoin('sponsor_media', 'sponsor_media.id', 'sponsor_reels.media_id')
    .select([
      'sponsor_reels.id',
      'sponsor_reels.name',
      'sponsor_reels.allocation',
      'sponsor_reels.used',
      'sponsor_reels.active',
      'sponsor_reels.duration_ms',
      'sponsor_media.object_key'
    ])
    .where('sponsor_reels.league_id', '=', leagueId)
    .orderBy('sponsor_reels.position')
    .execute()
  const rows = await db
    .selectFrom('sponsor_rows')
    .innerJoin('sponsor_media as logo', 'logo.id', 'sponsor_rows.logo_media_id')
    .innerJoin(
      'sponsor_media as background',
      'background.id',
      'sponsor_rows.background_media_id'
    )
    .select([
      'sponsor_rows.id',
      'sponsor_rows.title',
      'sponsor_rows.message',
      'sponsor_rows.url',
      'sponsor_rows.text_color',
      'sponsor_rows.starts_at',
      'sponsor_rows.placed_at',
      'logo.object_key as logo_key',
      'background.object_key as background_key'
    ])
    .where('sponsor_rows.league_id', '=', leagueId)
    .where('sponsor_rows.deleted_at', 'is', null)
    .orderBy('sponsor_rows.starts_at')
    .orderBy('sponsor_rows.id')
    .execute()
  return {
    totals: {
      logoCredits: credits.logo_credits,
      reelCredits: credits.reel_credits,
      eventSlots: credits.event_slots
    },
    logos: logos.map(logo => ({
      id: logo.id,
      name: logo.name,
      imageUrl: mediaUrl(space, logo.object_key),
      allocation: logo.allocation,
      used: logo.used,
      active: logo.active
    })),
    reels: reels.map(reel => ({
      id: reel.id,
      name: reel.name,
      videoUrl: mediaUrl(space, reel.object_key),
      // No poster is made: the screen draws the reel's own first frame.
      posterUrl: '',
      durationSec: reel.duration_ms / 1000,
      allocation: reel.allocation,
      used: reel.used,
      active: reel.active
    })),
    placements: rows.map(row => ({
      id: row.id,
      logoUrl: mediaUrl(space, row.logo_key),
      backgroundUrl: mediaUrl(space, row.background_key),
      title: row.title,
      message: row.message,
      url: row.url,
      textColor: row.text_color,
      startsAt: row.starts_at.toISOString(),
      placedAt: row.placed_at.toISOString()
    })),
    keptSlots: credits.kept_slots
  }
}

/** Logos and reels: the two kinds of credit row, each on its own table. */
export type CreditKind = 'logo' | 'reel'

const TABLE = { logo: 'sponsor_logos', reel: 'sponsor_reels' } as const
const NOUN: Record<CreditKind, CreditNoun> = {
  logo: 'game logo',
  reel: 'broadcast'
}
const TOTAL = { logo: 'logo_credits', reel: 'reel_credits' } as const

function refuse(problem: string | null): void {
  if (problem != null) throw badRequest(problem)
}

async function creditRows(
  db: Kysely<Database>,
  kind: CreditKind,
  leagueId: string
): Promise<CreditRow[]> {
  return await db
    .selectFrom(TABLE[kind])
    .select(['id', 'name', 'allocation', 'used', 'active'])
    .where('league_id', '=', leagueId)
    .execute()
}

/** The league a logo or reel row belongs to, or a 404. */
export async function creditRowLeague(
  db: Kysely<Database>,
  kind: CreditKind,
  id: string
): Promise<string> {
  const row = await db
    .selectFrom(TABLE[kind])
    .select('league_id')
    .where('id', '=', id)
    .executeTakeFirst()
  if (row == null) throw notFound()
  return row.league_id
}

/**
 * Adds an active logo or reel of the league's own unused upload `mediaId`,
 * after every row the league has accepted, with `allocation` of its credits.
 */
export async function addCreditRow(
  db: Kysely<Database>,
  kind: CreditKind,
  leagueId: string,
  body: { mediaId: string; name: string; allocation: number },
  now: Date
): Promise<string> {
  const name = body.name.trim()
  if (name === '' || Array.from(name).length > NAME_LIMIT)
    throw badRequest(`Enter a name of at most ${NAME_LIMIT} characters.`)
  return await atomic(db, async trx => {
    const credits = await creditsFor(trx, leagueId, { lock: true })
    const media = await trx
      .selectFrom('sponsor_media')
      .select(['id', 'duration_ms'])
      .where('id', '=', body.mediaId)
      .where('league_id', '=', leagueId)
      .where('purpose', '=', kind)
      .executeTakeFirst()
    if (media == null)
      throw badRequest(
        kind === 'logo'
          ? "Upload the logo first; that file isn't one of this league's logos."
          : "Upload the reel first; that file isn't one of this league's reels."
      )
    const taken = await trx
      .selectFrom(TABLE[kind])
      .select('id')
      .where('media_id', '=', media.id)
      .executeTakeFirst()
    if (taken != null)
      throw badRequest(
        kind === 'logo'
          ? 'That logo is already listed.'
          : 'That reel is already listed.'
      )
    refuse(
      allocationProblem(
        await creditRows(trx, kind, leagueId),
        credits[TOTAL[kind]],
        null,
        body.allocation,
        NOUN[kind]
      )
    )
    const { last } = await trx
      .selectFrom(TABLE[kind])
      .select(sql<number>`coalesce(max(position), 0)`.as('last'))
      .where('league_id', '=', leagueId)
      .executeTakeFirstOrThrow()
    const id = makeId(kind === 'logo' ? 'sponsorLogo' : 'sponsorReel')
    const values = {
      id,
      league_id: leagueId,
      media_id: media.id,
      name,
      allocation: body.allocation,
      position: last + 1,
      accepted_at: now
    }
    if (kind === 'logo')
      await trx.insertInto('sponsor_logos').values(values).execute()
    else
      await trx
        .insertInto('sponsor_reels')
        .values({
          ...values,
          // Every reel upload is probed, so it has its length.
          duration_ms: media.duration_ms ?? 0
        })
        .execute()
    return id
  })
}

/** Sets an active row's allocation, within the league's credits. */
export async function setCreditAllocation(
  db: Kysely<Database>,
  kind: CreditKind,
  leagueId: string,
  id: string,
  allocation: number
): Promise<void> {
  await atomic(db, async trx => {
    const credits = await creditsFor(trx, leagueId, { lock: true })
    refuse(
      allocationProblem(
        await creditRows(trx, kind, leagueId),
        credits[TOTAL[kind]],
        id,
        allocation,
        NOUN[kind]
      )
    )
    await trx
      .updateTable(TABLE[kind])
      .set({ allocation })
      .where('id', '=', id)
      .execute()
  })
}

/**
 * Deactivates a row: one with credits used stays, inactive, its allocation
 * still counted; an unused one is deleted, and its allocation returns.
 */
export async function deactivateCreditRow(
  db: Kysely<Database>,
  kind: CreditKind,
  leagueId: string,
  id: string,
  now: Date
): Promise<void> {
  await atomic(db, async trx => {
    await creditsFor(trx, leagueId, { lock: true })
    const row = await trx
      .selectFrom(TABLE[kind])
      .select('used')
      .where('id', '=', id)
      .executeTakeFirstOrThrow()
    if (row.used === 0)
      await trx.deleteFrom(TABLE[kind]).where('id', '=', id).execute()
    else
      await trx
        .updateTable(TABLE[kind])
        .set({ active: false, deactivated_at: now })
        .where('id', '=', id)
        .execute()
  })
}
