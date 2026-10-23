import { expect } from 'chai'
import { afterEach, describe, it } from 'mocha'
import React from 'react'

import { TeamStationClient } from '../../common/api'
import type { GameProposal } from '../../common/gameApprovals'
import { asGroupDetail, asPublicGroup } from '../../common/publicGroups'
import type { VenueSummary } from '../../common/venues'
import { mount, press, settle, text, unmount } from '../../test/gameFormDom'
import {
  hasLabel,
  tapLabel,
  venueDetail,
  venueField
} from '../../test/venueDom'
import { GameFormScreen } from './GameFormScreen'

const team = asPublicGroup({
  id: 'team_demo',
  kind: 'team',
  name: 'Demo Hawks',
  locality: null,
  imageUrl: null
})
const away = asPublicGroup({ ...team, id: 'team_away', name: 'Demo Eagles' })
const park: VenueSummary = {
  id: 'ven_demo',
  placeId: 'example-park',
  name: 'Example Park',
  address: '1 Example Way, Demo City',
  owners: [],
  pendingClaim: false,
  claimed: true,
  group: 'claimed',
  distanceKm: null
}

function api(venues: VenueSummary[] | Error = [park]): {
  client: TeamStationClient
  sent: GameProposal[]
} {
  const client = new TeamStationClient({ baseUrl: '/api/v1' })
  const sent: GameProposal[] = []
  client.discoverGroups = async () => [team, away]
  client.relatedTeams = async () => [team, away]
  client.ownGroups = async () => [team]
  client.group = async ref =>
    asGroupDetail({
      nonMemberView: false,
      group: ref.id === away.id ? away : team,
      parents: [],
      children: [],
      competingTeams: [],
      participatingSeasons: [],
      staff: [],
      games: [],
      canManage: true
    })
  client.venues = async () => {
    if (venues instanceof Error) throw venues
    return [
      ...venues,
      { ...park, id: null, placeId: 'google-only', name: 'Google Only' }
    ]
  }
  client.venue = async () =>
    venueDetail({
      fields: [
        venueField(),
        venueField({ id: 'fld_two', name: 'Field 2', sizes: ['60/90'] })
      ]
    })
  client.proposeGame = async body => {
    sent.push(body)
    return {
      id: 'request_demo',
      status: 'pending',
      gameId: null,
      proposedGameId: null,
      replacesGameId: null
    }
  }
  return { client, sent }
}

async function open(client: TeamStationClient): Promise<void> {
  await mount(
    <GameFormScreen
      client={client}
      mode={{ kind: 'create', source: { kind: 'team', id: team.id } }}
      onSaved={() => undefined}
      onCancel={() => undefined}
    />
  )
  await settle()
  await press('Choose Away Team')
  await settle()
  await press(`Choose ${away.name}`)
}

const locked = (label: string): boolean => input(label).readOnly
const input = (label: string): HTMLInputElement =>
  document.querySelector<HTMLInputElement>(`[aria-label="${label}"]`)!

describe('the Field row of the game form', () => {
  afterEach(unmount)

  it('chooses a venue, a field and its size, fills and locks the venue and address, and saves the field', async () => {
    const { client, sent } = api()
    await open(client)
    await press('Field: none chosen')
    await settle(400)
    expect(text()).not.includes('Google Only')
    await press('Example Park, 1 Example Way, Demo City')
    await settle()
    await press('Field 1, T-ball 46/60 · 50/70')
    await press('Back')
    await press('Field 1, T-ball 46/60 · 50/70')
    await tapLabel('Use 50/70')
    await settle()
    expect(hasLabel('Field: Example Park, Field 1, 50/70')).equals(true)
    expect(input('Venue name (optional)').value).equals('Example Park')
    expect(input('Venue address (optional)').value).equals(
      '1 Example Way, Demo City'
    )
    expect(locked('Venue name (optional)')).equals(true)
    // Locked fields look it: no clear button, and a line saying why.
    expect(
      document.querySelector('[aria-label="Clear Venue name (optional)"]')
    ).equals(null)
    expect(document.body.textContent).includes(
      'The venue and address come from the chosen field.'
    )
    expect(locked('Notes (optional)')).equals(false)
    await press('Save')
    await settle()
    expect(sent[0].game).include({
      fieldId: 'fld_one',
      fieldSize: '50/70',
      venue: 'Example Park',
      address: '1 Example Way, Demo City'
    })
  })

  it('takes a field’s only size, clears a field, and cancels without a change', async () => {
    const { client, sent } = api()
    await open(client)
    await press('Field: none chosen')
    await settle(400)
    await press('Cancel field picker')
    expect(hasLabel('Field: none chosen')).equals(true)
    await press('Field: none chosen')
    await settle(400)
    await press('Example Park, 1 Example Way, Demo City')
    await settle()
    await press('Field 2, 60/90')
    await settle()
    expect(hasLabel('Field: Example Park, Field 2, 60/90')).equals(true)
    await press('Clear field')
    expect(hasLabel('Field: none chosen')).equals(true)
    expect(locked('Venue name (optional)')).equals(false)
    expect(document.body.textContent).not.includes(
      'The venue and address come from the chosen field.'
    )
    await press('Save')
    await settle()
    expect(Object.keys(sent[0].game)).not.includes('fieldId')
  })

  it('says when no venue matches, and when the list fails', async () => {
    await open(api([]).client)
    await press('Field: none chosen')
    await settle(400)
    expect(text()).includes('No venues in the registry match')
    await unmount()
    await open(api(new Error('down')).client)
    await press('Field: none chosen')
    await settle(400)
    expect(text()).includes('Venues could not load')
  })
})
