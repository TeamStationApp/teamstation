import { expect } from 'chai'
import { afterEach, describe, it } from 'mocha'
import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'

import { TeamStationClient } from '../../common/api'
import type { Locality } from '../../common/locality'
import { ThemeProvider } from '../theme/ThemeContext'
import { LocalityPicker } from './LocalityPicker'

let root: Root | undefined
const original = Object.getOwnPropertyDescriptor(navigator, 'geolocation')
afterEach(async () => {
  await act(async () => root?.unmount())
  document.body.replaceChildren()
  if (original != null)
    Object.defineProperty(navigator, 'geolocation', original)
  else Reflect.deleteProperty(navigator, 'geolocation')
})
const place: Locality = {
  city: 'Demo City',
  region: 'Demo Region',
  country: 'US',
  placeId: '1',
  timezone: 'UTC'
}
async function press(label: string): Promise<void> {
  const button = [
    ...document.querySelectorAll<HTMLElement>('[role="button"]')
  ].find(
    node =>
      node.getAttribute('aria-label') === label || node.textContent === label
  )
  expect(button, label).not.equals(undefined)
  await act(async () => {
    button!.click()
  })
}
async function fill(label: string, value: string): Promise<void> {
  const input = document.querySelector<HTMLInputElement>(
    `input[aria-label="${label}"]`
  )!
  await act(async () => {
    Object.getOwnPropertyDescriptor(
      window.HTMLInputElement.prototype,
      'value'
    )!.set!.call(input, value)
    input.dispatchEvent(new window.Event('input', { bubbles: true }))
  })
}
async function mount(
  client: TeamStationClient,
  value: Locality | null = null
): Promise<Locality[]> {
  const chosen: Locality[] = []
  const host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
  await act(async () => {
    root!.render(
      <ThemeProvider>
        <LocalityPicker
          client={client}
          value={value}
          onChange={value => {
            chosen.push(value)
          }}
        />
      </ThemeProvider>
    )
  })
  return chosen
}
describe('locality selection', () => {
  it('confirms manual locality and validates incomplete input', async () => {
    const client = new TeamStationClient({ baseUrl: '/api/v1' })
    const chosen = await mount(client)
    await press('Enter location manually')
    await press('Confirm location')
    expect(document.body.textContent).includes('valid city')
    await fill('City', 'Demo City')
    await fill('State or region', 'Demo Region')
    await fill('Country', 'US')
    await press('Confirm location')
    expect(chosen[0]).property('city', 'Demo City')
    await press('Enter location manually')
    expect(document.querySelector('input[aria-label="City"]')).equals(null)
  })
  it('handles granted, denied and failed estimates with a usable manual fallback', async () => {
    const client = new TeamStationClient({ baseUrl: '/api/v1' })
    client.locationSuggestion = async () => place
    client.locations = async () => [place]
    Object.defineProperty(navigator, 'geolocation', {
      configurable: true,
      value: {
        getCurrentPosition: (
          success: (position: {
            coords: { latitude: number; longitude: number }
          }) => void
        ) => {
          success({ coords: { latitude: 1, longitude: 2 } })
        }
      }
    })
    const chosen = await mount(client, place)
    await press('Use my location')
    await press('Choose Demo City, Demo Region, US')
    expect(chosen).length(1)
    client.locationSuggestion = async () => null
    await press('Use my location')
    expect(document.body.textContent).includes('No nearby city')
    client.locationSuggestion = async () => {
      throw new Error('unavailable')
    }
    await press('Use my location')
    expect(document.body.textContent).includes('Location unavailable')
    Object.defineProperty(navigator, 'geolocation', {
      configurable: true,
      value: undefined
    })
    await press('Use my location')
    expect(document.body.textContent).includes('Search or enter a city')
    client.locations = async () => {
      throw new Error('unavailable')
    }
    await fill('Search city and state', 'Missing')
    await act(async () => {
      await new Promise(resolve => setTimeout(resolve, 280))
    })
    expect(document.body.textContent).includes('lookup is unavailable')
  })
})
