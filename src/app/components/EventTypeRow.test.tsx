import { expect } from 'chai'
import { afterEach, describe, it } from 'mocha'
import React, { act, useState } from 'react'
import { createRoot, type Root } from 'react-dom/client'

import type { EventType } from '../../common/eventInfo'
import { ThemeProvider } from '../theme/ThemeContext'
import { EventTypeRow } from './EventTypeRow'

let root: Root | undefined
describe('three-position event type slider', () => {
  afterEach(async () => {
    await act(async () => root?.unmount())
    root = undefined
    document.body.replaceChildren()
  })
  it('supports direct and keyboard choices in an accessible row', async () => {
    let type: EventType = 'game'
    function Harness(): React.ReactElement {
      const [value, setValue] = useState<EventType>('game')
      type = value
      return <EventTypeRow value={value} onChange={setValue} />
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
    expect(document.body.textContent).includes('Event Type')
    expect(
      document.querySelector<HTMLElement>('[data-testid="event-type-fill"]')!
        .style.backgroundColor
    ).equals('rgb(43, 66, 33)')
    const practice = document.querySelector<HTMLElement>(
      '[aria-label="Practice"]'
    )!
    await act(async () => {
      practice.click()
    })
    expect(type).equals('practice')
    expect(practice.getAttribute('aria-checked')).equals('true')
    await act(async () =>
      practice.dispatchEvent(
        new window.KeyboardEvent('keydown', {
          key: 'ArrowRight',
          bubbles: true
        })
      )
    )
    expect(type).equals('other')
    await act(async () => {
      document.querySelector<HTMLElement>('[aria-label="Game"]')!.click()
    })
    expect(type).equals('game')
  })
  it('keeps the selected type when an unavailable Game choice is pressed or reached by keyboard', async () => {
    const host = document.createElement('div')
    document.body.append(host)
    root = createRoot(host)
    let calls = 0
    await act(async () => {
      root!.render(
        <ThemeProvider>
          <EventTypeRow
            value="practice"
            gameAvailable={false}
            onChange={() => {
              calls++
            }}
          />
        </ThemeProvider>
      )
    })
    const game = document.querySelector<HTMLElement>('[aria-label="Game"]')!
    expect(game.getAttribute('aria-disabled')).equals('true')
    await act(async () => {
      game.click()
    })
    await act(async () =>
      document
        .querySelector<HTMLElement>('[aria-label="Practice"]')!
        .dispatchEvent(
          new window.KeyboardEvent('keydown', {
            key: 'ArrowLeft',
            bubbles: true
          })
        )
    )
    expect(calls).equals(0)
    expect(
      document
        .querySelector('[aria-label="Practice"]')!
        .getAttribute('aria-checked')
    ).equals('true')
  })
})
