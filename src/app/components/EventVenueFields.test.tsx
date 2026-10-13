import { expect } from 'chai'
import { afterEach, describe, it } from 'mocha'
import React, { act, useState } from 'react'
import { createRoot, type Root } from 'react-dom/client'

import { TeamStationClient } from '../../common/api'
import type { EventPlace } from '../../common/eventPlaces'
import { ThemeProvider } from '../theme/ThemeContext'
import { type EventVenueDraft, EventVenueFields } from './EventVenueFields'

let root: Root | undefined
let draft: EventVenueDraft
const place = {
  id: 'demo',
  name: 'Demo Park',
  address: '1 Demo Way, Demo City'
}
const tick = async (): Promise<void> => {
  await act(async () => {
    await new Promise(resolve => setTimeout(resolve, 350))
  })
}
async function render(
  client: TeamStationClient,
  disabled = false
): Promise<void> {
  const host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
  function Harness(): React.ReactElement {
    const [value, setValue] = useState({
      venue: 'Loaded name',
      address: 'Loaded address',
      notes: ''
    })
    draft = value
    return (
      <EventVenueFields
        client={client}
        value={value}
        onChange={setValue}
        disabled={disabled}
      />
    )
  }
  await act(async () => {
    root!.render(
      <ThemeProvider>
        <Harness />
      </ThemeProvider>
    )
  })
}
async function input(label: string, text: string): Promise<void> {
  const field = document.querySelector<HTMLInputElement | HTMLTextAreaElement>(
    `[aria-label="${label}"]`
  )!
  await act(async () => {
    field.focus()
    Object.getOwnPropertyDescriptor(
      field.tagName === 'TEXTAREA'
        ? window.HTMLTextAreaElement.prototype
        : window.HTMLInputElement.prototype,
      'value'
    )!.set!.call(field, text)
    field.dispatchEvent(new window.Event('input', { bubbles: true }))
  })
}
async function press(label: string): Promise<void> {
  const button = [
    ...document.querySelectorAll<HTMLElement>('[role="button"]')
  ].find(
    node => (node.getAttribute('aria-label') ?? node.textContent) === label
  )!
  expect(button, label).not.equals(null)
  await act(async () => {
    button.click()
  })
}
describe('shared optional venue autocomplete and notes fields', () => {
  afterEach(async () => {
    await act(async () => root?.unmount())
    root = undefined
    document.body.replaceChildren()
  })
  it('does not look up loaded text and fills names/addresses only after a suggestion is chosen', async () => {
    const client = new TeamStationClient({ baseUrl: '/api/v1' })
    const queries: string[] = []
    client.eventPlaces = async (q, kind) => {
      queries.push(`${kind}:${q}`)
      return [place]
    }
    await render(client)
    await tick()
    expect(queries).length(0)
    await input('Venue name (optional)', 'Demo')
    await tick()
    expect(draft.venue).equals('Demo')
    await press('Choose Demo Park')
    expect(draft).includes({ venue: 'Demo Park', address: place.address })
    await input('Venue name (optional)', 'Custom field')
    await input('Venue address (optional)', '1 Demo')
    await tick()
    await press('Choose Demo Park')
    expect(draft.venue).equals('Custom field')
    await input('Venue name (optional)', '')
    await input('Venue address (optional)', '1 Demo')
    await tick()
    await press('Choose Demo Park')
    expect(draft.venue).equals('Demo Park')
    await input('Notes (optional)', 'Field 2\nMeet by gate')
    expect(draft.notes).equals('Field 2\nMeet by gate')
    expect(
      document
        .querySelector('[aria-label="Notes (optional)"]')
        ?.getAttribute('maxlength')
    ).equals('2000')
  })
  it('invalidates late results on edits, focus changes, selection and unmount; preserves manual text', async () => {
    const client = new TeamStationClient({ baseUrl: '/api/v1' })
    const completions: Array<(places: EventPlace[]) => void> = []
    client.eventPlaces = async () =>
      await new Promise(resolve => completions.push(resolve))
    await render(client)
    await input('Venue name (optional)', 'Old')
    await tick()
    await input('Venue name (optional)', 'New')
    await act(async () => {
      completions[0]([place])
    })
    expect(document.body.textContent).not.includes('Demo Park')
    await tick()
    await act(async () => {
      document
        .querySelector<HTMLInputElement>(
          '[aria-label="Venue address (optional)"]'
        )!
        .focus()
    })
    await act(async () => {
      completions[1]([place])
    })
    expect(document.body.textContent).not.includes('Demo Park')
    expect(draft.venue).equals('New')
    await input('Venue address (optional)', 'Third')
    await tick()
    await act(async () => {
      document
        .querySelector<HTMLInputElement>(
          '[aria-label="Venue name (optional)"]'
        )!
        .focus()
    })
    await act(async () => {
      completions[2]([place])
    })
    expect(document.body.textContent).not.includes('Demo Park')
    await input('Venue name (optional)', 'Last')
    await tick()
    await act(async () => {
      root!.unmount()
    })
    root = undefined
    await act(async () => {
      completions[3]([place])
    })
  })
  it('shows empty/failure states with retry and permits manual values; skips short/long/disabled queries', async () => {
    const client = new TeamStationClient({ baseUrl: '/api/v1' })
    let calls = 0
    client.eventPlaces = async () => {
      calls++
      if (calls === 1) throw new Error('offline')
      return []
    }
    await render(client)
    await input('Venue name (optional)', 'D')
    await tick()
    expect(calls).equals(0)
    await input('Venue name (optional)', 'Demo')
    await tick()
    expect(document.body.textContent).includes('Suggestions unavailable')
    await press('Retry place suggestions')
    await tick()
    expect(document.body.textContent).includes('No suggestions')
    expect(draft.venue).equals('Demo')
    await input('Venue name (optional)', 'x'.repeat(121))
    await tick()
    expect(calls).equals(2)
    await act(async () => {
      root!.unmount()
    })
    root = undefined
    document.body.replaceChildren()
    await render(client, true)
    await tick()
    expect(calls).equals(2)
    expect(
      document
        .querySelector('[aria-label="Venue name (optional)"]')
        ?.getAttribute('readonly')
    ).not.equals(null)
  })
})
