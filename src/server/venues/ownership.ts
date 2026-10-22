import type { Kysely, Selectable, Transaction } from 'kysely'

import { conflict, forbidden, notFound } from '../../common/errors'
import { makeId } from '../../common/ids'
import type { VenueClaim, VenueOwner, VenueRights } from '../../common/venues'
import { adminScopes } from '../access'
import type { Actor } from '../auth/sessions'
import { lockKeys } from '../db/advisoryLocks'
import { atomic } from '../db/atomic'
import type { Database, VenueClaimsTable } from '../db/database'
import { type Clock, realClock } from '../groups/requests'
import { currentActor } from '../groups/rights'

/** How long a claim or co-owner request waits before it is approved. */
export const CLAIM_WAIT_MS = 7 * 24 * 60 * 60 * 1000

export type ClaimRow = Selectable<VenueClaimsTable>

/**
 * A claim counts once it is approved, or once its seven days have passed
 * with nobody deciding it. The rule is applied when reading, so a matured
 * claim counts at once with no timer; `settleClaims` writes it down later.
 */
export function claimCounts(claim: ClaimRow, clock: Clock): boolean {
  return (
    claim.status === 'approved' ||
    (claim.status === 'pending' &&
      claim.approves_at.getTime() <= clock.now().getTime())
  )
}

/** The claims still in play: pending or approved. */
export async function liveClaims(
  db: Kysely<Database>,
  venueIds: string[]
): Promise<ClaimRow[]> {
  if (venueIds.length === 0) return []
  return await db
    .selectFrom('venue_claims')
    .selectAll()
    .where('venue_id', 'in', venueIds)
    .where('status', 'in', ['pending', 'approved'])
    .orderBy('requested_at')
    .orderBy('id')
    .execute()
}

export interface Ownership {
  /** The claims that count, oldest first. */
  owners: ClaimRow[]
  /** Pending claims that have not yet matured. */
  pending: ClaimRow[]
  claimed: boolean
  /** The pending first claim, while no claim counts. */
  firstClaim: ClaimRow | null
}

export function ownershipOf(claims: ClaimRow[], clock: Clock): Ownership {
  const owners = claims.filter(claim => claimCounts(claim, clock))
  const pending = claims.filter(
    claim => claim.status === 'pending' && !claimCounts(claim, clock)
  )
  return {
    owners,
    pending,
    claimed: owners.length > 0,
    firstClaim:
      owners.length > 0
        ? null
        : (pending.find(claim => claim.kind === 'claim') ?? null)
  }
}

export async function venueOwnership(
  db: Kysely<Database>,
  venueId: string,
  clock: Clock = realClock
): Promise<Ownership> {
  return ownershipOf(await liveClaims(db, [venueId]), clock)
}

/**
 * Writes down the claims whose seven days have passed: approved, by nobody.
 * Returns them, so they can be announced.
 */
export async function settleClaims(
  db: Kysely<Database>,
  venueId: string,
  clock: Clock = realClock
): Promise<ClaimRow[]> {
  return await db
    .updateTable('venue_claims')
    .set(eb => ({
      status: 'approved',
      decided_at: eb.ref('approves_at')
    }))
    .where('venue_id', '=', venueId)
    .where('status', '=', 'pending')
    .where('approves_at', '<=', clock.now())
    .returningAll()
    .execute()
}

/** The leagues the person administers, every league for a site admin. */
async function administeredLeagues(
  db: Kysely<Database>,
  actor: Actor
): Promise<{ all: boolean; ids: Set<string> }> {
  const scopes = await adminScopes(db, actor.userId, actor.isAdmin)
  return { all: scopes.isAdmin, ids: scopes.leagueIds }
}

function administers(
  leagues: { all: boolean; ids: Set<string> },
  leagueId: string
): boolean {
  return leagues.all || leagues.ids.has(leagueId)
}

/**
 * Whether the person may edit the venue and its fields: a site
 * administrator, an admin of an owning league, or, while no claim counts, an
 * admin of the league holding the first pending claim, so it can set its
 * fields up during the seven days.
 */
export function editsVenue(
  ownership: Ownership,
  actor: Actor,
  leagues: { all: boolean; ids: Set<string> }
): boolean {
  if (actor.isAdmin) return true
  if (ownership.owners.some(claim => administers(leagues, claim.league_id)))
    return true
  return (
    ownership.firstClaim != null &&
    administers(leagues, ownership.firstClaim.league_id)
  )
}

/** Whether the person may decide this claim. */
export function decidesClaim(
  ownership: Ownership,
  claim: ClaimRow,
  actor: Actor,
  leagues: { all: boolean; ids: Set<string> }
): boolean {
  if (claim.status !== 'pending' || ownership.owners.includes(claim))
    return false
  if (actor.isAdmin) return true
  return (
    claim.kind === 'coOwner' &&
    ownership.owners.some(
      owner =>
        owner.league_id !== claim.league_id &&
        administers(leagues, owner.league_id)
    )
  )
}

/** What the person may do with the venue. */
export async function venueRights(
  db: Kysely<Database>,
  actor: Actor,
  venueId: string | null,
  clock: Clock = realClock
): Promise<VenueRights> {
  const fresh = await currentActor(db, actor)
  const leagues = await administeredLeagues(db, fresh)
  const claims = venueId == null ? [] : await liveClaims(db, [venueId])
  const ownership = ownershipOf(claims, clock)
  const held = new Set(claims.map(claim => claim.league_id))
  // A site administrator claims for the leagues they run themselves.
  const mine = [...leagues.ids].filter(id => !held.has(id)).sort()
  const blockedByFirstClaim = ownership.firstClaim != null
  return {
    canEdit: venueId != null && editsVenue(ownership, fresh, leagues),
    claimLeagues: blockedByFirstClaim ? [] : await leagueNames(db, mine),
    canClaim: !ownership.claimed && !blockedByFirstClaim && mine.length > 0,
    canRequest: ownership.claimed && mine.length > 0,
    claimBlocked:
      blockedByFirstClaim && mine.length > 0
        ? 'Another league has claimed this venue. Once its claim is approved, you can ask to co-own it.'
        : null,
    // Leaving is for the person's own leagues; a site administrator removes.
    leaveClaimIds: claims
      .filter(claim => leagues.ids.has(claim.league_id))
      .map(claim => claim.id),
    canRemoveOwners: fresh.isAdmin,
    decidableClaimIds: claims
      .filter(claim => decidesClaim(ownership, claim, fresh, leagues))
      .map(claim => claim.id)
  }
}

/** Leagues with their names, in the order given. */
async function leagueNames(
  db: Kysely<Database>,
  ids: string[]
): Promise<Array<{ id: string; name: string }>> {
  if (ids.length === 0) return []
  const names = new Map(
    (
      await db
        .selectFrom('leagues')
        .select(['id', 'name'])
        .where('id', 'in', ids)
        .execute()
    ).map(row => [row.id, row.name])
  )
  return ids.map(id => ({ id, name: names.get(id) ?? 'League' }))
}

/** 404 when the venue is missing, 403 when the person may not edit it. */
export async function requireVenueEditor(
  db: Kysely<Database>,
  actor: Actor,
  venueId: string,
  clock: Clock = realClock
): Promise<void> {
  const venue = await db
    .selectFrom('venues')
    .select('id')
    .where('id', '=', venueId)
    .executeTakeFirst()
  if (venue == null) throw notFound('Choose a venue')
  const fresh = await currentActor(db, actor)
  const ownership = await venueOwnership(db, venueId, clock)
  if (!editsVenue(ownership, fresh, await administeredLeagues(db, fresh)))
    throw forbidden('Only the leagues that own this venue may change it')
}

async function lockVenue(
  trx: Transaction<Database>,
  venueId: string
): Promise<void> {
  await lockKeys(trx, [`venue:${venueId}`])
  const venue = await trx
    .selectFrom('venues')
    .select('id')
    .where('id', '=', venueId)
    .executeTakeFirst()
  if (venue == null) throw notFound('Choose a venue')
}

/**
 * Files a league's claim, or its request to co-own a claimed venue. A second
 * league may not claim while a first claim is pending and nothing counts.
 */
export async function fileClaim(
  db: Kysely<Database>,
  actor: Actor,
  venueId: string,
  leagueId: string,
  clock: Clock = realClock
): Promise<ClaimRow> {
  return await atomic(db, async trx => {
    await lockVenue(trx, venueId)
    const fresh = await currentActor(trx, actor)
    const leagues = await administeredLeagues(trx, fresh)
    const league = await trx
      .selectFrom('leagues')
      .select('id')
      .where('id', '=', leagueId)
      .executeTakeFirst()
    if (league == null) throw notFound('Choose a league')
    if (!administers(leagues, leagueId))
      throw forbidden('Only an admin of the league may claim for it')
    await settleClaims(trx, venueId, clock)
    const ownership = await venueOwnership(trx, venueId, clock)
    if (
      [...ownership.owners, ...ownership.pending].some(
        claim => claim.league_id === leagueId
      )
    )
      throw conflict('This league already holds a claim on this venue')
    if (ownership.firstClaim != null)
      throw conflict('A claim for this venue is pending')
    const now = clock.now()
    return await trx
      .insertInto('venue_claims')
      .values({
        id: makeId('venueClaim'),
        venue_id: venueId,
        league_id: leagueId,
        kind: ownership.claimed ? 'coOwner' : 'claim',
        requested_by: fresh.userId,
        requested_at: now,
        approves_at: new Date(now.getTime() + CLAIM_WAIT_MS)
      })
      .returningAll()
      .executeTakeFirstOrThrow()
  })
}

async function claimOf(
  trx: Transaction<Database>,
  venueId: string,
  claimId: string
): Promise<ClaimRow> {
  const claim = await trx
    .selectFrom('venue_claims')
    .selectAll()
    .where('id', '=', claimId)
    .where('venue_id', '=', venueId)
    .executeTakeFirst()
  if (claim == null) throw notFound('Choose a claim')
  return claim
}

/** Approves or rejects a pending claim, for whoever may decide it. */
export async function decideClaim(
  db: Kysely<Database>,
  actor: Actor,
  venueId: string,
  claimId: string,
  decision: 'approve' | 'reject',
  clock: Clock = realClock
): Promise<ClaimRow> {
  return await atomic(db, async trx => {
    await lockVenue(trx, venueId)
    const fresh = await currentActor(trx, actor)
    await settleClaims(trx, venueId, clock)
    const claim = await claimOf(trx, venueId, claimId)
    if (claim.status !== 'pending')
      throw conflict('This claim has already been decided')
    const ownership = await venueOwnership(trx, venueId, clock)
    const live =
      ownership.pending.find(pending => pending.id === claim.id) ?? claim
    if (
      !decidesClaim(
        ownership,
        live,
        fresh,
        await administeredLeagues(trx, fresh)
      )
    )
      throw forbidden(
        claim.kind === 'claim'
          ? 'Only a site administrator decides a first claim'
          : 'Only a site administrator or an owner decides this request'
      )
    return await trx
      .updateTable('venue_claims')
      .set({
        status: decision === 'approve' ? 'approved' : 'rejected',
        decided_by: fresh.userId,
        decided_at: clock.now()
      })
      .where('id', '=', claim.id)
      .returningAll()
      .executeTakeFirstOrThrow()
  })
}

/**
 * Ends a claim: an admin of its league leaves (or withdraws a pending one),
 * and a site administrator removes any. When the last claim that counts
 * ends, the venue is unclaimed again and keeps its fields.
 */
export async function endClaim(
  db: Kysely<Database>,
  actor: Actor,
  venueId: string,
  claimId: string,
  clock: Clock = realClock
): Promise<ClaimRow> {
  return await atomic(db, async trx => {
    await lockVenue(trx, venueId)
    const fresh = await currentActor(trx, actor)
    await settleClaims(trx, venueId, clock)
    const claim = await claimOf(trx, venueId, claimId)
    if (claim.status !== 'pending' && claim.status !== 'approved')
      throw conflict('This claim has already ended')
    const leagues = await administeredLeagues(trx, fresh)
    const own = leagues.ids.has(claim.league_id)
    if (!own && !fresh.isAdmin)
      throw forbidden('Only an admin of the league, or a site administrator')
    return await trx
      .updateTable('venue_claims')
      .set({
        status: own ? 'left' : 'removed',
        decided_by: fresh.userId,
        decided_at: clock.now()
      })
      .where('id', '=', claim.id)
      .returningAll()
      .executeTakeFirstOrThrow()
  })
}

/** Owners and claims as the API returns them, with league names. */
export async function describeClaims(
  db: Kysely<Database>,
  claims: ClaimRow[],
  clock: Clock = realClock
): Promise<{ owners: VenueOwner[]; claims: VenueClaim[] }> {
  const leagueIds = [...new Set(claims.map(claim => claim.league_id))]
  const names = new Map(
    leagueIds.length === 0
      ? []
      : (
          await db
            .selectFrom('leagues')
            .select(['id', 'name'])
            .where('id', 'in', leagueIds)
            .execute()
        ).map(league => [league.id, league.name])
  )
  const ownership = ownershipOf(claims, clock)
  return {
    owners: ownership.owners.map(claim => ({
      claimId: claim.id,
      leagueId: claim.league_id,
      name: names.get(claim.league_id) ?? 'League'
    })),
    claims: claims.map(claim => ({
      id: claim.id,
      leagueId: claim.league_id,
      leagueName: names.get(claim.league_id) ?? 'League',
      kind: claim.kind,
      status: claimCounts(claim, clock) ? 'approved' : claim.status,
      requestedAt: claim.requested_at.toISOString(),
      approvesAt: claim.approves_at.toISOString()
    }))
  }
}
