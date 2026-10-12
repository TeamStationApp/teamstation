import { expect } from 'chai'
import { afterEach, describe, it } from 'mocha'
import React, { act, useState } from 'react'
import { createRoot, type Root } from 'react-dom/client'

import type { RsvpChoice } from '../../common/eventInfo'
import { ThemeProvider } from '../theme/ThemeContext'
import { EventRsvpPill } from './EventRsvpPill'

let root: Root | undefined
afterEach(async () => {
  await act(async () => root?.unmount())
  root = undefined
  document.body.replaceChildren()
})
async function render(disabled = false): Promise<string[]> {
  const choices: string[] = []
  function Harness(): React.ReactElement {
    const [value, setValue] = useState<RsvpChoice>(null)
    return (
      <EventRsvpPill
        userId={101}
        name="Babe Ruth"
        value={value}
        disabled={disabled}
        onChange={next => {
          choices.push(next)
          setValue(next)
        }}
      />
    )
  }
  const host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
  await act(async () => {
    root!.render(
      <ThemeProvider>
        <Harness />
      </ThemeProvider>
    )
  })
  return choices
}
const region = (index: number): HTMLElement =>
  document.querySelector(`[data-testid="event-rsvp-101-${index}"]`)!
async function click(index: number): Promise<void> {
  await act(async () => {
    region(index).click()
  })
}
describe('the independent RSVP capsule', () => {
  it('starts with No reply, changes center to Maybe, and offers accessible radio choices', async () => {
    const choices = await render()
    expect(region(1).getAttribute('aria-checked')).equals('true')
    expect(region(1).textContent).equals('No reply')
    await click(1)
    expect(choices).deep.equals([])
    await click(0)
    expect(region(1).textContent).equals('Maybe')
    expect(region(0).getAttribute('aria-checked')).equals('true')
    await click(1)
    await click(2)
    expect(choices).deep.equals(['yes', 'maybe', 'no'])
    expect(region(2).getAttribute('aria-checked')).equals('true')
    const track = document.querySelector(
      '[data-testid="event-rsvp-101"]'
    ) as unknown as {
      __reactLayoutHandler: (event: {
        nativeEvent: { layout: { width: number } }
      }) => void
    }
    await act(async () => {
      track.__reactLayoutHandler({ nativeEvent: { layout: { width: 216 } } })
    })
    await act(async () => {
      await new Promise(resolve => setTimeout(resolve, 220))
    })
    const fill = document.querySelector<HTMLElement>(
      '[data-testid="event-rsvp-101-fill"]'
    )!
    expect(getComputedStyle(fill).backgroundColor).equals('rgb(203, 57, 65)')
    expect(getComputedStyle(fill).transform).includes('144')
  })
  it('disables every choice during its own write', async () => {
    const choices = await render(true)
    await click(0)
    await click(2)
    expect(choices).deep.equals([])
    expect(region(0).getAttribute('aria-disabled')).equals('true')
  })
})
