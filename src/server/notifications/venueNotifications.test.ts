import { expect } from 'chai'
import { afterEach, beforeEach, describe, it } from 'mocha'

import type { Notification } from '../../common/notifications'
import type { VenueDetail } from '../../common/venues'
import { EXAMPLE_PARK, googlePlacesStub } from '../../test/googlePlacesStub'
import { type GroupFixture, groupFixture } from '../../test/groupFixtures'
import { googlePlaces } from '../location/googlePlaces'
import { CLAIM_WAIT_MS } from '../venues/ownership'
import { recordNotice } from '../venues/venueNotices'

interface Page {
  items: Notification[]
  hasPending: boolean
}

describe('venue notifications in the inbox', function () {
  this.timeout(120000)
  let stub: Awaited<ReturnType<typeof googlePlacesStub>>
  let f: GroupFixture
  const inbox = async (user: number, history = false): Promise<Page> => {
    const response = await f.h.request(
      'GET',
      `/me/notifications${history ? '?history=1' : ''}`,
      undefined,
      user
    )
    expect(response.status).equals(200)
    return (await response.json()) as Page
  }
  beforeEach(async () => {
    stub = await googlePlacesStub()
    f = await groupFixture(
      undefined,
      undefined,
      undefined,
      googlePlaces({ apiKey: 'placeholder-key', baseUrl: stub.baseUrl })
    )
  })
  afterEach(async () => {
    await f?.h.close()
    await stub?.close()
  })

  it('tells the site administrators of a first claim in History, with no bell, and opens the venue', async () => {
    const response = await f.h.request('POST', '/venues', {
      placeId: EXAMPLE_PARK.id,
      leagueId: f.leagueA
    })
    const venue = (await response.json()) as VenueDetail
    // Accepted when it is recorded: History, not Pending, and no bell.
    const pending = await inbox(105)
    expect(pending.hasPending).equals(false)
    expect(pending.items.map(item => item.type)).not.includes('venueClaim')
    const admin = await inbox(105, true)
    expect(admin.hasPending).equals(false)
    const notice = admin.items.find(item => item.type === 'venueClaim')!
    expect(notice).include({
      title: 'Demo League A claimed Example Park',
      venueId: venue.id,
      status: 'accepted',
      viewed: false
    })
    expect(notice.description).includes('7 days')
    expect((await inbox(102, true)).items.map(item => item.type)).not.includes(
      'venueClaim'
    )
    // Opened, it stays in History and out of Pending.
    expect(
      (
        await f.h.request(
          'PUT',
          `/me/notifications/${notice.id}/viewed`,
          undefined,
          105
        )
      ).status
    ).lessThan(300)
    expect((await inbox(105)).items.map(item => item.id)).not.includes(
      notice.id
    )
    expect((await inbox(105, true)).items.map(item => item.id)).includes(
      notice.id
    )
    expect(
      (
        (await (
          await f.h.request(
            'GET',
            `/me/notifications/${notice.id}`,
            undefined,
            105
          )
        ).json()) as Notification
      ).venueId
    ).equals(venue.id)
  })

  it('tells the claimant when the seven days pass, and owners and site administrators of a request to co-own', async () => {
    const venue = (await (
      await f.h.request('POST', '/venues', {
        placeId: EXAMPLE_PARK.id,
        leagueId: f.leagueA
      })
    ).json()) as VenueDetail
    f.advance(CLAIM_WAIT_MS)
    await f.h.request('GET', `/venues/${venue.id!}`, undefined, 102)
    const decided = (await inbox(101, true)).items.find(
      item => item.type === 'venueClaimDecided'
    )!
    expect(decided.title).equals('Example Park: claim approved')
    expect(decided.description).includes('approved after 7 days')
    await f.h.request(
      'POST',
      `/venues/${venue.id!}/claims`,
      { leagueId: f.leagueB },
      102
    )
    for (const user of [101, 105]) {
      expect(
        (await inbox(user)).items.map(item => item.type),
        `user ${user}`
      ).not.includes('venueOwnerRequest')
      const request = (await inbox(user, true)).items.find(
        item => item.type === 'venueOwnerRequest'
      )
      expect(request?.title, `user ${user}`).equals(
        'Demo League B asks to co-own Example Park'
      )
    }
    const claimId = (
      (await (
        await f.h.request('GET', `/venues/${venue.id!}`)
      ).json()) as VenueDetail
    ).claims.find(claim => claim.leagueId === f.leagueB)!.id
    await f.h.request(
      'POST',
      `/venues/${venue.id!}/claims/${claimId}/decisions`,
      {
        decision: 'reject'
      }
    )
    const declined = (await inbox(102, true)).items.find(
      item => item.type === 'venueClaimDecided'
    )!
    expect(declined.title).equals('Example Park: request declined')
    expect(declined.description).includes("decided Demo League B's request")
  })

  it('records nothing for nobody, and never collides two notices about one thing', async () => {
    await recordNotice(f.h.db, {
      type: 'fieldWarning',
      actorId: null,
      recipients: [],
      title: 'Nobody',
      description: '',
      metadata: { gameId: 'gam_x' }
    })
    for (let n = 0; n < 2; n++)
      await recordNotice(f.h.db, {
        type: 'fieldWarning',
        actorId: null,
        recipients: [
          (
            await f.h.db
              .selectFrom('users')
              .select('id')
              .where('is_admin', '=', true)
              .executeTakeFirstOrThrow()
          ).id
        ],
        title: `Warning ${n}`,
        description: '',
        metadata: { gameId: 'gam_x' }
      })
    const rows = await f.h.db
      .selectFrom('notification_events')
      .select('id')
      .where('source_type', '=', 'fieldWarning')
      .execute()
    expect(rows).length(2)
    const page = await inbox(105, true)
    expect(
      page.items.filter(item => item.type === 'fieldWarning').map(i => i.gameId)
    ).deep.equals(['gam_x', 'gam_x'])
    expect(
      (await inbox(105)).items.filter(item => item.type === 'fieldWarning')
    ).deep.equals([])
  })
})
