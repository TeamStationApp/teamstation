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
import { userIdOfGumbo } from '../../common/userId'
import { gameFixture } from '../scoring/isUnscoredGame.test'
import { ThemeProvider } from '../theme/ThemeContext'
import { tsBallpark } from '../theme/tsBallpark'
import { battingOrder, BoxScore } from './BoxScore'
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
  userId: userIdOfGumbo(2),
  gumboId: 2,
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
        userId: userIdOfGumbo(1),
        gumboId: 1,
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
  it('keeps the membership explanation when no custom access action is provided', async () => {
    host = document.createElement('div')
    document.body.append(host)
    root = createRoot(host)
    await act(async () => {
      root!.render(
        <BoxScore
          game={{ ...gameFixture, nonMemberView: true }}
          box={undefined}
          theme={tsBallpark}
          sideBySide={false}
        />
      )
    })
    expect(host.querySelector('[role="alert"]')?.textContent).equals(
      'You need to be a member of one of these teams to see individual player stats.'
    )
    expect(host.textContent).not.includes('Batting —')
  })
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
          userId: userIdOfGumbo(100 + side * 2 + i),
          gumboId: 100 + side * 2 + i,
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

/** A batting line: `pa` 0 is a player who has not come to the plate. */
function batter(
  userId: number,
  shortName: string,
  teamId: string,
  pa: number
): BattingRow {
  return asBattingRow({
    userId: userIdOfGumbo(userId),
    gumboId: userId,
    shortName,
    teamId,
    pa,
    ab: pa,
    h: 0,
    singles: 0,
    doubles: 0,
    triples: 0,
    hr: 0,
    bb: 0,
    k: 0,
    hbp: 0,
    rbi: 0,
    rates: {}
  })
}

/** The box score module on its own, as a coach's screen draws it. */
async function moduleBoxScore(
  props: Partial<React.ComponentProps<typeof BoxScore>>
): Promise<string> {
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
  await act(async () => {
    root?.render(
      <ThemeProvider>
        <BoxScore
          game={{
            ...gameFixture,
            linescore: {
              away: {
                runs: [1, 0],
                r: 1,
                h: 2,
                e: 0,
                bb: 0,
                k: 2,
                hr: 0,
                hbp: 0
              },
              home: { runs: [0], r: 0, h: 1, e: 0, bb: 0, k: 1, hr: 0, hbp: 0 }
            }
          }}
          box={undefined}
          theme={tsBallpark}
          sideBySide={false}
          {...props}
        />
      </ThemeProvider>
    )
  })
  return host.textContent ?? ''
}

describe('the box score module (U24)', function () {
  const rows = [
    batter(1, 'Alex', 'away', 2),
    batter(2, 'Blake', 'away', 1),
    batter(3, 'Casey', 'home', 1)
  ]
  const pitching = [
    BLAIR,
    asPitchingRow({
      ...BLAIR,
      userId: userIdOfGumbo(4),
      gumboId: 4,
      shortName: 'Drew',
      teamId: 'home'
    })
  ]

  it('puts a coach’s side first: his batters, his pitchers, then the opponent’s', async function () {
    const text = await moduleBoxScore({
      box: { batting: rows, pitching, stats: undefined },
      first: 'away',
      sideBySide: true
    })
    const at = (words: string): number => {
      const index = text.indexOf(words)
      expect(index, words).greaterThan(-1)
      return index
    }
    // The line score, whatever the width.
    expect(at('Owls')).lessThan(at('Batting — Owls'))
    expect(at('Batting — Owls')).lessThan(at('Pitching — Owls'))
    expect(at('Pitching — Owls')).lessThan(at('Batting — Hawks'))
    expect(at('Batting — Hawks')).lessThan(at('Pitching — Hawks'))
    // In the order they came to the plate.
    expect(at('Alex')).lessThan(at('Blake'))
  })

  it('keeps the game screen’s order, home first in one column, without a side', async function () {
    const text = await moduleBoxScore({
      box: { batting: rows, pitching, stats: undefined }
    })
    expect(text.indexOf('Batting — Hawks')).lessThan(
      text.indexOf('Batting — Owls')
    )
  })

  it('shows a spinner while the lines load', async function () {
    await moduleBoxScore({ box: undefined, first: 'home' })
    expect(host!.querySelector('[role="progressbar"]')).not.equals(null)
  })

  it('follows those who batted with the rest of the order as it stands, on empty lines', function () {
    const runner = { ...batter(15, 'Runner', 'away', 0), r: 1 }
    const lines = [
      batter(10, 'Late', 'away', 0),
      batter(11, 'First', 'away', 3),
      batter(13, 'Gone', 'away', 0),
      batter(14, 'Second', 'away', 1),
      runner
    ]
    const order = [
      { userId: userIdOfGumbo(12), gumboId: 12, shortName: 'Early' },
      { userId: userIdOfGumbo(11), gumboId: 11, shortName: 'First' },
      { userId: null, gumboId: null, shortName: 'Made Up' },
      { userId: userIdOfGumbo(15), gumboId: 15, shortName: 'Runner' },
      { userId: userIdOfGumbo(10), gumboId: 10, shortName: 'Late' }
    ]
    const ordered = battingOrder(lines, order, 'away')
    expect(ordered.map(line => line.shortName)).deep.equals([
      'First',
      'Second',
      'Early',
      'Made Up',
      'Runner',
      'Late',
      'Gone'
    ])
    // Those yet to bat have empty lines; a runner who scored keeps his.
    expect(ordered[2]).deep.include({
      userId: userIdOfGumbo(12),
      teamId: 'away',
      pa: 0,
      ab: 0,
      h: 0,
      seasonAvg: null
    })
    expect(ordered[3].userId).equals(null)
    expect(ordered[4]).equals(runner)
    // Without an order, the server's.
    expect(battingOrder(lines).map(line => line.shortName)).deep.equals([
      'Late',
      'First',
      'Gone',
      'Second',
      'Runner'
    ])
  })

  it('lists a coach’s whole order and the opponent’s, before anyone has batted', async function () {
    const opened: string[] = []
    const text = await moduleBoxScore({
      box: {
        batting: [batter(3, 'Casey', 'home', 1)],
        pitching: [],
        stats: undefined
      },
      first: 'home',
      lineups: {
        home: [
          { userId: userIdOfGumbo(5), shortName: 'Dana' },
          { userId: userIdOfGumbo(3), shortName: 'Casey' },
          { userId: null, shortName: 'Emery' }
        ],
        away: [
          { userId: userIdOfGumbo(1), shortName: 'Alex' },
          { userId: userIdOfGumbo(2), shortName: 'Blake' }
        ]
      },
      onOpenPlayer: userId => {
        opened.push(userId)
      }
    })
    const at = (words: string): number => {
      const index = text.indexOf(words)
      expect(index, words).greaterThan(-1)
      return index
    }
    expect(at('Batting — Hawks')).lessThan(at('Casey'))
    expect(at('Casey')).lessThan(at('Dana'))
    expect(at('Dana')).lessThan(at('Emery'))
    expect(at('Emery')).lessThan(at('Batting — Owls'))
    expect(at('Batting — Owls')).lessThan(at('Alex'))
    expect(at('Alex')).lessThan(at('Blake'))
    // Pitchers only once they have pitched.
    expect(text).not.includes('Pitching')
    // A made-up player has no page to open; the others do.
    expect(host!.querySelector('[aria-label="Emery"]')).equals(null)
    await act(async () => {
      host!.querySelector<HTMLElement>('[aria-label="Dana"]')!.click()
    })
    expect(opened).deep.equals([userIdOfGumbo(5)])
  })

  it('draws a coach an empty line score before the game, over a word that it has not started', async function () {
    const text = await moduleBoxScore({
      game: { ...gameFixture, linescore: null },
      box: { batting: [], pitching: [], stats: undefined },
      first: 'away',
      lineups: {
        away: [{ userId: userIdOfGumbo(1), shortName: 'Alex' }],
        home: []
      }
    })
    expect(text).includes('Owls')
    expect(text).includes('Hawks')
    expect(text.indexOf('Hawks')).lessThan(
      text.indexOf('The game has not started')
    )
    expect(text.indexOf('The game has not started')).lessThan(
      text.indexOf('Batting — Owls')
    )
    expect(text).includes('–')
  })

  it('leaves the game screen’s box score blank before the game, as it was', async function () {
    const text = await moduleBoxScore({
      game: { ...gameFixture, linescore: null },
      box: { batting: [], pitching: [], stats: undefined }
    })
    expect(text).equals('')
  })
})
