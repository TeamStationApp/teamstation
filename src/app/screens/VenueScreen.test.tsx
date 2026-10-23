import { expect } from 'chai'
import { afterEach, describe, it } from 'mocha'
import React from 'react'

import type { TeamStationClient } from '../../common/api'
import { rangeDates, type VenueDetail } from '../../common/venues'
import {
  fill,
  mount,
  press,
  settle,
  text,
  unmount
} from '../../test/gameFormDom'
import {
  chooseDateRange,
  hasLabel,
  pinMapDrawn,
  tapLabel,
  tapText,
  venueDetail,
  venueField
} from '../../test/venueDom'
import { approvalLabel, sizesLabel, VenueScreen } from './VenueScreen'

type Calls = Record<string, unknown[][]>

/** A client whose venue methods answer `next` and record their arguments. */
function fakeClient(
  initial: VenueDetail | Error,
  next: (method: string, args: unknown[]) => VenueDetail | Error = () =>
    initial instanceof Error ? venueDetail() : initial
): { client: TeamStationClient; calls: Calls } {
  const calls: Calls = {}
  const answer =
    (method: string) =>
    async (...args: unknown[]): Promise<VenueDetail> => {
      calls[method] = [...(calls[method] ?? []), args]
      const result =
        method === 'venue' || method === 'venueForPlace'
          ? calls[method].length === 1
            ? initial
            : next(method, args)
          : next(method, args)
      if (result instanceof Error) throw result
      return result
    }
  const client = Object.fromEntries(
    [
      'venue',
      'venueForPlace',
      'claimPlace',
      'claimVenue',
      'decideVenueClaim',
      'endVenueClaim',
      'updateVenue',
      'createField',
      'updateField',
      'deleteField'
    ].map(method => [method, answer(method)])
  ) as unknown as TeamStationClient
  return { client, calls }
}

/**
 * What each control labelled "Add field" reads: the header's small "Add", or
 * the empty list's row, its plus icon (drawn from its name on the web), its
 * title and its chevron.
 */
function addFieldControls(): string[] {
  return [...document.querySelectorAll('[aria-label="Add field"]')].map(
    node => node.textContent ?? ''
  )
}

const owner = (canEdit = true): VenueDetail['rights'] => ({
  canEdit,
  claimLeagues: [],
  canClaim: false,
  canRequest: false,
  claimBlocked: null,
  leaveClaimIds: ['vcl_a'],
  canRemoveOwners: false,
  decidableClaimIds: []
})

describe('the venue screen', () => {
  afterEach(unmount)

  it('reads plainly: approval dates and size lists', () => {
    expect(approvalLabel('2027-04-08T12:00:00Z')).equals(
      'approved automatically on Apr 8, 2027'
    )
    expect(sizesLabel(['46/60', '50/70'])).equals('46/60 · 50/70')
    expect(sizesLabel(['T-ball', '46/60'])).equals('T-ball · 46/60')
  })

  it('shows a load failure and retries', async () => {
    const { client, calls } = fakeClient(new Error('Not found'), () =>
      venueDetail()
    )
    await mount(
      <VenueScreen
        client={client}
        venueId="ven_demo"
        onOpenField={() => undefined}
        onClaimed={() => undefined}
      />
    )
    expect(text()).includes('Not found')
    await press('Retry')
    await settle()
    expect(calls.venue).length(2)
    expect(text()).includes('Example Park')
  })

  it('draws the venue on a read-only Google map, even for its owner', async () => {
    const { client } = fakeClient(
      venueDetail({
        rights: owner(),
        map: {
          latitude: 40.03,
          longitude: -75.23,
          googleMapsApiKey: 'placeholder-key'
        }
      })
    )
    await mount(
      <VenueScreen
        client={client}
        venueId="ven_demo"
        onOpenField={() => undefined}
        onClaimed={() => undefined}
      />
    )
    expect(pinMapDrawn()).deep.equals({
      config: {
        latitude: 40.03,
        longitude: -75.23,
        key: 'placeholder-key',
        editable: false,
        timeoutMs: 15000
      },
      foreignTiles: false
    })
  })

  it('claims a Google place for the person’s one league and opens the new venue', async () => {
    const place = venueDetail({
      id: null,
      rights: {
        ...owner(false),
        leaveClaimIds: [],
        canClaim: true,
        claimLeagues: [{ id: 'lea_a', name: 'Demo League A' }]
      }
    })
    const opened: string[] = []
    const { client, calls } = fakeClient(place, () =>
      venueDetail({ id: 'ven_new' })
    )
    const directions: string[] = []
    await mount(
      <VenueScreen
        client={client}
        placeId="example-park"
        onOpenField={() => undefined}
        onClaimed={id => opened.push(id)}
        openDirections={async address => {
          directions.push(address)
        }}
      />
    )
    expect(calls.venueForPlace).deep.equals([['example-park']])
    expect(text()).includes('Unclaimed')
    expect(text()).includes('approved after 7 days')
    expect(text()).not.includes('Fields')
    await tapLabel('Directions to 1 Example Way, Demo City')
    expect(directions).deep.equals(['1 Example Way, Demo City'])
    await press('Claim')
    await settle()
    expect(calls.claimPlace).deep.equals([['example-park', 'lea_a']])
    expect(opened).deep.equals(['ven_new'])
  })

  it('asks which league when the person runs several, and explains a blocked claim', async () => {
    const venue = venueDetail({
      rights: {
        ...owner(false),
        leaveClaimIds: [],
        canClaim: true,
        claimLeagues: [
          { id: 'lea_a', name: 'Demo League A' },
          { id: 'lea_c', name: 'Demo League C' }
        ]
      }
    })
    const { client, calls } = fakeClient(venue)
    await mount(
      <VenueScreen
        client={client}
        venueId="ven_demo"
        onOpenField={() => undefined}
        onClaimed={() => undefined}
      />
    )
    await press('Claim')
    await press('Demo League C')
    await settle()
    expect(calls.claimVenue).deep.equals([['ven_demo', 'lea_c']])
    expect(text()).includes('Claimed. The claim is approved in 7 days')
    await unmount()
    const blocked = fakeClient(
      venueDetail({
        claims: [
          {
            id: 'vcl_b',
            leagueId: 'lea_b',
            leagueName: 'Demo League B',
            kind: 'claim',
            status: 'pending',
            requestedAt: '2027-04-01T00:00:00.000Z',
            approvesAt: '2027-04-08T00:00:00.000Z'
          }
        ],
        rights: {
          ...owner(false),
          leaveClaimIds: [],
          claimBlocked: 'Another league has claimed this venue.'
        }
      })
    )
    await mount(
      <VenueScreen
        client={blocked.client}
        venueId="ven_demo"
        onOpenField={() => undefined}
        onClaimed={() => undefined}
      />
    )
    expect(text()).includes('Another league has claimed this venue.')
    expect(text()).includes('Claim pending')
    expect(hasLabel('Claim')).equals(false)
  })

  it('sends a request to co-own, and shows a failed one', async () => {
    const venue = venueDetail({
      owners: [{ claimId: 'vcl_b', leagueId: 'lea_b', name: 'Demo League B' }],
      rights: {
        ...owner(false),
        leaveClaimIds: [],
        canRequest: true,
        claimLeagues: [{ id: 'lea_a', name: 'Demo League A' }]
      }
    })
    const { client } = fakeClient(venue, () => new Error('Already requested'))
    await mount(
      <VenueScreen
        client={client}
        venueId="ven_demo"
        onOpenField={() => undefined}
        onClaimed={() => undefined}
      />
    )
    expect(text()).includes('Demo League B')
    await press('Request to co-own')
    await settle()
    expect(text()).includes('Already requested')
  })

  it('approves and declines requests for whoever may decide them', async () => {
    const request = {
      id: 'vcl_b',
      leagueId: 'lea_b',
      leagueName: 'Demo League B',
      kind: 'coOwner' as const,
      status: 'pending' as const,
      requestedAt: '2027-04-01T00:00:00.000Z',
      approvesAt: '2027-04-08T12:00:00.000Z'
    }
    const venue = venueDetail({
      owners: [{ claimId: 'vcl_a', leagueId: 'lea_a', name: 'Demo League A' }],
      claims: [request],
      rights: { ...owner(), decidableClaimIds: ['vcl_b'] }
    })
    const { client, calls } = fakeClient(venue)
    await mount(
      <VenueScreen
        client={client}
        venueId="ven_demo"
        onOpenField={() => undefined}
        onClaimed={() => undefined}
      />
    )
    expect(text()).includes(
      'Request to co-own · approved automatically on Apr 8, 2027'
    )
    await press('Approve Demo League B')
    await settle()
    await press('Decline Demo League B')
    await settle()
    expect(calls.decideVenueClaim).deep.equals([
      ['ven_demo', 'vcl_b', 'approve'],
      ['ven_demo', 'vcl_b', 'reject']
    ])
    expect(text()).includes('Demo League B: declined.')
  })

  it('confirms leaving, withdrawing and removing, and changes nothing when cancelled', async () => {
    const venue = venueDetail({
      owners: [
        { claimId: 'vcl_a', leagueId: 'lea_a', name: 'Demo League A' },
        { claimId: 'vcl_b', leagueId: 'lea_b', name: 'Demo League B' }
      ],
      claims: [
        {
          id: 'vcl_c',
          leagueId: 'lea_c',
          leagueName: 'Demo League C',
          kind: 'coOwner',
          status: 'pending',
          requestedAt: '2027-04-01T00:00:00.000Z',
          approvesAt: '2027-04-08T00:00:00.000Z'
        }
      ],
      rights: {
        ...owner(),
        leaveClaimIds: ['vcl_a', 'vcl_c'],
        canRemoveOwners: true
      }
    })
    const { client, calls } = fakeClient(venue)
    await mount(
      <VenueScreen
        client={client}
        venueId="ven_demo"
        onOpenField={() => undefined}
        onClaimed={() => undefined}
      />
    )
    // Demo League C's claim is still pending: counted beside the owners.
    expect(text()).includes('OWNERS2 · 1 pending')
    await press('Leave Demo League A')
    await press('Cancel')
    expect(calls.endVenueClaim).equals(undefined)
    await press('Leave Demo League A')
    await tapText('Leave')
    await settle()
    expect(calls.endVenueClaim).deep.equals([['ven_demo', 'vcl_a']])
    await press('Remove Demo League B')
    await tapText('Remove')
    await settle()
    await press('Withdraw Demo League C')
    await tapText('Withdraw')
    await settle()
    expect(calls.endVenueClaim.map(args => args[1])).deep.equals([
      'vcl_a',
      'vcl_b',
      'vcl_c'
    ])
  })

  it('lists fields to open, and lets an owner add and delete them', async () => {
    const opened: string[] = []
    const venue = venueDetail({
      fields: [venueField()],
      rights: owner()
    })
    const { client, calls } = fakeClient(venue, method =>
      method === 'createField'
        ? venueDetail({
            fields: [
              venueField(),
              venueField({ id: 'fld_two', name: 'Field 2' })
            ],
            rights: owner()
          })
        : venue
    )
    await mount(
      <VenueScreen
        client={client}
        venueId="ven_demo"
        onOpenField={(venueId, fieldId) => opened.push(`${venueId}/${fieldId}`)}
        onClaimed={() => undefined}
      />
    )
    expect(text()).includes('46/60 · 50/70')
    // With a field, Add is the header's, and there is no Add field row.
    expect(addFieldControls()).deep.equals(['Add'])
    await press('Open Field 1')
    expect(opened).deep.equals(['ven_demo/fld_one'])
    await press('Add field')
    expect(hasLabel('Add field')).equals(true)
    await fill('Field name', 'Field 2')
    await tapLabel('50/70')
    await tapLabel('55/80')
    await tapLabel('55/80')
    await tapLabel('46/60')
    await tapText('Add field')
    await settle()
    expect(calls.createField).deep.equals([
      ['ven_demo', { name: 'Field 2', sizes: ['46/60', '50/70'] }]
    ])
    expect(text()).includes('Field 2 added.')
    await press('Delete Field 1')
    await tapText('Delete')
    await settle()
    expect(calls.deleteField).deep.equals([['ven_demo', 'fld_one']])
  })

  it('shows an empty venue’s owner an Add field row in place of the header’s Add, until a field exists', async () => {
    const { client, calls } = fakeClient(
      venueDetail({ rights: owner() }),
      method =>
        method === 'createField'
          ? venueDetail({
              fields: [venueField({ name: 'Tee Field', sizes: ['T-ball'] })],
              rights: owner()
            })
          : venueDetail({ rights: owner() })
    )
    await mount(
      <VenueScreen
        client={client}
        venueId="ven_demo"
        onOpenField={() => undefined}
        onClaimed={() => undefined}
      />
    )
    expect(addFieldControls()).deep.equals(['addAdd fieldchevron_right'])
    expect(text()).not.includes('No fields')
    await press('Add field')
    await press('Cancel')
    expect(calls.createField).equals(undefined)
    await press('Add field')
    // T-ball and 46/60 are two choices.
    expect(hasLabel('T-ball')).equals(true)
    expect(hasLabel('46/60')).equals(true)
    await fill('Field name', 'Tee Field')
    await tapLabel('T-ball')
    await tapText('Add field')
    await settle()
    expect(calls.createField).deep.equals([
      ['ven_demo', { name: 'Tee Field', sizes: ['T-ball'] }]
    ])
    expect(text()).includes('Tee FieldT-ball')
    expect(addFieldControls()).deep.equals(['Add'])
    await unmount()
    const reader = fakeClient(venueDetail())
    await mount(
      <VenueScreen
        client={reader.client}
        venueId="ven_demo"
        onOpenField={() => undefined}
        onClaimed={() => undefined}
      />
    )
    expect(text()).includes('No fields have been set up here yet.')
    expect(hasLabel('Add field')).equals(false)
  })

  it('saves the size switch time, default hours, blackouts and photo', async () => {
    const venue = venueDetail({
      rights: owner(),
      photoUrl: 'https://images.example.test/venue-640.png',
      defaultBlackouts: rangeDates('2027-07-03', '2027-07-05')
    })
    const { client, calls } = fakeClient(venue)
    let picked = 0
    await mount(
      <VenueScreen
        client={client}
        venueId="ven_demo"
        onOpenField={() => undefined}
        onClaimed={() => undefined}
        pickPhoto={async () => {
          picked++
          return picked === 1
            ? { contentType: 'image/png', base64: 'AAAA' }
            : null
        }}
      />
    )
    await press('Change size switch time')
    await fill('Minutes', '30')
    await tapText('Save')
    await settle()
    await press('Default hours: Tuesday, Closed')
    await tapText('Open')
    // A day turned open starts at 9:00 AM to 5:00 PM.
    expect(hasLabel('Opens 9:00 AM')).equals(true)
    expect(hasLabel('Closes 5:00 PM')).equals(true)
    await tapText('Done')
    await settle()
    // Its blackouts list as ranges; a new range joins them.
    expect(text()).includes('Jul 3 – Jul 5 · 3 days')
    await press('Add blackout dates')
    await chooseDateRange('2026-12-20', '2027-01-02')
    await settle()
    expect(document.querySelector('[data-testid="place-photo"]')).not.equals(
      null
    )
    await press('Change photo')
    await settle()
    await press('Change photo')
    await settle()
    expect(calls.updateVenue).deep.equals([
      ['ven_demo', { sizeSwitchMinutes: 30 }],
      [
        'ven_demo',
        {
          defaultHours: [
            { weekday: 2, start: '09:00', end: '17:00' },
            { weekday: 6, start: '08:00', end: '18:00' }
          ]
        }
      ],
      [
        'ven_demo',
        {
          defaultBlackouts: [
            ...rangeDates('2026-12-20', '2027-01-02'),
            ...rangeDates('2027-07-03', '2027-07-05')
          ]
        }
      ],
      ['ven_demo', { photo: { contentType: 'image/png', base64: 'AAAA' } }]
    ])
  })
})
