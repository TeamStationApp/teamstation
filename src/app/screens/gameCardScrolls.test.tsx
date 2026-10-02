import { expect } from 'chai'
import { afterEach, describe, it } from 'mocha'
import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { GestureHandlerRootView } from 'react-native-gesture-handler'

import { TeamStationClient } from '../../common/api'
import { gameFixture } from '../scoring/isUnscoredGame.test'
import { ThemeProvider } from '../theme/ThemeContext'
import { GameScreen } from './GameScreen'

let root: Root | undefined

/**
 * A window of this size, as react-native-web reads one: jsdom lays nothing
 * out, so the page would otherwise be drawn for a window with no height.
 */
async function windowOf(width: number, height: number): Promise<void> {
  const html = document.documentElement
  Object.defineProperty(html, 'clientWidth', {
    configurable: true,
    value: width
  })
  Object.defineProperty(html, 'clientHeight', {
    configurable: true,
    value: height
  })
  await act(async () => {
    window.dispatchEvent(new window.Event('resize'))
  })
}

afterEach(async function () {
  await act(async () => {
    root?.unmount()
  })
  root = undefined
  await windowOf(0, 0)
})

/** A phone held upright: tall enough that the card could stay put. */
async function gamePage(): Promise<HTMLElement> {
  await windowOf(393, 852)
  const client = new TeamStationClient({ baseUrl: '/api/v1' })
  client.game = async () => gameFixture
  client.teams = async () => []
  const node = document.createElement('div')
  document.body.appendChild(node)
  root = createRoot(node)
  await act(async () => {
    root?.render(
      <ThemeProvider>
        <GestureHandlerRootView>
          <GameScreen client={client} gameId="g1" />
        </GestureHandlerRootView>
      </ThemeProvider>
    )
  })
  const pane = document.querySelector<HTMLElement>(
    '[data-testid="gameSection"]'
  )
  if (pane == null) throw new Error('no section pane')
  return pane
}

function pill(label: string): HTMLElement | null {
  return document.querySelector(`[aria-label="${label}"]`)
}

describe('the game page’s card', function () {
  it('scrolls away above the picture on Videos, which then pegs under the header', async function () {
    const pane = await gamePage()
    // The card and its pills are in the section's own scroller rather than
    // fixed above it.
    expect(pane.contains(pill('Videos'))).equals(true)
    expect(pane.textContent).includes('Owls')
    // And they come first in that scroller, before the block that sticks.
    const sticky = Array.from(pane.querySelectorAll<HTMLElement>('div')).find(
      node => node.style.position === 'sticky'
    )
    if (sticky == null) throw new Error('no pegged player block')
    const content = sticky.parentElement
    const card = content?.firstElementChild
    expect(card).not.equals(sticky)
    expect(card?.textContent).includes('Owls')
    expect(card?.contains(pill('Box score'))).equals(true)
  })

  it('scrolls with the box score too, from the same place at the top', async function () {
    await gamePage()
    await act(async () => {
      pill('Box score')?.click()
    })
    const pane = document.querySelector('[data-testid="gameSection"]')
    expect(pane?.contains(pill('Box score'))).equals(true)
    expect(pane?.textContent).includes('Owls')
  })
})
