import { expect } from 'chai'
import { afterEach, describe, it } from 'mocha'
import React, { act } from 'react'

import type { TeamStationClient } from '../../common/api'
import type { Locality } from '../../common/locality'
import {
  fill,
  find,
  mount,
  press,
  settle,
  text,
  unmount
} from '../../test/gameFormDom'
import { cityListHeight, LocationScreen } from './LocationScreen'

const austin: Locality = {
  city: 'Austin',
  region: 'Texas',
  country: 'United States',
  placeId: 'google:austin',
  timezone: 'America/Chicago'
}
const row = {
  id: 'google:austin',
  primary: 'Austin',
  secondary: 'Texas, United States'
}
function fixture(): {
  client: TeamStationClient
  searches: Array<{ query: string; session: string }>
  details: string[]
  saves: Locality[]
  canceled: number[]
} {
  const searches: Array<{ query: string; session: string }> = []
  const details: string[] = []
  const saves: Locality[] = []
  const canceled: number[] = []
  const client = {
    citySuggestions: async (query: string, session: string) => {
      searches.push({ query, session })
      return {
        suggestions: [row],
        provider: 'google' as const,
        attribution: 'Powered by Google'
      }
    },
    location: async (_id: string, session: string) => {
      details.push(session)
      return austin
    }
  } as unknown as TeamStationClient
  return { client, searches, details, saves, canceled }
}
async function open(
  f: ReturnType<typeof fixture>,
  current: Locality | null = null
): Promise<void> {
  await mount(
    <LocationScreen
      client={f.client}
      current={current}
      onSave={async value => {
        f.saves.push(value)
      }}
      onCancel={() => {
        f.canceled.push(1)
      }}
    />
  )
}
describe('search-only city selection', () => {
  afterEach(unmount)
  it('reflows the suggestion list when the browser keyboard changes the visual viewport', async () => {
    const original = Object.getOwnPropertyDescriptor(window, 'visualViewport')
    const listeners = new Map<string, () => void>()
    const viewport = {
      height: 874,
      addEventListener: (event: string, listener: () => void) => {
        listeners.set(event, listener)
      },
      removeEventListener: (event: string) => {
        listeners.delete(event)
      }
    }
    Object.defineProperty(window, 'visualViewport', {
      configurable: true,
      value: viewport
    })
    try {
      const f = fixture()
      await open(f)
      await act(async () => {
        listeners.get('resize')!()
      })
      await fill('City', 'aus')
      await settle(300)
      const list = document.querySelector<HTMLElement>(
        '[data-testid="city-suggestions"]'
      )!
      expect(list.style.height).equals('352px')
      await act(async () => {
        viewport.height = 400
        listeners.get('resize')!()
      })
      expect(parseFloat(list.style.height)).lessThan(352).and.at.least(56)
      await unmount()
      expect(listeners.size).equals(0)
    } finally {
      if (original == null) Reflect.deleteProperty(window, 'visualViewport')
      else Object.defineProperty(window, 'visualViewport', original)
    }
  })
  it('keeps short searches local and saves the resolved city and its time zone', async () => {
    const f = fixture()
    await open(f)
    expect(text()).includes('Location not set')
    expect(text())
      .not.includes('Use my location')
      .and.not.includes('Enter location manually')
    expect(find('Save')?.getAttribute('aria-disabled')).equals('true')
    expect(getComputedStyle(find('Cancel')!).alignSelf).equals('center')
    await fill('City', 'a')
    await settle(300)
    expect(f.searches).length(0)
    await fill('City', 'au')
    await settle(300)
    expect(f.searches).length(1)
    await press('Choose Austin, Texas, United States')
    await settle()
    expect(f.details).deep.equals([f.searches[0].session])
    expect(text()).includes('Save to use Austin, Texas, United States')
    await press('Save')
    expect(f.saves).deep.equals([austin])
  })
  it('starts another search session after a choice or clearing the field', async () => {
    const f = fixture()
    await open(f, austin)
    await fill('City', 'au')
    await settle(300)
    const first = f.searches[0].session
    await press('Choose Austin, Texas, United States')
    await settle()
    await fill('City', 'tor')
    await settle(300)
    expect(f.searches.at(-1)!.session).not.equals(first)
    const second = f.searches.at(-1)!.session
    await press('Clear City')
    await fill('City', 'au')
    await settle(300)
    expect(f.searches.at(-1)!.session).not.equals(second)
    await press('Cancel')
    expect(f.canceled).length(1)
    expect(f.saves).length(0)
  })
  it('shows lookup failure in the list and leaves saving failures recoverable', async () => {
    const f = fixture()
    f.client.citySuggestions = async () => {
      throw new Error('Provider unavailable')
    }
    await open(f)
    await fill('City', 'aus')
    await settle(300)
    expect(text()).includes('City lookup is unavailable. Try again.')
    await unmount()
    const good = fixture()
    await mount(
      <LocationScreen
        client={good.client}
        current={null}
        onCancel={() => undefined}
        onSave={async () => {
          throw new Error('Save unavailable')
        }}
      />
    )
    await fill('City', 'aus')
    await settle(300)
    await press('Choose Austin, Texas, United States')
    await settle()
    await press('Save')
    expect(text()).includes('Save unavailable')
    expect(find('Save')?.getAttribute('aria-disabled')).not.equals('true')
  })
  it('shows empty results and details failures without choosing a locality', async () => {
    const f = fixture()
    f.client.citySuggestions = async () => ({
      suggestions: [],
      provider: 'geonames',
      attribution: 'GeoNames'
    })
    await open(f)
    await fill('City', 'zz')
    await settle(300)
    expect(text())
      .includes('No city matches')
      .and.not.includes('Powered by Google')
    await unmount()
    const failed = fixture()
    failed.client.location = async () => {
      throw new Error('Details unavailable')
    }
    await open(failed)
    await fill('City', 'aus')
    await settle(300)
    await press('Choose Austin, Texas, United States')
    await settle()
    expect(text()).includes('City lookup is unavailable. Try again.')
    expect(find('Save')?.getAttribute('aria-disabled')).equals('true')
  })
  it('fits the list between the field, keyboard and footer', () => {
    expect(cityListHeight(874, 160, 120)).equals(352)
    expect(cityListHeight(400, 160, 120)).equals(104)
    expect(cityListHeight(100, 160, 120)).equals(56)
  })
})
