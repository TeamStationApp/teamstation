import { expect } from 'chai'
import { afterEach, describe, it } from 'mocha'
import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { GestureHandlerRootView } from 'react-native-gesture-handler'

import { asBattingRow, TeamStationClient } from '../../common/api'
import { gameFixture } from '../scoring/isUnscoredGame.test'
import { ThemeProvider } from '../theme/ThemeContext'
import { tsBallpark } from '../theme/tsBallpark'
import { GameScreen } from './GameScreen'

let root: Root | undefined
let host: HTMLElement | undefined

afterEach(async function () {
  await act(async () => {
    root?.unmount()
  })
  root = undefined
  host?.remove()
  host = undefined
})

/** `#F5F7F1` → `rgb(245, 247, 241)`, as the computed style reports it. */
function rgb(hex: string): string {
  const channel = (at: number): number => parseInt(hex.slice(at, at + 2), 16)
  return `rgb(${channel(1)}, ${channel(3)}, ${channel(5)})`
}

/**
 * The pinned cells showing `text`: the leaves `position: sticky` holds. The
 * text is checked first, because computing every element's style is slow.
 */
function pinned(container: HTMLElement, text: string): HTMLElement[] {
  return Array.from(container.querySelectorAll<HTMLElement>('*')).filter(
    node =>
      node.children.length === 0 &&
      node.textContent === text &&
      getComputedStyle(node).position === 'sticky'
  )
}

async function boxScore(): Promise<HTMLElement> {
  const client = new TeamStationClient({ baseUrl: '/api/v1' })
  client.game = async () => ({
    ...gameFixture,
    linescore: {
      away: { runs: [1, 0], r: 1, h: 2, e: 0, bb: 0, k: 2, hr: 0, hbp: 0 },
      home: { runs: [0], r: 0, h: 1, e: 0, bb: 0, k: 1, hr: 0, hbp: 0 }
    }
  })
  client.teams = async () => []
  client.boxScore = async () => ({
    stats: undefined,
    batting: [
      asBattingRow({
        userId: 1,
        shortName: 'Alex',
        teamId: 'away',
        pa: 2,
        ab: 2,
        h: 1,
        singles: 1,
        doubles: 0,
        triples: 0,
        hr: 0,
        bb: 0,
        k: 1,
        hbp: 0,
        rbi: 1,
        rates: { avg: 0.5, obp: 0.5, slg: 0.5, ops: 1 }
      })
    ],
    pitching: []
  })
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
  await act(async () => {
    root?.render(
      <ThemeProvider>
        <GestureHandlerRootView>
          <GameScreen client={client} gameId="g1" initialTab="boxScore" />
        </GestureHandlerRootView>
      </ThemeProvider>
    )
  })
  await act(async () => {
    await new Promise(resolve => setTimeout(resolve, 0))
  })
  return host
}

describe('the box score', function () {
  it('draws the line score’s pinned names, and the cell above them, on the card’s white', async function () {
    this.timeout(10000)
    const container = await boxScore()
    const card = rgb(tsBallpark.cardBackgroundColor)
    for (const name of ['Owls', 'Hawks']) {
      const [cell] = pinned(container, name)
      expect(cell, `pinned ${name}`).not.equals(undefined)
      expect(getComputedStyle(cell).backgroundColor, name).equals(card)
    }
    // The line score's head row comes first; its pinned cell is empty.
    const [head] = pinned(container, '')
    expect(head, 'pinned head cell').not.equals(undefined)
    expect(getComputedStyle(head).backgroundColor).equals(card)
  })

  it('keeps the page colour behind a batting table’s pinned names', async function () {
    this.timeout(10000)
    const container = await boxScore()
    const [alex] = pinned(container, 'Alex')
    expect(alex, 'pinned Alex').not.equals(undefined)
    expect(getComputedStyle(alex).backgroundColor).equals(
      rgb(tsBallpark.backgroundColor)
    )
  })
})
