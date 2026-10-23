import { expect } from 'chai'
import { afterEach, describe, it } from 'mocha'
import React, { act } from 'react'

import type { TeamStationClient } from '../../common/api'
import type { VenueSummary } from '../../common/venues'
import { CoverableScene, coverAndReveal } from '../../test/coverableScene'
import {
  fill,
  find,
  mount,
  settle,
  text,
  unmount
} from '../../test/gameFormDom'
import { FieldManagerScreen } from './FieldManagerScreen'

const OWN: VenueSummary = {
  id: 'ven_demo',
  placeId: 'example-park',
  name: 'Example Park',
  address: '1 Example Way',
  owners: [{ claimId: 'vcl_a', leagueId: 'lea_a', name: 'Demo League A' }],
  pendingClaim: false,
  claimed: true,
  group: 'yours',
  distanceKm: null
}

describe('the Field Manager', () => {
  afterEach(unmount)

  it('lists and searches while the location prompt is unanswered, then sorts by distance once it is', async () => {
    const asked: Array<{ query?: string; near?: unknown }> = []
    let answer: (position: {
      latitude: number
      longitude: number
    }) => void = () => undefined
    const client = {
      venues: async (options: { query?: string; near?: unknown }) => {
        asked.push(options)
        return [OWN]
      }
    } as unknown as TeamStationClient
    const pending = new Promise<{ latitude: number; longitude: number }>(
      resolve => {
        answer = resolve
      }
    )
    const locate = async (): Promise<{ latitude: number; longitude: number }> =>
      await pending
    await mount(
      <FieldManagerScreen
        client={client}
        onOpenVenue={() => undefined}
        onOpenPlace={() => undefined}
        locate={locate}
      />
    )
    await settle(50)
    expect(text()).includes('Example Park')
    expect(asked).deep.equals([{ query: '', near: undefined }])
    await fill('Search venues', 'Park')
    await settle(400)
    expect(asked.at(-1)).deep.equals({ query: 'Park', near: undefined })
    await act(async () => {
      answer({ latitude: 40, longitude: -75 })
      await pending
    })
    await settle(400)
    expect(asked.at(-1)).deep.equals({
      query: 'Park',
      near: { latitude: 40, longitude: -75 }
    })
  })

  it('reads the list again on coming back from a venue', async () => {
    const asked: Array<{ query?: string }> = []
    const client = {
      venues: async (options: { query?: string }) => {
        asked.push(options)
        return [OWN]
      }
    } as unknown as TeamStationClient
    await mount(
      <CoverableScene>
        <FieldManagerScreen
          client={client}
          locate={async () => null}
          onOpenVenue={() => undefined}
          onOpenPlace={() => undefined}
        />
      </CoverableScene>
    )
    await settle(20)
    const reads = asked.length
    expect(reads).greaterThan(0)
    await coverAndReveal()
    await settle(20)
    expect(asked.length).equals(reads + 1)
  })

  it('lists every place a search finds, after the person’s own venues', async () => {
    const parks = Array.from({ length: 13 }, (_, index): VenueSummary => ({
      id: null,
      placeId: `park-${index}`,
      name: `Demo Park ${index + 1}`,
      address: `${index + 1} Park Row, Demo City`,
      owners: [],
      pendingClaim: false,
      claimed: false,
      group: 'unclaimed',
      distanceKm: null
    }))
    const client = {
      venues: async ({ query }: { query?: string }) =>
        query === '' ? [OWN] : [OWN, ...parks]
    } as unknown as TeamStationClient
    await mount(
      <FieldManagerScreen
        client={client}
        onOpenVenue={() => undefined}
        onOpenPlace={() => undefined}
        locate={async () => await Promise.reject(new Error('denied'))}
      />
    )
    await settle(50)
    await fill('Search venues', 'Park')
    await settle(400)
    expect(text()).includes('Unclaimed venues')
    for (const park of parks)
      expect(find(`Open ${park.name}`), park.name).not.equals(undefined)
    expect(text().indexOf('Example Park')).lessThan(
      text().indexOf('Demo Park 1')
    )
  })
})
