import { expect } from 'chai'
import { afterEach, beforeEach, describe, it } from 'mocha'

import { HttpError } from '../../common/errors'
import {
  actor,
  type GroupFixture,
  groupFixture
} from '../../test/groupFixtures'
import {
  CLAIM_WAIT_MS,
  decideClaim,
  describeClaims,
  endClaim,
  fileClaim,
  liveClaims,
  requireVenueEditor,
  settleClaims,
  venueOwnership,
  venueRights
} from './ownership'

const VENUE = 'ven_ownership'
const site = { ...actor(105), isAdmin: true }

async function failure(run: () => Promise<unknown>): Promise<HttpError> {
  try {
    await run()
  } catch (error) {
    if (error instanceof HttpError) return error
    throw error
  }
  throw new Error('Expected a refusal')
}

describe('venue ownership', function () {
  this.timeout(60000)
  let f: GroupFixture
  beforeEach(async () => {
    f = await groupFixture()
    await f.h.db
      .insertInto('venues')
      .values({
        id: VENUE,
        google_place_id: 'place-ownership',
        name: 'Demo Park',
        latitude: 40,
        longitude: -75,
        timezone: 'America/New_York'
      })
      .execute()
    await f.h.db
      .insertInto('venue_fields')
      .values({
        id: 'fld_kept',
        venue_id: VENUE,
        name: 'Field 1',
        sizes: ['50/70']
      })
      .execute()
  })
  afterEach(async () => {
    await f?.h.close()
  })

  it('counts a first claim after seven days, or sooner when a site administrator approves', async () => {
    const claim = await fileClaim(f.h.db, actor(101), VENUE, f.leagueA, f.clock)
    expect(claim.kind).equals('claim')
    expect(claim.approves_at.getTime() - claim.requested_at.getTime()).equals(
      CLAIM_WAIT_MS
    )
    expect((await venueOwnership(f.h.db, VENUE, f.clock)).claimed).equals(false)
    expect(
      (await venueOwnership(f.h.db, VENUE, f.clock)).firstClaim?.id
    ).equals(claim.id)
    // The league may set the venue up while its claim waits.
    await requireVenueEditor(f.h.db, actor(101), VENUE, f.clock)
    expect(
      (
        await failure(async () => {
          await requireVenueEditor(f.h.db, actor(102), VENUE, f.clock)
        })
      ).code
    ).equals('forbidden')
    f.advance(CLAIM_WAIT_MS)
    const matured = await venueOwnership(f.h.db, VENUE, f.clock)
    expect(matured.claimed).equals(true)
    expect(matured.owners.map(owner => owner.league_id)).deep.equals([
      f.leagueA
    ])
    // Settling writes the automatic approval, decided by nobody.
    await settleClaims(f.h.db, VENUE, f.clock)
    const [settled] = await liveClaims(f.h.db, [VENUE])
    expect(settled.status).equals('approved')
    expect(settled.decided_by).equals(null)
    expect(settled.decided_at?.getTime()).equals(settled.approves_at.getTime())
  })

  it('lets only a site administrator decide a first claim', async () => {
    const claim = await fileClaim(f.h.db, actor(101), VENUE, f.leagueA, f.clock)
    expect(
      (
        await failure(
          async () =>
            await decideClaim(
              f.h.db,
              actor(101),
              VENUE,
              claim.id,
              'approve',
              f.clock
            )
        )
      ).message
    ).includes('site administrator')
    const approved = await decideClaim(
      f.h.db,
      site,
      VENUE,
      claim.id,
      'approve',
      f.clock
    )
    expect(approved.status).equals('approved')
    expect((await venueOwnership(f.h.db, VENUE, f.clock)).claimed).equals(true)
    expect(
      (
        await failure(
          async () =>
            await decideClaim(f.h.db, site, VENUE, claim.id, 'reject', f.clock)
        )
      ).code
    ).equals('conflict')
  })

  it('never counts a rejected claim, and lets the venue be claimed afresh', async () => {
    const claim = await fileClaim(f.h.db, actor(101), VENUE, f.leagueA, f.clock)
    await decideClaim(f.h.db, site, VENUE, claim.id, 'reject', f.clock)
    f.advance(CLAIM_WAIT_MS * 2)
    expect((await venueOwnership(f.h.db, VENUE, f.clock)).claimed).equals(false)
    const again = await fileClaim(f.h.db, actor(102), VENUE, f.leagueB, f.clock)
    expect(again.kind).equals('claim')
  })

  it('refuses a second league while a first claim is pending, then takes its co-owner request', async () => {
    await fileClaim(f.h.db, actor(101), VENUE, f.leagueA, f.clock)
    const blocked = await failure(
      async () => await fileClaim(f.h.db, actor(102), VENUE, f.leagueB, f.clock)
    )
    expect(blocked.code).equals('conflict')
    expect(blocked.message).equals('A claim for this venue is pending')
    const rights = await venueRights(f.h.db, actor(102), VENUE, f.clock)
    expect(rights.canClaim).equals(false)
    expect(rights.canRequest).equals(false)
    expect(rights.claimBlocked).includes('ask to co-own')
    f.advance(CLAIM_WAIT_MS)
    const request = await fileClaim(
      f.h.db,
      actor(102),
      VENUE,
      f.leagueB,
      f.clock
    )
    expect(request.kind).equals('coOwner')
    expect(
      (
        await failure(
          async () =>
            await fileClaim(f.h.db, actor(102), VENUE, f.leagueB, f.clock)
        )
      ).message
    ).includes('already holds a claim')
  })

  it('lets an owner decide a co-owner request, final once declined, and nobody else', async () => {
    const claim = await fileClaim(f.h.db, actor(101), VENUE, f.leagueA, f.clock)
    await decideClaim(f.h.db, site, VENUE, claim.id, 'approve', f.clock)
    const request = await fileClaim(
      f.h.db,
      actor(102),
      VENUE,
      f.leagueB,
      f.clock
    )
    expect(
      (await venueRights(f.h.db, actor(101), VENUE, f.clock)).decidableClaimIds
    ).deep.equals([request.id])
    expect(
      (await venueRights(f.h.db, actor(102), VENUE, f.clock)).decidableClaimIds
    ).deep.equals([])
    expect(
      (
        await failure(
          async () =>
            await decideClaim(
              f.h.db,
              actor(104),
              VENUE,
              request.id,
              'approve',
              f.clock
            )
        )
      ).code
    ).equals('forbidden')
    const declined = await decideClaim(
      f.h.db,
      actor(101),
      VENUE,
      request.id,
      'reject',
      f.clock
    )
    expect(declined.status).equals('rejected')
    f.advance(CLAIM_WAIT_MS * 2)
    expect(
      (await venueOwnership(f.h.db, VENUE, f.clock)).owners.map(
        o => o.league_id
      )
    ).deep.equals([f.leagueA])
    // A site administrator can approve a request too.
    const second = await fileClaim(
      f.h.db,
      actor(102),
      VENUE,
      f.leagueB,
      f.clock
    )
    await decideClaim(f.h.db, site, VENUE, second.id, 'approve', f.clock)
    const { owners } = await describeClaims(
      f.h.db,
      await liveClaims(f.h.db, [VENUE]),
      f.clock
    )
    expect(owners.map(owner => owner.name)).deep.equals([
      'Demo League A',
      'Demo League B'
    ])
  })

  it('makes the venue unclaimed when the last owner leaves or is removed, keeping its fields', async () => {
    const claim = await fileClaim(f.h.db, actor(101), VENUE, f.leagueA, f.clock)
    await decideClaim(f.h.db, site, VENUE, claim.id, 'approve', f.clock)
    const request = await fileClaim(
      f.h.db,
      actor(102),
      VENUE,
      f.leagueB,
      f.clock
    )
    await decideClaim(f.h.db, actor(101), VENUE, request.id, 'approve', f.clock)
    expect(
      (await venueRights(f.h.db, actor(101), VENUE, f.clock)).leaveClaimIds
    ).deep.equals([claim.id])
    expect(
      (
        await failure(
          async () =>
            await endClaim(f.h.db, actor(101), VENUE, request.id, f.clock)
        )
      ).code
    ).equals('forbidden')
    // A site administrator who runs neither league removes rather than leaves.
    const siteRights = await venueRights(f.h.db, site, VENUE, f.clock)
    expect(siteRights.leaveClaimIds).deep.equals([])
    expect(siteRights.canRemoveOwners).equals(true)
    expect(
      (await endClaim(f.h.db, actor(101), VENUE, claim.id, f.clock)).status
    ).equals('left')
    expect(
      (await endClaim(f.h.db, site, VENUE, request.id, f.clock)).status
    ).equals('removed')
    expect(
      (
        await failure(
          async () => await endClaim(f.h.db, site, VENUE, request.id, f.clock)
        )
      ).code
    ).equals('conflict')
    expect((await venueOwnership(f.h.db, VENUE, f.clock)).claimed).equals(false)
    expect(
      (await f.h.db.selectFrom('venue_fields').select('id').execute()).map(
        row => row.id
      )
    ).deep.equals(['fld_kept'])
    const rights = await venueRights(f.h.db, actor(102), VENUE, f.clock)
    expect(rights.canClaim).equals(true)
    expect(rights.claimLeagues).deep.equals([
      { id: f.leagueB, name: 'Demo League B' }
    ])
  })

  it('serializes two concurrent claims under the venue lock', async () => {
    const results = await Promise.allSettled([
      fileClaim(f.h.db, actor(101), VENUE, f.leagueA, f.clock),
      fileClaim(f.h.db, actor(102), VENUE, f.leagueB, f.clock)
    ])
    expect(results.filter(r => r.status === 'fulfilled')).length(1)
    expect(results.filter(r => r.status === 'rejected')).length(1)
    expect(await liveClaims(f.h.db, [VENUE])).length(1)
  })

  it('refuses claims for a league the person does not run, or a missing venue or league', async () => {
    expect(
      (
        await failure(
          async () =>
            await fileClaim(f.h.db, actor(102), VENUE, f.leagueA, f.clock)
        )
      ).code
    ).equals('forbidden')
    expect(
      (
        await failure(
          async () =>
            await fileClaim(
              f.h.db,
              actor(101),
              'ven_missing',
              f.leagueA,
              f.clock
            )
        )
      ).code
    ).equals('notFound')
    expect(
      (
        await failure(
          async () =>
            await fileClaim(f.h.db, actor(101), VENUE, 'lea_missing', f.clock)
        )
      ).code
    ).equals('notFound')
    expect(
      (
        await failure(async () => {
          await requireVenueEditor(f.h.db, actor(101), 'ven_missing', f.clock)
        })
      ).code
    ).equals('notFound')
    expect(
      (
        await failure(
          async () =>
            await decideClaim(
              f.h.db,
              site,
              VENUE,
              'vcl_missing',
              'approve',
              f.clock
            )
        )
      ).code
    ).equals('notFound')
    await requireVenueEditor(f.h.db, site, VENUE, f.clock)
    const unknown = await venueRights(f.h.db, actor(101), null, f.clock)
    expect(unknown.canEdit).equals(false)
    expect(unknown.canClaim).equals(true)
  })
})
