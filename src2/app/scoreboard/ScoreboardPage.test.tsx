import { expect } from 'chai'
import { afterEach, describe, it } from 'mocha'
import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'

import { SAMPLE_SCOREBOARD } from '../../common/scoreboard'
import { fakeClock, fakeSockets } from '../../test/fakeScoreboardSocket'
import { ThemeProvider } from '../theme/ThemeContext'
import { ScoreboardNotFound } from './ScoreboardNotFound'
import { ScoreboardPage } from './ScoreboardPage'
import { RECONNECT_MS } from './scoreboardSocket'

let root: Root | undefined
async function render(element: React.ReactElement): Promise<void> {
  const node = document.createElement('div')
  document.body.appendChild(node)
  root = createRoot(node)
  await act(async () => {
    root?.render(element)
  })
}
afterEach(async function () {
  await act(async () => {
    root?.unmount()
  })
  root = undefined
})

const board = (): HTMLElement | null =>
  document.querySelector('[data-scoreboard="board"]')
const signUp = (): HTMLAnchorElement | null =>
  Array.from(document.querySelectorAll('a')).find(
    link => link.textContent === 'Sign up for GameStation'
  ) ?? null

function live(quiet = false): {
  sockets: ReturnType<typeof fakeSockets>
  clock: ReturnType<typeof fakeClock>
  element: React.ReactElement
} {
  const sockets = fakeSockets()
  const clock = fakeClock()
  return {
    sockets,
    clock,
    element: (
      <ScoreboardPage
        page={{ kind: 'live', gameId: 'g1', quiet }}
        apiBaseUrl="/api/v1"
        origin={{ protocol: 'https:', host: 'gamestation.co' }}
        WebSocketImpl={sockets.Impl}
        schedule={clock.schedule}
      />
    )
  }
}

describe('ScoreboardNotFound', function () {
  it('shows the logo, the message and a sign-up link', async function () {
    await render(
      <ThemeProvider>
        <ScoreboardNotFound />
      </ThemeProvider>
    )
    expect(document.querySelector('[aria-label="GameStation"]')).not.equals(
      null
    )
    const text = document.body.textContent ?? ''
    expect(text).includes("This scoreboard isn't live")
    expect(text).includes(
      'Scoreboards open when a game is scheduled and close after it ends.'
    )
    expect(signUp()?.getAttribute('href')).equals('/sign-in')
  })
})

describe('ScoreboardPage', function () {
  it('draws the sample with no socket', async function () {
    await render(
      <ScoreboardPage page={{ kind: 'sample' }} apiBaseUrl="/api/v1" />
    )
    expect(board()?.dataset.drawn).equals('true')
    expect(
      document.querySelector('[data-scoreboard="awayTeam"]')?.textContent
    ).equals('VISITORS')
  })

  it('connects at once and paints nothing until the first state, then the board', async function () {
    const { sockets, element } = live()
    await render(element)
    expect(sockets.sockets).length(1)
    expect(sockets.latest().url).equals(
      'wss://gamestation.co/api/v1/scoreboard/g1/socket'
    )
    expect(board()?.dataset.drawn).equals('false')
    expect(board()?.children).length(0)
    await act(async () => {
      sockets.latest().open()
      sockets.latest().receive({ ...SAMPLE_SCOREBOARD, balls: 3 })
    })
    expect(board()?.dataset.drawn).equals('true')
    expect(
      document.querySelector('[data-scoreboard="count"]')?.textContent
    ).equals('3-1')
  })

  it('retries a 1006 before any state after 3 s, then shows the board', async function () {
    const { sockets, clock, element } = live()
    await render(element)
    await act(async () => {
      sockets.latest().drop(1006)
    })
    expect(board()?.dataset.drawn).equals('false')
    await act(async () => {
      clock.advance(RECONNECT_MS)
    })
    expect(sockets.sockets).length(2)
    await act(async () => {
      sockets.latest().open()
      sockets.latest().receive(SAMPLE_SCOREBOARD)
    })
    expect(board()?.dataset.drawn).equals('true')
  })

  it('shows the branded 404 on 4404 and tries no more', async function () {
    const { sockets, clock, element } = live()
    await render(element)
    await act(async () => {
      sockets.latest().open()
      sockets.latest().receive(SAMPLE_SCOREBOARD)
    })
    await act(async () => {
      sockets.latest().drop(4404)
    })
    expect(board()).equals(null)
    expect(signUp()?.getAttribute('href')).equals('/sign-in')
    clock.advance(60_000)
    expect(sockets.sockets).length(1)
  })

  it('keeps only the empty box on 4404 when quiet', async function () {
    const { sockets, clock, element } = live(true)
    await render(element)
    await act(async () => {
      sockets.latest().drop(4404)
    })
    expect(board()?.dataset.drawn).equals('false')
    expect(board()?.children).length(0)
    expect(signUp()).equals(null)
    clock.advance(60_000)
    expect(sockets.sockets).length(1)
  })

  it('closes its socket when it goes away', async function () {
    const { sockets, element } = live()
    await render(element)
    sockets.latest().open()
    await act(async () => {
      root?.unmount()
    })
    root = undefined
    expect(sockets.latest().closedWith).equals(1000)
  })
})
