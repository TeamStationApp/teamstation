import { expect } from 'chai'
import { afterEach, describe, it } from 'mocha'
import React from 'react'

import { TeamStationClient } from '../../common/api'
import type { GameFieldSummary } from '../../common/gameApprovals'
import type { VenueDetail, VenueField, VenueSummary } from '../../common/venues'
import { mount, press, settle, text, unmount } from '../../test/gameFormDom'
import { tapLabel, venueDetail, venueField } from '../../test/venueDom'
import { FieldPickerScene } from './FieldPickerScene'

const harbor: VenueSummary = {
  id: 'ven_harbor',
  placeId: 'harbor-field',
  name: 'Harbor Field',
  address: '1 Demo Way, Demo City',
  owners: [],
  pendingClaim: false,
  claimed: false,
  group: 'unclaimed',
  distanceKm: null
}

const HARBOR = venueDetail({
  id: 'ven_harbor',
  placeId: 'harbor-field',
  name: 'Harbor Field',
  address: '1 Demo Way, Demo City',
  fields: [
    venueField({
      id: 'fld_harbor',
      name: 'Harbor Diamond',
      sizes: ['50/70', '60/90']
    }),
    venueField({ id: 'fld_small', name: 'Small Diamond', sizes: ['T-ball'] })
  ]
})

function api(): TeamStationClient {
  const client = new TeamStationClient({ baseUrl: '/api/v1' })
  client.venues = async () => [harbor]
  client.venue = async () => HARBOR
  return client
}

async function toHarbor(): Promise<void> {
  await settle(50)
  await press('Harbor Field, 1 Demo Way, Demo City')
  await settle(20)
  expect(text()).includes('Harbor Diamond')
}

describe('the field picker', () => {
  afterEach(unmount)

  it('returns the venue’s field itself in field mode, with no size step', async () => {
    const chosen: Array<[VenueField, VenueDetail]> = []
    let closed = 0
    await mount(
      <FieldPickerScene
        client={api()}
        onChooseField={(field, venue) => {
          chosen.push([field, venue])
        }}
        onClose={() => {
          closed++
        }}
      />
    )
    expect(text()).includes('Choose field')
    await toHarbor()
    // A field that sets up in two sizes is returned as soon as it is tapped.
    await press('Harbor Diamond, 50/70 · 60/90')
    expect(text()).not.includes('Choose size')
    expect(chosen.map(([field, venue]) => [field.id, venue.id])).deep.equals([
      ['fld_harbor', 'ven_harbor']
    ])
    expect(chosen[0][0].sizes).deep.equals(['50/70', '60/90'])
    await tapLabel('Cancel field picker')
    expect(closed).equals(1)
  })

  it('still asks a game for the field’s size, and returns the field with it', async () => {
    const chosen: GameFieldSummary[] = []
    await mount(
      <FieldPickerScene
        client={api()}
        onChoose={field => {
          chosen.push(field)
        }}
        onClose={() => undefined}
      />
    )
    await toHarbor()
    await press('Harbor Diamond, 50/70 · 60/90')
    expect(text()).includes('Choose size')
    expect(chosen).deep.equals([])
    await tapLabel('Use 60/90')
    // A field with one size needs no size step.
    await press('Back')
    await press('Small Diamond, T-ball')
    expect(chosen).deep.equals([
      {
        venueId: 'ven_harbor',
        venueName: 'Harbor Field',
        fieldId: 'fld_harbor',
        fieldName: 'Harbor Diamond',
        size: '60/90',
        address: '1 Demo Way, Demo City'
      },
      {
        venueId: 'ven_harbor',
        venueName: 'Harbor Field',
        fieldId: 'fld_small',
        fieldName: 'Small Diamond',
        size: 'T-ball',
        address: '1 Demo Way, Demo City'
      }
    ])
  })
})
