import { expect } from 'chai'
import { afterEach, describe, it } from 'mocha'
import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'

import { type LineScoreStep, TeamStationClient } from '../../../common/api'
import type { BoardLine } from '../../../common/scoring/boardLineTypes'
import { fakeClock, fakeSockets } from '../../../test/fakeScoreboardSocket'
import { overlayServer, settle } from '../../../test/overlayFixtures'
import { LineScoreBox } from './LineScoreBox'
import {
  LINE_BORDER,
  LINE_BOX_HEIGHT,
  LINE_INNING_WIDTH,
  LINE_NAME_WIDTH,
  LINE_SIDE,
  LINE_TOTAL_WIDTH
} from './lineScoreLayout'
import { BOARD_POLL_MS, NOTICE_DEBOUNCE_MS } from './useBoardTimeline'
import { useLineScore } from './useLineScore'

let root: Root | undefined

afterEach(async function () {
  await act(async () => {
    root?.unmount()
  })
  root = undefined
  document.body.replaceChildren()
})

async function render(element: React.ReactElement): Promise<void> {
  if (root == null) {
    const host = document.createElement('div')
    document.body.appendChild(host)
    root = createRoot(host)
  }
  await act(async () => {
    root!.render(element)
  })
}

const box = (): HTMLElement | null =>
  document.querySelector('[data-testid="line-score-box"]')
/** Each row's cells' text, header first. */
const rows = (): string[][] =>
  [...box()!.firstElementChild!.children].map(row =>
    [...row.querySelectorAll('div[dir], div')]
      .filter(cell => cell.childElementCount === 0)
      .map(cell => cell.textContent ?? '')
  )

const TEAMS = { away: 'Visitors', home: 'Hosts' }
const LINE: BoardLine = {
  away: { innings: [1, 0, 2], r: 3, h: 5, e: 0 },
  home: { innings: [0, 1, null], r: 1, h: null, e: 1 }
}
/** The rect a box room for `n` innings is drawn in at `scale`. */
const rectFor = (
  n: number,
  scale = 0.5
): { x: number; y: number; w: number; h: number } => ({
  x: 10,
  y: 20,
  w:
    (2 * LINE_BORDER +
      2 * LINE_SIDE +
      LINE_NAME_WIDTH +
      3 * LINE_TOTAL_WIDTH +
      n * LINE_INNING_WIDTH) *
    scale,
  h: LINE_BOX_HEIGHT * scale
})

describe('the line score box (U5)', function () {
  it('draws the names, the innings so far and R, H, E', async function () {
    await render(
      <LineScoreBox rect={rectFor(9)} line={LINE} teams={TEAMS} at={1234} />
    )
    const node = box()!
    expect(node.getAttribute('data-innings')).equals('[1,2,3]')
    expect(node.getAttribute('data-at')).equals('1234')
    expect(node.style.left).equals('10px')
    expect(node.style.top).equals('20px')
    expect(rows()).deep.equals([
      ['', '1', '2', '3', 'R', 'H', 'E'],
      ['Visitors', '1', '0', '2', '3', '5', '0'],
      // A half not started is blank; hits nobody could count, a dash.
      ['Hosts', '0', '1', '', '1', '–', '1']
    ])
    // Scaled about its top-left corner to the rect's height.
    const panel = node.firstElementChild as HTMLElement
    expect(panel.style.transform).includes('scale(0.5)')
  })

  it('makes the runs bold', async function () {
    await render(
      <LineScoreBox rect={rectFor(9)} line={LINE} teams={TEAMS} at={1} />
    )
    const runs = [...box()!.querySelectorAll('div')].filter(
      cell => cell.childElementCount === 0 && cell.textContent === '3'
    )
    const weights = runs.map(cell => getComputedStyle(cell).fontWeight)
    expect(weights).includes('bold')
  })

  it('keeps the names and the totals, and the latest innings, when twelve do not fit', async function () {
    const twelve: BoardLine = {
      away: {
        innings: [0, 0, 0, 0, 0, 0, 0, 0, 0, 1, 0, 2],
        r: 3,
        h: 4,
        e: 0
      },
      home: {
        innings: [0, 0, 0, 0, 0, 0, 0, 0, 0, 1, 0, null],
        r: 1,
        h: 2,
        e: 0
      }
    }
    await render(
      <LineScoreBox rect={rectFor(4)} line={twelve} teams={TEAMS} at={1} />
    )
    expect(box()!.getAttribute('data-innings')).equals('[9,10,11,12]')
    const [head, away, home] = rows()
    expect(head).deep.equals(['', '9', '10', '11', '12', 'R', 'H', 'E'])
    expect(away).deep.equals(['Visitors', '0', '1', '0', '2', '3', '4', '0'])
    expect(home[0]).equals('Hosts')
    expect(home.slice(-3)).deep.equals(['1', '2', '0'])
  })

  it('shows the latest six innings of twelve in a box shaped for six, with the names and the totals', async function () {
    const twelve: BoardLine = {
      away: {
        innings: [0, 0, 0, 0, 0, 0, 1, 0, 0, 1, 0, 2],
        r: 4,
        h: 6,
        e: 0
      },
      home: {
        innings: [0, 0, 0, 0, 0, 0, 0, 0, 0, 1, 0, null],
        r: 1,
        h: 2,
        e: 0
      }
    }
    await render(
      <LineScoreBox rect={rectFor(9)} line={twelve} teams={TEAMS} at={1} />
    )
    expect(box()!.getAttribute('data-innings')).equals('[7,8,9,10,11,12]')
    const [head, away] = rows()
    expect(head).deep.equals([
      '',
      '7',
      '8',
      '9',
      '10',
      '11',
      '12',
      'R',
      'H',
      'E'
    ])
    expect(away).deep.equals([
      'Visitors',
      '1',
      '0',
      '0',
      '1',
      '0',
      '2',
      '4',
      '6',
      '0'
    ])
  })

  it('draws the zeroed line before the first step, and nothing with no room', async function () {
    await render(
      <LineScoreBox rect={rectFor(9)} line={null} teams={TEAMS} at={null} />
    )
    expect(rows()).deep.equals([
      ['', '1', 'R', 'H', 'E'],
      ['Visitors', '', '0', '0', '0'],
      ['Hosts', '', '0', '0', '0']
    ])
    expect(box()!.getAttribute('data-at')).equals('')
    await render(
      <LineScoreBox
        rect={{ x: 0, y: 0, w: 0, h: 0 }}
        line={LINE}
        teams={TEAMS}
        at={1}
      />
    )
    expect(box()).equals(null)
  })
})

describe("a game's line score, fetched (U5)", function () {
  function Probe(props: {
    client: TeamStationClient
    gameId: string | null
    seen: Array<ReturnType<typeof useLineScore>>
  }): null {
    props.seen.push(
      useLineScore({ client: props.client, gameId: props.gameId, live: false })
    )
    return null
  }

  it('answers its steps and teams, none for a game with no events, and asks again on refetch', async function () {
    const server = overlayServer()
    const step: LineScoreStep = { at: 5, line: LINE }
    server.lines.set('g1', [step])
    const client = new TeamStationClient({
      baseUrl: '/api/v1',
      fetch: server.fetch
    })
    const seen: Array<ReturnType<typeof useLineScore>> = []
    await render(<Probe client={client} gameId="g1" seen={seen} />)
    await settle()
    expect(seen.at(-1)?.steps).deep.equals([step])
    expect(seen.at(-1)?.teams).deep.equals(TEAMS)
    const asks = (): number =>
      server.asked.filter(one => one.path === '/games/g1/line-score').length
    expect(asks()).equals(1)
    await act(async () => {
      seen.at(-1)?.refetch()
    })
    await settle()
    expect(asks()).equals(2)

    await render(<Probe client={client} gameId="g2" seen={seen} />)
    await settle()
    expect(seen.at(-1)?.steps).deep.equals([])
    await render(<Probe client={client} gameId={null} seen={seen} />)
    expect(seen.at(-1)?.steps).equals(null)
  })

  it('asks again on each change notice while live, and polls while the socket is down', async function () {
    const server = overlayServer()
    server.lines.set('g1', [{ at: 5, line: LINE }])
    const client = new TeamStationClient({
      baseUrl: '/api/v1',
      fetch: server.fetch
    })
    const sockets = fakeSockets()
    const clock = fakeClock()
    const seen: Array<ReturnType<typeof useLineScore>> = []
    function Live(): null {
      seen.push(
        useLineScore({
          client,
          gameId: 'g1',
          live: true,
          WebSocketImpl: sockets.Impl,
          schedule: clock.schedule,
          origin: { protocol: 'http:', host: 'localhost' }
        })
      )
      return null
    }
    const asks = (): number =>
      server.asked.filter(one => one.path === '/games/g1/line-score').length
    const advance = async (ms: number): Promise<void> => {
      await act(async () => {
        clock.advance(ms)
      })
      await settle(5)
    }
    await render(<Live />)
    await settle()
    expect(sockets.latest().url).equals(
      'ws://localhost/api/v1/scoreboard/g1/socket?timeline=1'
    )
    expect(asks()).equals(1)
    // Opening asks again, so nothing posted before the socket is missed.
    await act(async () => {
      sockets.latest().open()
    })
    await settle()
    expect(asks()).equals(2)
    // A burst of notices is one ask; anything else is not a notice.
    await act(async () => {
      sockets.latest().receive({ type: 'changed' })
      sockets.latest().receive({ type: 'changed' })
      sockets.latest().receive('not json')
      sockets.latest().receive({ type: 'other' })
    })
    await advance(NOTICE_DEBOUNCE_MS)
    expect(asks()).equals(3)
    // While the socket is open the poll asks nothing; once it is down, it
    // asks every poll.
    await advance(BOARD_POLL_MS)
    expect(asks()).equals(3)
    await act(async () => {
      sockets.latest().drop(4403)
    })
    await advance(BOARD_POLL_MS)
    expect(asks()).equals(4)
    // A failed ask is asked again by the next poll.
    server.fail.add('/games/g1/line-score')
    await advance(BOARD_POLL_MS)
    expect(seen.at(-1)?.steps).length(1)
    // Unmounted, it asks no more.
    await act(async () => {
      root?.unmount()
    })
    root = undefined
    server.fail.clear()
    const before = asks()
    await advance(BOARD_POLL_MS)
    expect(asks()).equals(before)
  })
})
