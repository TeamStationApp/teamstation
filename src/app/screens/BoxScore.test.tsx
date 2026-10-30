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
import { PaneFrameProvider } from '../components/useBreakpoint'
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
 * The frozen cells showing `text`: leaves in a table's names column, which
 * sits beside the horizontal scroll rather than in it.
 */
function frozen(container: HTMLElement, text: string): HTMLElement[] {
  return Array.from(
    container.querySelectorAll<HTMLElement>('[data-testid="frozen-names"] *')
  ).filter(node => node.children.length === 0 && node.textContent === text)
}

/** The table a frozen cell belongs to: its names and its figures. */
function tableOf(cell: HTMLElement): {
  names: HTMLElement[]
  figures: HTMLElement[]
  scroller: HTMLElement
} {
  const column = cell.closest<HTMLElement>('[data-testid="frozen-names"]')!
  const scroller = column.parentElement!.querySelector<HTMLElement>(
    ':scope > [data-testid="frozen-figures"]'
  )!
  return {
    names: Array.from(column.children) as HTMLElement[],
    figures: Array.from(
      scroller.firstElementChild!.firstElementChild!.children
    ) as HTMLElement[],
    scroller
  }
}

/**
 * A row read across both halves: its name, then its figures at the same
 * index beside the scroll. `row` 0 is the head.
 */
function rowAcross(
  container: HTMLElement,
  name: string,
  row?: number
): string[] {
  const [cell] = frozen(container, name)
  expect(cell, `frozen ${name}`).not.equals(undefined)
  const { names, figures } = tableOf(cell)
  const index = row ?? names.findIndex(each => each.contains(cell))
  return [
    names[index].textContent ?? '',
    ...Array.from(figures[index].children).map(each => each.textContent ?? '')
  ]
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
        shortName: 'Alex L',
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
    expect(rowAcross(container, 'Owls')).deep.equals(['Owls', '1', '0', '1'])
    expect(rowAcross(container, 'Owls', 0)).deep.equals(['', '1', '2', 'R'])
    expect(text.indexOf('Hawks')).lessThan(text.indexOf(message))
    expect(text).not.includes('Batting —')
    expect(text).not.includes('Pitching —')
    expect(asked).deep.equals([])
  })
})

describe('the box score', function () {
  it('draws the line score’s frozen names, and the cell above them, on the card’s white', async function () {
    this.timeout(10000)
    const container = await boxScore()
    const card = rgb(tsBallpark.cardBackgroundColor)
    for (const name of ['Owls', 'Hawks']) {
      const [cell] = frozen(container, name)
      expect(cell, `frozen ${name}`).not.equals(undefined)
      const { names } = tableOf(cell)
      const row = names.find(each => each.contains(cell))!
      expect(getComputedStyle(row).backgroundColor, name).equals(card)
      // The line score's head row comes first; its frozen cell is empty.
      expect(names[0].textContent).equals('')
      expect(getComputedStyle(names[0]).backgroundColor).equals(card)
    }
  })

  it('keeps the page colour behind a batting table’s frozen names', async function () {
    this.timeout(10000)
    const container = await boxScore()
    const [alex] = frozen(container, 'Alex L')
    expect(alex, 'frozen Alex L').not.equals(undefined)
    const { names } = tableOf(alex)
    const page = rgb(tsBallpark.backgroundColor)
    expect(
      getComputedStyle(names.find(each => each.contains(alex))!).backgroundColor
    ).equals(page)
    expect(getComputedStyle(names[0]).backgroundColor).equals(page)
  })

  it('keeps every table’s names outside its sideways scroll, and its figures in it', async function () {
    this.timeout(10000)
    const container = await boxScore([BLAIR])
    for (const name of ['Owls', 'Alex L', 'Blair']) {
      const [cell] = frozen(container, name)
      expect(cell, name).not.equals(undefined)
      const { scroller } = tableOf(cell)
      expect(scroller.contains(cell), name).equals(false)
      expect(getComputedStyle(scroller).overflowX, name).not.equals('visible')
      expect(cell.closest('[data-testid="frozen-figures"]'), name).equals(null)
    }
    expect(rowAcross(container, 'Alex L')).deep.equals([
      'Alex L',
      '2',
      '1',
      '0',
      '1',
      '0',
      '1',
      '0',
      '0',
      '–'
    ])
    // Nothing in the tables is pinned the old way any more.
    expect(
      Array.from(
        container.querySelectorAll<HTMLElement>(
          '[data-testid="frozen-names"] *, [data-testid="frozen-figures"] *'
        )
      ).some(node => getComputedStyle(node).position === 'sticky')
    ).equals(false)
  })

  it('omits a table with no lines and keeps the batting that has them', async function () {
    this.timeout(10000)
    const container = await boxScore()
    const text = container.textContent ?? ''
    expect(text).includes('Batting — Owls')
    expect(text).includes('Alex L')
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
  it('shows a withdrawn line under its placeholder name, with nobody behind it', async function () {
    this.timeout(10000)
    const withdrawn = asPitchingRow({
      ...BLAIR,
      userId: null,
      gumboId: null,
      shortName: 'RFlcns A'
    })
    expect(withdrawn.userId).equals(null)
    const container = await boxScore([BLAIR, withdrawn])
    const text = container.textContent ?? ''
    expect(text).includes('RFlcns A')
    expect(text).includes('Blair')
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

describe('the line score’s team names', function () {
  const side = (): LineScoreSide => ({
    runs: [1],
    r: 1,
    h: 1,
    e: 0,
    bb: 0,
    k: 0,
    hr: 0,
    hbp: 0
  })

  it('sizes the column to its names, from a floor, up to a share of the pane', async function () {
    host = document.createElement('div')
    document.body.append(host)
    root = createRoot(host)
    await act(async () => {
      root!.render(
        <PaneFrameProvider frame={{ x: 0, y: 0, width: 400, height: 800 }}>
          <BoxScore
            game={{
              ...gameFixture,
              linescore: { away: side(), home: side() }
            }}
            box={{ stats: undefined, batting: [], pitching: [] }}
            theme={tsBallpark}
            sideBySide={false}
          />
        </PaneFrameProvider>
      )
    })
    const names = document.querySelector<HTMLElement>(
      '[data-testid="frozen-names"]'
    )!
    const style = getComputedStyle(names)
    expect(style.flexGrow).equals('0')
    expect(style.minWidth).equals('116px')
    expect(style.maxWidth).equals('180px')
  })
})

describe('the box score module (U24)', function () {
  const rows = [
    batter(1, 'Alex L', 'away', 2),
    batter(2, 'Blake S', 'away', 1),
    batter(3, 'Casey M', 'home', 1)
  ]
  const pitching = [
    BLAIR,
    asPitchingRow({
      ...BLAIR,
      userId: userIdOfGumbo(4),
      gumboId: 4,
      shortName: 'Drew Smyly',
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
    expect(at('Alex L')).lessThan(at('Blake S'))
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
    expect(ordered[3]).deep.include({ userId: null, openable: false })
    expect(ordered[2].openable).equals(true)
    expect(ordered[4]).equals(runner)
    // A withdrawn line names the batter it stands in for, who has no account
    // any more: his name does not come back beside the placeholder.
    const placeholder = {
      ...batter(16, 'RFlcns A', 'away', 2),
      userId: null,
      openable: false,
      standsFor: 21
    }
    const withGone = [
      ...order.slice(0, 2),
      { userId: null, gumboId: 21, shortName: 'Mookie Betts' },
      ...order.slice(2)
    ]
    expect(
      battingOrder([...lines, placeholder], withGone, 'away').map(
        line => line.shortName
      )
    ).deep.equals([
      'First',
      'Second',
      'RFlcns A',
      'Early',
      'Made Up',
      'Runner',
      'Late',
      'Gone'
    ])
    // Another batter with no account ahead of him in the order, one taken off
    // the roster after batting or made up for the game, keeps his place: the
    // line is the withdrawn batter's, not the first such batter's.
    const offFirst = [
      order[1],
      { userId: null, gumboId: 30, shortName: 'Off Roster' },
      { userId: null, gumboId: 21, shortName: 'Mookie Betts' },
      { userId: null, gumboId: null, shortName: 'Made Up' }
    ]
    expect(
      battingOrder([...lines, placeholder], offFirst, 'away').map(
        line => line.shortName
      )
    ).deep.equals([
      'First',
      'Second',
      'RFlcns A',
      'Off Roster',
      'Made Up',
      'Late',
      'Gone',
      'Runner'
    ])
    // Two withdrawn lines stand in for their own two batters.
    const second = {
      ...placeholder,
      shortName: 'RFlcns B',
      pa: 1,
      standsFor: 22
    }
    expect(
      battingOrder(
        [...lines, placeholder, second],
        [
          ...offFirst,
          { userId: null, gumboId: 22, shortName: 'Shohei Ohtani' }
        ],
        'away'
      ).map(line => line.shortName)
    ).deep.equals([
      'First',
      'Second',
      'RFlcns A',
      'RFlcns B',
      'Off Roster',
      'Made Up',
      'Late',
      'Gone',
      'Runner'
    ])
    // A pool player whose add was rejected while the game was under way is
    // still in it, with his account: the line takes his place all the same.
    const pooled = [
      order[1],
      { userId: userIdOfGumbo(21), gumboId: 21, shortName: 'Mookie Betts' },
      order[4]
    ]
    const pooledOrder = battingOrder([...lines, placeholder], pooled, 'away')
    expect(pooledOrder.map(line => line.shortName)).deep.equals([
      'First',
      'Second',
      'RFlcns A',
      'Late',
      'Gone',
      'Runner'
    ])
    expect(pooledOrder.some(line => line.userId === userIdOfGumbo(21))).equals(
      false
    )
    // One yet to come up, a pitcher batting ninth, waits in his own slot
    // under the placeholder, not at the bottom.
    const ninth = {
      ...batter(18, 'RFlcns C', 'away', 0),
      userId: null,
      openable: false,
      standsFor: 23
    }
    expect(
      battingOrder(
        [...lines, ninth],
        [
          order[1],
          { userId: null, gumboId: 23, shortName: 'Clayton Kershaw' },
          order[4]
        ],
        'away'
      ).map(line => line.shortName)
    ).deep.equals(['First', 'Second', 'RFlcns C', 'Late', 'Gone', 'Runner'])
    // A withdrawn pinch runner who scored and never batted keeps his line.
    const runnerGone = {
      ...batter(17, 'RFlcns B', 'away', 0),
      r: 1,
      userId: null,
      openable: false,
      standsFor: null
    }
    expect(
      battingOrder([...lines, runnerGone], order, 'away').map(
        line => line.shortName
      )
    ).includes('RFlcns B')
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
        batting: [batter(3, 'Casey M', 'home', 1)],
        pitching: [],
        stats: undefined
      },
      first: 'home',
      lineups: {
        home: [
          { userId: userIdOfGumbo(5), shortName: 'Dana E' },
          { userId: userIdOfGumbo(3), shortName: 'Casey M' },
          { userId: null, shortName: 'Emil B' }
        ],
        away: [
          { userId: userIdOfGumbo(1), shortName: 'Alex L' },
          { userId: userIdOfGumbo(2), shortName: 'Blake S' }
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
    expect(at('Batting — Hawks')).lessThan(at('Casey M'))
    expect(at('Casey M')).lessThan(at('Dana E'))
    expect(at('Dana E')).lessThan(at('Emil B'))
    expect(at('Emil B')).lessThan(at('Batting — Owls'))
    expect(at('Batting — Owls')).lessThan(at('Alex L'))
    expect(at('Alex L')).lessThan(at('Blake S'))
    // Pitchers only once they have pitched.
    expect(text).not.includes('Pitching')
    // A made-up player has no page to open; the others do.
    expect(host!.querySelector('[role="button"][aria-label="Emil B"]')).equals(
      null
    )
    await act(async () => {
      host!
        .querySelector<HTMLElement>('[role="button"][aria-label="Dana E"]')!
        .click()
    })
    expect(opened).deep.equals([userIdOfGumbo(5)])
  })

  it('opens a pitcher from their line, and a withdrawn or unopenable pitcher from none', async function () {
    const opened: string[] = []
    await moduleBoxScore({
      game: gameFixture,
      box: {
        batting: [],
        pitching: [
          BLAIR,
          asPitchingRow({ ...BLAIR, userId: null, shortName: 'RFlcns A' }),
          // A pool player the viewer could not already see.
          asPitchingRow({
            ...BLAIR,
            userId: userIdOfGumbo(9),
            shortName: 'Freddie F',
            openable: false
          })
        ],
        stats: undefined
      },
      first: 'away',
      onOpenPlayer: userId => {
        opened.push(userId)
      }
    })
    expect(
      host!.querySelector('[role="button"][aria-label="RFlcns A"]')
    ).equals(null)
    expect(
      host!.querySelector('[role="button"][aria-label="Freddie F"]')
    ).equals(null)
    expect(host!.textContent).includes('Freddie F')
    await act(async () => {
      host!
        .querySelector<HTMLElement>('[role="button"][aria-label="Blair"]')!
        .click()
    })
    expect(opened).deep.equals([BLAIR.userId])
  })

  it('draws a coach an empty line score before the game, over a word that it has not started', async function () {
    const text = await moduleBoxScore({
      game: { ...gameFixture, linescore: null },
      box: { batting: [], pitching: [], stats: undefined },
      first: 'away',
      lineups: {
        away: [{ userId: userIdOfGumbo(1), shortName: 'Alex L' }],
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

describe('box score totals', function () {
  /** A batter with a season average that is nothing like the afternoon's. */
  const hitter = (
    id: number,
    ab: number,
    h: number,
    seasonAvg: number
  ): BattingRow =>
    asBattingRow({
      userId: userIdOfGumbo(id),
      gumboId: id,
      shortName: `Hitter ${id}`,
      teamId: 'away',
      pa: ab + 1,
      ab,
      h,
      singles: h,
      doubles: 0,
      triples: 0,
      hr: 0,
      bb: 1,
      k: 1,
      hbp: 0,
      rbi: h,
      r: 1,
      rates: {},
      seasonAvg
    })
  const arm = (id: number, outs: number, ip: string): PitchingRow =>
    asPitchingRow({
      ...BLAIR,
      userId: userIdOfGumbo(id),
      gumboId: id,
      shortName: `Arm ${id}`,
      ip,
      outs,
      bf: outs + 1,
      h: 1,
      r: 1,
      er: 0,
      bb: 1,
      k: 2
    })

  it('ends a side’s batting with Totals: the summed counts, and hits over at-bats', async function () {
    await moduleBoxScore({
      box: {
        batting: [hitter(1, 3, 2, 0.111), hitter(2, 4, 1, 0.222)],
        pitching: [],
        stats: undefined
      }
    })
    const container = host!
    const total = rowAcross(container, 'Totals')
    // AB H R RBI BB K HR HBP AVG
    expect(total).deep.equals([
      'Totals',
      '7',
      '3',
      '2',
      '3',
      '2',
      '2',
      '0',
      '0',
      '.429'
    ])
    // Not the mean of the season averages on the rows.
    expect(total[9]).not.equals('.167')
    const { names } = tableOf(frozen(container, 'Totals')[0])
    expect(names.at(-1)!.textContent).equals('Totals')
    // The totals line opens nobody; a named player's row still does.
    expect(container.querySelector('[aria-label="Totals"]')).equals(null)
  })

  it('shows the empty mark for a side with no at-bats', async function () {
    await moduleBoxScore({
      box: {
        batting: [batter(5, 'Patient', 'away', 0)],
        pitching: [],
        stats: undefined
      }
    })
    expect(rowAcross(host!, 'Totals').at(-1)).equals('–')
  })

  it('ends a side’s pitching with Totals, its innings added as outs', async function () {
    await moduleBoxScore({
      box: {
        batting: [],
        pitching: [arm(7, 4, '1.1'), arm(8, 5, '1.2')],
        stats: undefined
      }
    })
    // IP BF H R ER BB K HR HBP
    expect(rowAcross(host!, 'Totals')).deep.equals([
      'Totals',
      '3.0',
      '11',
      '2',
      '2',
      '0',
      '2',
      '4',
      '0',
      '0'
    ])
  })

  it('totals one pitching line too, and grows no table for a side with none', async function () {
    const text = await moduleBoxScore({
      box: { batting: [], pitching: [BLAIR], stats: undefined }
    })
    expect(rowAcross(host!, 'Totals')[1]).equals('5.0')
    expect(text).includes('Pitching — Owls')
    expect(text).not.includes('Pitching — Hawks')
    expect(text.split('Totals').length - 1).equals(1)
  })

  it('leaves the line score as it was', async function () {
    await moduleBoxScore({
      box: { batting: [], pitching: [BLAIR], stats: undefined }
    })
    expect(rowAcross(host!, 'Owls')).deep.equals([
      'Owls',
      '1',
      '0',
      '1',
      '2',
      '0',
      '0'
    ])
  })

  it('keys made-up batters by their place, so two of them are two lines', async function () {
    const errors: unknown[] = []
    const original = console.error
    console.error = (...args: unknown[]) => {
      errors.push(args.join(' '))
    }
    try {
      await moduleBoxScore({
        box: { batting: [], pitching: [], stats: undefined },
        first: 'away',
        lineups: {
          away: [
            { userId: null, shortName: 'Made Up' },
            { userId: null, shortName: 'Made Up Too' }
          ],
          home: []
        }
      })
    } finally {
      console.error = original
    }
    expect(frozen(host!, 'Made Up')).length(1)
    expect(frozen(host!, 'Made Up Too')).length(1)
    expect(
      errors.filter(error => String(error).includes('same key'))
    ).deep.equals([])
  })
})
