import { expect } from 'chai'
import { afterEach, describe, it } from 'mocha'
import React, { act, useState } from 'react'
import { createRoot, type Root } from 'react-dom/client'

import { TeamStationClient } from '../../common/api'
import type { Locality } from '../../common/locality'
import { ThemeProvider } from '../theme/ThemeContext'
import { LeagueCityField } from './LeagueCityField'

let root: Root | undefined
afterEach(async () => {
  await act(async () => root?.unmount())
  document.body.replaceChildren()
})
const place: Locality = {
  city: 'Demo City',
  region: 'Demo Region',
  country: 'US',
  placeId: '1',
  timezone: 'UTC'
}
function Harness({
  client,
  onChange,
  onBrowsing
}: {
  client: TeamStationClient
  onChange: (value: Locality | null) => void
  onBrowsing: (browsing: boolean) => void
}): React.ReactElement {
  const [value, setValue] = useState<Locality | null>(null)
  return (
    <LeagueCityField
      client={client}
      value={value}
      onChange={next => {
        setValue(next)
        onChange(next)
      }}
      onBrowsing={onBrowsing}
    />
  )
}
async function mount(
  client: TeamStationClient,
  onChange: (value: Locality | null) => void,
  onBrowsing: (browsing: boolean) => void
): Promise<void> {
  const host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
  await act(async () => {
    root!.render(
      <ThemeProvider>
        <Harness client={client} onChange={onChange} onBrowsing={onBrowsing} />
      </ThemeProvider>
    )
  })
}
async function focusAndFill(value: string): Promise<void> {
  const input = document.querySelector<HTMLInputElement>(
    'input[aria-label="City"]'
  )!
  await act(async () => {
    input.focus()
    input.dispatchEvent(new window.Event('focus', { bubbles: true }))
    Object.getOwnPropertyDescriptor(
      window.HTMLInputElement.prototype,
      'value'
    )!.set!.call(input, value)
    input.dispatchEvent(new window.Event('input', { bubbles: true }))
  })
}
async function press(label: string): Promise<void> {
  const button = [
    ...document.querySelectorAll<HTMLElement>('[role="button"]')
  ].find(node => node.getAttribute('aria-label') === label)
  expect(button, label).not.equals(undefined)
  await act(async () => {
    button!.click()
  })
}
describe('league city field', () => {
  it('fills the field from a row and drops the dropdown', async () => {
    const client = new TeamStationClient({ baseUrl: '/api/v1' })
    client.locations = async () => [place]
    const chosen: Array<Locality | null> = []
    const browsing: boolean[] = []
    await mount(
      client,
      value => {
        chosen.push(value)
      },
      value => {
        browsing.push(value)
      }
    )
    expect(document.body.textContent).not.includes('Save')
    await focusAndFill('De')
    await act(async () => {
      await new Promise(resolve => setTimeout(resolve, 280))
    })
    expect(browsing.at(-1)).equals(true)
    expect(document.body.textContent).includes('GeoNames')
    await press('Choose Demo City, Demo Region, US')
    expect(chosen[0]).deep.equals(place)
    expect(
      document.querySelector<HTMLInputElement>('input[aria-label="City"]')!
        .value
    ).equals('Demo City, Demo Region, US')
    expect(document.body.textContent).not.includes('Choose Demo City')
    expect(browsing.at(-1)).equals(false)
  })
  it('clears a choice when the field is edited and reports a failed lookup', async () => {
    const client = new TeamStationClient({ baseUrl: '/api/v1' })
    let calls = 0
    client.locations = async () => {
      calls++
      if (calls === 1) return [place]
      throw new Error('offline')
    }
    const chosen: Array<Locality | null> = []
    await mount(
      client,
      value => {
        chosen.push(value)
      },
      () => undefined
    )
    await focusAndFill('D')
    await act(async () => {
      await new Promise(resolve => setTimeout(resolve, 280))
    })
    expect(calls).equals(0)
    await focusAndFill('De')
    await act(async () => {
      await new Promise(resolve => setTimeout(resolve, 280))
    })
    await press('Choose Demo City, Demo Region, US')
    await focusAndFill('Demo C')
    expect(chosen.at(-1)).equals(null)
    await act(async () => {
      await new Promise(resolve => setTimeout(resolve, 280))
    })
    expect(document.body.textContent).includes('lookup is unavailable')
  })
})
