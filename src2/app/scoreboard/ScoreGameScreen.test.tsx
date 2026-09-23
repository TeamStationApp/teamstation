import { expect } from 'chai'
import { afterEach, describe, it } from 'mocha'
import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'

import { type GameDetail, GameStationClient } from '../../common/api'
import { gameFixture } from '../scoring/isUnscoredGame.test'
import { ThemeProvider } from '../theme/ThemeContext'
import { COPIED_MS, ScoreGameScreen, siteOrigin } from './ScoreGameScreen'

let root: Root | undefined
async function render(element: React.ReactElement): Promise<void> {
  const node = document.createElement('div')
  document.body.appendChild(node)
  root = createRoot(node)
  await act(async () => {
    root?.render(<ThemeProvider>{element}</ThemeProvider>)
  })
}
afterEach(async function () {
  await act(async () => {
    root?.unmount()
  })
  root = undefined
})
function labelled(label: string): HTMLElement | null {
  return document.querySelector(`[aria-label="${label}"]`)
}
function text(): string {
  return document.body.textContent ?? ''
}

const RUNNABLE = { open: true, mayOverride: true }
const FULL_HEADER =
  'Score game with full stats (ie. pitches, hits, walks, errors)'
const BOARD_HEADER =
  'Operate simplified scoreboard with only bases, balls, strikes, outs, and inning'
const LINK_HEADER = 'Web Widget Scoreboard Link'

interface Opened {
  full: number
  board: number
}

async function screen(
  patch: Partial<GameDetail>,
  { origin }: { origin?: string } = { origin: 'https://seat.example' }
): Promise<Opened> {
  const client = new GameStationClient({ baseUrl: '/api/v1' })
  client.game = async () => ({ ...gameFixture, canScore: true, ...patch })
  const opened = { full: 0, board: 0 }
  await render(
    <ScoreGameScreen
      client={client}
      gameId="g1"
      origin={origin}
      onFullScoring={() => {
        opened.full++
      }}
      onScoreboard={() => {
        opened.board++
      }}
    />
  )
  return opened
}

describe('the Score Game screen', function () {
  it('shows its three headers and controls, in order, with the exact words', async function () {
    await screen({ scoreboard: RUNNABLE })
    const all = text()
    const order = [
      FULL_HEADER,
      'Full game scoring',
      BOARD_HEADER,
      'Scoreboard',
      LINK_HEADER,
      'https://seat.example/scoreboard/g1'
    ].map(part => all.indexOf(part))
    expect(order).not.includes(-1)
    expect([...order].sort((a, b) => a - b)).deep.equals(order)
    expect(labelled('Copy scoreboard link')).not.equals(null)
    expect(all).not.includes('Copied')
  })

  it('opens the full scorer and the simplified scoreboard when both are on offer', async function () {
    const opened = await screen({ scoreboard: RUNNABLE })
    expect(
      labelled('Full game scoring')?.getAttribute('aria-disabled')
    ).not.equals('true')
    await act(async () => {
      labelled('Full game scoring')?.click()
    })
    await act(async () => {
      labelled('Scoreboard')?.click()
    })
    expect(opened).deep.equals({ full: 1, board: 1 })
    expect(text()).not.includes("isn't available")
  })

  it('disables full scoring, with its reason, when the game cannot be scored', async function () {
    const opened = await screen({
      status: 'final',
      homeScore: 3,
      awayScore: 2,
      scoreboard: RUNNABLE
    })
    expect(labelled('Full game scoring')?.getAttribute('aria-disabled')).equals(
      'true'
    )
    expect(text()).includes("Full scoring isn't available for this game")
    await act(async () => {
      labelled('Full game scoring')?.click()
    })
    expect(opened.full).equals(0)
  })

  it('disables full scoring for somebody who may not score the game, even when it is unscored', async function () {
    const opened = await screen({ canScore: false, scoreboard: RUNNABLE })
    expect(labelled('Full game scoring')?.getAttribute('aria-disabled')).equals(
      'true'
    )
    expect(text()).includes(
      'Only people who run a team in this game can score it'
    )
    expect(text()).not.includes("Full scoring isn't available for this game")
    await act(async () => {
      labelled('Full game scoring')?.click()
    })
    expect(opened.full).equals(0)
  })

  for (const [scoreboard, reason] of [
    [{ open: false, mayOverride: true }, "This game's scoreboard has closed"],
    [
      { open: true, mayOverride: false },
      'Only people who run a team in this game can operate the scoreboard'
    ],
    [null, 'The scoreboard is unavailable right now']
  ] as const) {
    it(`disables the scoreboard with "${reason}"`, async function () {
      const opened = await screen({ scoreboard })
      expect(labelled('Scoreboard')?.getAttribute('aria-disabled')).equals(
        'true'
      )
      expect(text()).includes(reason)
      await act(async () => {
        labelled('Scoreboard')?.click()
      })
      expect(opened.board).equals(0)
      // The link shows whatever the board's state.
      expect(text()).includes('https://seat.example/scoreboard/g1')
    })
  }

  it('shows the link in a fixed-width font, copies exactly it, and says Copied for 2 s', async function () {
    const written: string[] = []
    const clipboard = Object.getOwnPropertyDescriptor(navigator, 'clipboard')
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: {
        writeText: async (value: string) => {
          written.push(value)
        }
      }
    })
    // The 2 s timer, held so the test decides when it fires.
    const realSetTimeout = globalThis.setTimeout
    const held: Array<() => void> = []
    globalThis.setTimeout = ((callback: () => void, ms?: number) => {
      if (ms === COPIED_MS) {
        held.push(callback)
        return 0
      }
      return realSetTimeout(callback, ms)
    }) as typeof setTimeout
    try {
      await screen({ scoreboard: RUNNABLE })
      const link = Array.from(document.querySelectorAll('div')).find(
        node => node.textContent === 'https://seat.example/scoreboard/g1'
      )
      expect(link, 'the link').not.equals(undefined)
      expect(getComputedStyle(link!).fontFamily).includes('monospace')
      expect(getComputedStyle(link!).webkitLineClamp).equals('2')

      await act(async () => {
        labelled('Copy scoreboard link')?.click()
      })
      expect(written).deep.equals(['https://seat.example/scoreboard/g1'])
      expect(text()).includes('Copied')
      expect(COPIED_MS).equals(2000)
      expect(held).length(1)
      await act(async () => {
        held[0]()
      })
      expect(text()).not.includes('Copied')
    } finally {
      globalThis.setTimeout = realSetTimeout
      if (clipboard == null) {
        delete (navigator as { clipboard?: unknown }).clipboard
      } else {
        Object.defineProperty(navigator, 'clipboard', clipboard)
      }
    }
  })

  it('links to the page it is on, and to the primary site where there is no page', async function () {
    await screen({ scoreboard: RUNNABLE }, {})
    expect(text()).includes('http://localhost/scoreboard/g1')
    expect(
      siteOrigin({ window: { location: { origin: 'http://x:1' } } })
    ).equals('http://x:1')
    // A phone has a window and no location.
    expect(siteOrigin({ window: {} })).equals('https://gamestation.co')
    expect(siteOrigin({})).equals('https://gamestation.co')
  })

  it('shows a spinner while it loads, and the usual not-found state for a game it cannot see', async function () {
    const client = new GameStationClient({ baseUrl: '/api/v1' })
    let fail: (error: Error) => void = () => undefined
    client.game = async () =>
      await new Promise<GameDetail>((resolve, reject) => {
        fail = reject
      })
    await render(
      <ScoreGameScreen
        client={client}
        gameId="nope"
        onFullScoring={() => undefined}
        onScoreboard={() => undefined}
      />
    )
    expect(document.querySelector('[role="progressbar"]')).not.equals(null)
    expect(text()).not.includes(LINK_HEADER)
    await act(async () => {
      fail(new Error('404'))
    })
    expect(text()).includes('That game is not here')
    expect(text()).not.includes(LINK_HEADER)
  })

  it('ignores an answer that arrives after it has gone', async function () {
    const client = new GameStationClient({ baseUrl: '/api/v1' })
    let answer: (game: GameDetail) => void = () => undefined
    let fail: (error: Error) => void = () => undefined
    let calls = 0
    client.game = async () =>
      await new Promise<GameDetail>((resolve, reject) => {
        calls++
        if (calls === 1) answer = resolve
        else fail = reject
      })
    const props = {
      client,
      onFullScoring: () => undefined,
      onScoreboard: () => undefined
    }
    await render(<ScoreGameScreen {...props} gameId="first" />)
    await act(async () => {
      root?.render(
        <ThemeProvider>
          <ScoreGameScreen {...props} gameId="second" />
        </ThemeProvider>
      )
    })
    await act(async () => {
      answer({ ...gameFixture, scoreboard: RUNNABLE })
    })
    expect(text()).not.includes(LINK_HEADER)
    await act(async () => {
      root?.unmount()
      root = undefined
    })
    fail(new Error('late'))
    expect(calls).equals(2)
  })
})
