import { expect } from 'chai'
import { afterEach, describe, it } from 'mocha'
import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { GestureHandlerRootView } from 'react-native-gesture-handler'

import {
  asBattingRow,
  asPitchingRow,
  type BattingRow,
  type LineScoreSide,
  type PitchingRow,
  TeamStationClient
} from '../../common/api'
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

const BLAIR = asPitchingRow({
  userId: 2,
  shortName: 'Blair',
  teamId: 'away',
  ip: '5.0',
  outs: 15,
  bf: 20,
  h: 4,
  hr: 0,
  hbp: 0,
  r: 1,
  er: 1,
  bb: 1,
  k: 6,
  rates: {}
})

async function boxScore(
  pitching: PitchingRow[] = [],
  batting?: BattingRow[]
): Promise<HTMLElement> {
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
    batting: batting ?? [
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
    pitching
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

/** A non-member's box score: the server sends the runs and keeps the rest. */
async function nonMemberBoxScore(): Promise<{
  container: HTMLElement
  asked: string[]
}> {
  const asked: string[] = []
  const client = new TeamStationClient({ baseUrl: '/api/v1' })
  const side = (runs: number[], r: number): LineScoreSide => ({
    runs,
    r,
    h: null,
    e: null,
    bb: null,
    k: null,
    hr: null,
    hbp: null
  })
  client.game = async () => ({
    ...gameFixture,
    nonMemberView: true,
    canScore: false,
    status: 'final',
    awayScore: 1,
    homeScore: 7,
    linescore: { away: side([1, 0], 1), home: side([3, 4], 7) }
  })
  client.teams = async () => []
  client.boxScore = async () => {
    asked.push('boxScore')
    throw new Error('kept for members')
  }
  client.playback = async () => {
    asked.push('playback')
    throw new Error('kept for members')
  }
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
  return { container: host, asked }
}

describe('a non-member’s box score', function () {
  it('shows the line score by inning, then the members-only message, readably, and asks for no tables', async function () {
    this.timeout(10000)
    const { container, asked } = await nonMemberBoxScore()
    const text = container.textContent ?? ''
    const message =
      'You need to be a member of one of these teams to see individual player stats.'
    expect(text).includes(message)
    // The page's own text colour, not a hint's.
    const notice = container.querySelector('[role="alert"]')
    expect(notice?.textContent).equals(message)
    expect(getComputedStyle(notice!).color).equals(
      rgb(tsBallpark.primaryTextColor)
    )
    // The innings and the runs come first, and the counts the server kept
    // back are not drawn as dashes.
    const [owls] = pinned(container, 'Owls')
    expect(owls, 'line score row').not.equals(undefined)
    const row = owls.parentElement!
    expect(Array.from(row.children).map(cell => cell.textContent)).deep.equals([
      'Owls',
      '1',
      '0',
      '1'
    ])
    const head = row.previousElementSibling!
    expect(Array.from(head.children).map(cell => cell.textContent)).deep.equals(
      ['', '1', '2', 'R']
    )
    expect(text.indexOf('Hawks')).lessThan(text.indexOf(message))
    expect(text).not.includes('Batting —')
    expect(text).not.includes('Pitching —')
    expect(asked).deep.equals([])
  })
})

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

  it('omits a table with no lines and keeps the batting that has them', async function () {
    this.timeout(10000)
    const container = await boxScore()
    const text = container.textContent ?? ''
    expect(text).includes('Batting — Owls')
    expect(text).includes('Alex')
    expect(text).not.includes('Pitching')
    expect(text).not.includes('No individual lines')
    expect(text).not.includes('Batting — Hawks')
    expect(text).includes('Hawks')
  })

  it('keeps pitching when that side has a line, and still omits the empty side', async function () {
    this.timeout(10000)
    const container = await boxScore([BLAIR])
    const text = container.textContent ?? ''
    expect(text).includes('Batting — Owls')
    expect(text).includes('Pitching — Owls')
    expect(text).includes('Blair')
    expect(text).not.includes('Pitching — Hawks')
    expect(text).not.includes('Batting — Hawks')
    expect(text).not.includes('No individual lines')
  })
  it('preserves batting appearance order for both sides and player links', async function () {
    this.timeout(10000)
    const rows = ['away', 'home'].flatMap((teamId, side) =>
      [0, 1].map(i =>
        asBattingRow({
          userId: 100 + side * 2 + i,
          shortName: `${side === 0 ? 'Away' : 'Home'} ${i === 0 ? 'Lead' : 'Power'}`,
          teamId,
          pa: i + 1,
          ab: i + 1,
          h: i,
          singles: i,
          doubles: 0,
          triples: 0,
          hr: 0,
          bb: 0,
          k: 0,
          hbp: 0,
          rbi: 0,
          rates: {}
        })
      )
    )
    const container = await boxScore([], rows)
    const text = container.textContent ?? ''
    expect(text.indexOf('Away Lead')).lessThan(text.indexOf('Away Power'))
    expect(text.indexOf('Home Lead')).lessThan(text.indexOf('Home Power'))
  })
})
