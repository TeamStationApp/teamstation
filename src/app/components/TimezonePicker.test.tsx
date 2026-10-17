import { expect } from 'chai'
import { afterEach, describe, it } from 'mocha'
import React, { act } from 'react'

import type { TeamStationClient } from '../../common/api'
import type { Locality } from '../../common/locality'
import {
  fill,
  mount,
  press,
  settle,
  text,
  unmount
} from '../../test/gameFormDom'
import { TimezonePicker } from './EventScheduleFields'

const city = {
  id: 'city-1',
  primary: 'Springfield',
  secondary: 'Illinois, United States'
}
const location: Locality = {
  city: city.primary,
  region: 'Illinois',
  country: 'US',
  placeId: city.id,
  timezone: 'America/Chicago'
}
type Client = Pick<TeamStationClient, 'citySuggestions' | 'location'>
const result = {
  suggestions: [city],
  provider: 'google' as const,
  attribution: 'Powered by Google'
}

describe('timezone city selection', () => {
  afterEach(unmount)
  async function open(client: Client, chosen: string[]): Promise<void> {
    await mount(
      <TimezonePicker
        client={client}
        value="UTC"
        onChoose={zone => {
          chosen.push(zone)
        }}
        onCancel={() => {
          chosen.push('cancel')
        }}
      />
    )
    await fill('Find time zone', 'Springfield')
    await settle(300)
  }
  it('disambiguates cities and resolves their IANA zone', async () => {
    const chosen: string[] = []
    await open(
      { citySuggestions: async () => result, location: async () => location },
      chosen
    )
    expect(text()).includes(city.secondary)
    expect(text()).includes('Powered by Google')
    await press(`Use city ${city.primary}, ${city.secondary}`)
    expect(chosen).deep.equals(['America/Chicago'])
  })
  it('retries failed searches and failed city resolution', async () => {
    const chosen: string[] = []
    let searches = 0
    let resolutions = 0
    await open(
      {
        citySuggestions: async () => {
          if (++searches === 1) throw Error('offline')
          return result
        },
        location: async () => {
          if (++resolutions === 1) throw Error('offline')
          return location
        }
      },
      chosen
    )
    expect(text()).includes('City lookup is unavailable')
    await press('Retry city search')
    await settle(300)
    await press(`Use city ${city.primary}, ${city.secondary}`)
    expect(text()).includes('time zone could not load')
    expect(chosen).deep.equals([])
    await press(`Use city ${city.primary}, ${city.secondary}`)
    expect(chosen).deep.equals(['America/Chicago'])
  })
  it('ignores late search responses and resolves only the latest query', async () => {
    let complete!: (value: typeof result) => void
    const chosen: string[] = []
    await open(
      {
        citySuggestions: async query =>
          query === 'Springfield'
            ? await new Promise(resolve => {
                complete = resolve
              })
            : { ...result, suggestions: [] },
        location: async () => location
      },
      chosen
    )
    await fill('Find time zone', 'No such city')
    await settle(300)
    await act(async () => {
      complete(result)
    })
    expect(text()).not.includes(city.secondary)
    expect(text()).includes('No matching cities or time zones')
  })
  for (const exit of ['query', 'cancel', 'zone', 'unmount'])
    it(`ignores an in-flight city selection after ${exit}`, async () => {
      let complete!: (value: Locality) => void
      const chosen: string[] = []
      await open(
        {
          citySuggestions: async () => result,
          location: async () =>
            await new Promise(resolve => {
              complete = resolve
            })
        },
        chosen
      )
      await press(`Use city ${city.primary}, ${city.secondary}`)
      if (exit === 'query' || exit === 'zone')
        await fill('Find time zone', 'UTC')
      if (exit === 'cancel') await press('Cancel time zone picker')
      if (exit === 'zone') await press('Use time zone UTC')
      if (exit === 'unmount') await unmount()
      await act(async () => {
        complete(location)
      })
      expect(chosen).deep.equals(
        exit === 'cancel' ? ['cancel'] : exit === 'zone' ? ['UTC'] : []
      )
    })
})
