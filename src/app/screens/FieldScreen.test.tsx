import { expect } from 'chai'
import { afterEach, describe, it } from 'mocha'
import React from 'react'

import type { TeamStationClient } from '../../common/api'
import type { VenueDetail } from '../../common/venues'
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
import { datesLabel, FieldScreen } from './FieldScreen'

function fakeClient(
  venue: VenueDetail | Error,
  after: (changes: Record<string, unknown>) => VenueDetail | Error = () => venue
): {
  client: TeamStationClient
  updates: Array<Record<string, unknown>>
  reads: number
} {
  const record = {
    updates: [] as Array<Record<string, unknown>>,
    reads: 0,
    client: undefined as unknown as TeamStationClient
  }
  record.client = {
    venue: async () => {
      record.reads++
      if (venue instanceof Error && record.reads === 1) throw venue
      return venue instanceof Error ? venueDetail() : venue
    },
    updateField: async (
      _venueId: string,
      _fieldId: string,
      changes: Record<string, unknown>
    ) => {
      record.updates.push(changes)
      const next = after(changes)
      if (next instanceof Error) throw next
      return next
    }
  } as unknown as TeamStationClient
  return record
}

const owned = (fieldOverrides = {}): VenueDetail =>
  venueDetail({
    defaultBlackouts: ['2027-07-04', '2027-07-05'],
    fields: [venueField(fieldOverrides)],
    rights: {
      canEdit: true,
      claimLeagues: [],
      canClaim: false,
      canRequest: false,
      claimBlocked: null,
      leaveClaimIds: [],
      canRemoveOwners: false,
      decidableClaimIds: []
    }
  })

describe('the field screen', () => {
  afterEach(unmount)

  it('reads its dates plainly', () => {
    expect(datesLabel({ startsOn: null, endsOn: null })).equals('Open all year')
    expect(datesLabel({ startsOn: '2026-10-01', endsOn: '2027-09-30' })).equals(
      'Oct 1, 2026 – Sep 30, 2027'
    )
  })

  it('shows a load failure and retries, and says when the field is gone', async () => {
    const record = fakeClient(new Error('down'))
    let gone = 0
    await mount(
      <FieldScreen
        client={record.client}
        venueId="ven_demo"
        fieldId="fld_one"
        onGone={() => {
          gone++
        }}
      />
    )
    expect(text()).includes('The field could not load')
    await press('Retry')
    await settle()
    expect(text()).includes('This field has been deleted')
    await press('Back to venue')
    expect(gone).equals(1)
  })

  it('reads only for someone who does not own the venue', async () => {
    const record = fakeClient(
      venueDetail({
        fields: [venueField({ pin: { latitude: 40.021, longitude: -75.221 } })]
      })
    )
    await mount(
      <FieldScreen
        client={record.client}
        venueId="ven_demo"
        fieldId="fld_one"
      />
    )
    expect(text()).includes('The pin marks the field.')
    expect(hasLabel('Field name')).equals(false)
    expect(hasLabel('Add photo')).equals(false)
    expect(hasLabel('Add blackout dates')).equals(false)
    // A read-only Google map on the field's own pin.
    expect(pinMapDrawn()).deep.equals({
      config: {
        latitude: 40.021,
        longitude: -75.221,
        key: '',
        editable: false,
        timeoutMs: 15000
      },
      foreignTiles: false
    })
  })

  it('saves its name, sizes, photo and pin for an owner', async () => {
    const record = fakeClient(owned(), changes =>
      owned(
        changes.sizes != null
          ? { sizes: changes.sizes }
          : changes.name != null
            ? { name: changes.name }
            : {}
      )
    )
    await mount(
      <FieldScreen
        client={record.client}
        venueId="ven_demo"
        fieldId="fld_one"
        pickPhoto={async () => ({ contentType: 'image/png', base64: 'AAAA' })}
      />
    )
    expect(text()).includes('Drag the pin onto the field itself')
    // The owner's map drags, from the venue's point while the field has none.
    expect(pinMapDrawn().config).include({
      latitude: 40.02,
      longitude: -75.22,
      editable: true
    })
    await fill('Field name', 'North Diamond')
    await press('Save name')
    await settle()
    await tapLabel('55/80')
    await settle()
    await press('Add photo')
    await settle()
    // The map posts a moved pin to its frame's window.
    const frame = document.querySelector<HTMLIFrameElement>(
      'iframe[data-testid="pin-map"]'
    )!
    const moved = new window.Event('message')
    Object.defineProperties(moved, {
      data: {
        value: {
          type: 'teamstation:pinMoved',
          latitude: 40.0211,
          longitude: -75.2211
        }
      },
      source: { value: frame.contentWindow }
    })
    window.dispatchEvent(moved)
    await settle()
    expect(record.updates).deep.equals([
      { name: 'North Diamond' },
      { sizes: ['46/60', '50/70', '55/80'] },
      { photo: { contentType: 'image/png', base64: 'AAAA' } },
      { pin: { latitude: 40.0211, longitude: -75.2211 } }
    ])
    expect(text()).includes('Pin saved.')
  })

  it('keeps its last size, and shows a failed save', async () => {
    const record = fakeClient(
      owned({ sizes: ['50/70'] }),
      () => new Error('Refused')
    )
    await mount(
      <FieldScreen
        client={record.client}
        venueId="ven_demo"
        fieldId="fld_one"
      />
    )
    // T-ball is a size of its own, beside 46/60.
    expect(hasLabel('T-ball')).equals(true)
    expect(hasLabel('46/60')).equals(true)
    await tapLabel('50/70')
    expect(record.updates).deep.equals([])
    await tapLabel('60/90')
    await settle()
    expect(text()).includes('Refused')
  })

  it('sets its dates, hours and blackouts', async () => {
    let current = owned()
    const record = fakeClient(current, changes => {
      const field = current.fields[0]
      current = owned({
        ...field,
        ...(changes.startsOn === undefined
          ? {}
          : { startsOn: changes.startsOn, endsOn: changes.endsOn }),
        ...(changes.hours === undefined ? {} : { hours: changes.hours }),
        ...(changes.blackouts === undefined
          ? {}
          : { blackouts: changes.blackouts })
      })
      return current
    })
    await mount(
      <FieldScreen
        client={record.client}
        venueId="ven_demo"
        fieldId="fld_one"
      />
    )
    // The venue's blackouts read as ranges, with no Remove.
    expect(text()).includes('The venue is also closed on these days:')
    expect(text()).includes('Jul 4 – Jul 5 · 2 days')
    expect(
      hasLabel('Remove blackout Sunday, July 4, 2027 – Monday, July 5, 2027')
    ).equals(false)
    await press('Dates: Open all year')
    await press('Cancel')
    await press('Dates: Open all year')
    await tapLabel('Next month')
    const days = [
      ...document.querySelectorAll<HTMLElement>('[aria-label^="20"]')
    ].filter(node =>
      /^\d{4}-\d{2}-\d{2}$/.test(node.getAttribute('aria-label')!)
    )
    await tapLabel(days[0].getAttribute('aria-label')!)
    await tapLabel(days[2].getAttribute('aria-label')!)
    await tapText('Use this range')
    await settle()
    expect(record.updates[0].startsOn).not.equals(undefined)
    await press('Open all year')
    await settle()
    // Its own hours, starting from the venue's.
    await tapText('Its own hours')
    await settle()
    await press('Field hours: Saturday, 8:00 AM – 6:00 PM')
    await tapLabel('Closes 6:00 PM')
    await tapLabel('Hour 10')
    await tapText('Use time')
    await tapText('Done')
    await settle()
    // A closed day turned open starts at 9:00 AM to 5:00 PM.
    await press('Field hours: Monday, Closed')
    await tapText('Open')
    expect(hasLabel('Opens 9:00 AM')).equals(true)
    await tapText('Done')
    await settle()
    await tapText('Venue hours')
    await settle()
    await press('Add blackout dates')
    await chooseDateRange('2027-03-10', '2027-03-11')
    await settle()
    expect(text()).includes('Mar 10 – Mar 11 · 2 days')
    await press(
      'Remove blackout Wednesday, March 10, 2027 – Thursday, March 11, 2027'
    )
    await settle()
    expect(record.updates.slice(1)).deep.equals([
      { startsOn: null, endsOn: null },
      { hours: [{ weekday: 6, start: '08:00', end: '18:00' }] },
      { hours: [{ weekday: 6, start: '08:00', end: '22:00' }] },
      {
        hours: [
          { weekday: 1, start: '09:00', end: '17:00' },
          { weekday: 6, start: '08:00', end: '22:00' }
        ]
      },
      { hours: null },
      { blackouts: ['2027-03-10', '2027-03-11'] },
      { blackouts: [] }
    ])
  })
})
