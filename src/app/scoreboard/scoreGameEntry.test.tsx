import { expect } from 'chai'
import { afterEach, describe, it } from 'mocha'
import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { Platform } from 'react-native'
import { GestureHandlerRootView } from 'react-native-gesture-handler'

import {
  asGameDetail,
  type GameDetail,
  TeamStationClient
} from '../../common/api'
import { NO_OVERRIDES, SAMPLE_SCOREBOARD } from '../../common/scoreboard'
import { fakeSockets } from '../../test/fakeScoreboardSocket'
import { testPasswordParameters } from '../../test/passwordFixtures'
import { App } from '../App'
import { currentRoute, showRoute } from '../navigation/useAddressBar'
import { gameFixture } from '../scoring/isUnscoredGame.test'
import { GameScreen } from '../screens/GameScreen'
import { ThemeProvider } from '../theme/ThemeContext'

let root: Root | undefined
const originalFetch = globalThis.fetch
const originalSocket = globalThis.WebSocket
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
  globalThis.fetch = originalFetch
  globalThis.WebSocket = originalSocket
})
function button(label: string): HTMLElement | null {
  return document.querySelector(`[aria-label="${label}"]`)
}
async function click(label: string): Promise<void> {
  const found = button(label)
  expect(found, label).not.equals(null)
  await act(async () => {
    found?.click()
  })
}

const runnable = { open: true, mayOverride: true }

async function gameScreen(
  patch: Partial<GameDetail>,
  onScoreGame?: () => void
): Promise<void> {
  const client = new TeamStationClient({ baseUrl: '/api/v1' })
  client.game = async () => ({ ...gameFixture, ...patch })
  client.teams = async () => []
  await render(
    <GestureHandlerRootView>
      <GameScreen client={client} gameId="g1" onScoreGame={onScoreGame} />
    </GestureHandlerRootView>
  )
}

/** Every pill on the game page, by its label. */
function pills(): string[] {
  return Array.from(document.querySelectorAll<HTMLElement>('[aria-label]'))
    .map(node => node.getAttribute('aria-label') ?? '')
    .filter(label => ['Videos', 'Score', 'Box score'].includes(label))
}

const finalGame = { status: 'final' as const, homeScore: 3, awayScore: 2 }

/**
 * The game as a server sends it with no word on who may score, read the way
 * the client reads every response.
 */
const { canScore: _canScore, ...unsaid } = gameFixture
const silent = asGameDetail({ ...unsaid, scoreboard: runnable })

describe('the Score Game pill', function () {
  it('opens the separate scoring page through its hero action', async function () {
    let opened = 0
    await gameScreen({ canScore: true, scoreboard: runnable }, () => {
      opened++
    })
    expect(pills()).deep.equals(['Score', 'Box score', 'Videos'])
    expect(button('Score')?.getAttribute('role')).equals('button')
    await click('Score')
    expect(opened).equals(1)
    expect(document.body.textContent).not.includes('Full game scoring')
  })

  for (const [label, patch] of [
    ['full scoring alone', { canScore: true, scoreboard: null }],
    [
      'an open scoreboard alone',
      { canScore: true, ...finalGame, scoreboard: runnable }
    ],
    [
      'a game TeamStation is scoring',
      { canScore: true, scoringOwner: 'teamstation' as const, homeScore: 1 }
    ]
  ] as const) {
    it(`shows, labelled Score Game, for ${label}`, async function () {
      await gameScreen(patch)
      expect(pills()).deep.equals(['Score', 'Box score', 'Videos'])
    })
  }

  for (const [label, patch] of [
    [
      'somebody who may not score it, even unscored and open',
      { canScore: false, scoreboard: runnable }
    ],
    ['a server that does not say', silent],
    [
      'a final game whose scoreboard has closed',
      { canScore: true, ...finalGame, scoreboard: { ...runnable, open: false } }
    ],
    [
      'a final game with no scoreboard to ask',
      { canScore: true, ...finalGame, scoreboard: null }
    ]
  ] as const) {
    it(`is hidden for ${label}`, async function () {
      await gameScreen(patch)
      expect(button('Box score')).not.equals(null)
      expect(button('Score')).equals(null)
    })
  }

  it('stays on the game page, with the hero, when there is no separate screen to open', async function () {
    await gameScreen({ canScore: true, scoreboard: runnable })
    expect(button('Box score')).not.equals(null)
    expect(button('Score')).not.equals(null)
    await click('Score')
    expect(document.body.textContent).includes('Owls')
    expect(document.body.textContent).not.includes('Web Widget Scoreboard Link')
  })

  it('shows on a phone too, after Box score and Videos', async function () {
    const os = Platform.OS
    Object.defineProperty(Platform, 'OS', { value: 'ios', configurable: true })
    try {
      await gameScreen({ canScore: true, scoreboard: runnable })
      expect(pills()).deep.equals(['Score', 'Box score', 'Videos'])
    } finally {
      Object.defineProperty(Platform, 'OS', { value: os, configurable: true })
    }
  })
})

/** The API as the app sees it, signed in or not. */
function fixtureFetch(signedIn: { value: boolean }): void {
  globalThis.fetch = async (input, init) => {
    const path = (
      typeof input === 'string'
        ? input
        : input instanceof URL
          ? input.href
          : input.url
    ).split('?')[0]
    const user = { id: 100, displayName: 'Runner', isAdmin: false }
    if (path.endsWith('/auth/password/parameters'))
      return Response.json(testPasswordParameters)
    if (path.endsWith('/auth/password') && init?.method === 'POST') {
      const body = JSON.parse(typeof init.body === 'string' ? init.body : '{}')
      expect(body).deep.equals({
        email: 'runner@example.com',
        clientHash: 'ab'.repeat(32)
      })
      signedIn.value = true
      return Response.json({ token: 't', expiresAt: '2099-01-01', user })
    }
    if (path.endsWith('/auth/me')) {
      return signedIn.value
        ? Response.json(user)
        : Response.json({ error: 'no' }, { status: 401 })
    }
    const data = path.endsWith('/games/g1')
      ? { ...gameFixture, canScore: true, scoreboard: runnable }
      : path.endsWith('/live-streams')
        ? { streams: [] }
        : []
    return Response.json(data)
  }
}
async function press(text: string): Promise<void> {
  const found = Array.from(
    document.querySelectorAll<HTMLElement>('[role="button"]')
  ).find(one => one.textContent === text)
  expect(found, text).not.equals(undefined)
  await act(async () => {
    found?.click()
  })
}
async function type(label: string, value: string): Promise<void> {
  await act(async () => {
    const input = button(label) as HTMLInputElement
    Object.getOwnPropertyDescriptor(
      window.HTMLInputElement.prototype,
      'value'
    )!.set!.call(input, value)
    input.dispatchEvent(new window.Event('input', { bubbles: true }))
  })
}

describe('the app, the Score Game screen and the dashboard', function () {
  it('opens the Score Game screen from the pill, and the dashboard from its Scoreboard button, each at its own address', async function () {
    const sockets = fakeSockets()
    globalThis.WebSocket = sockets.Impl as unknown as typeof WebSocket
    fixtureFetch({ value: true })
    showRoute({ name: 'game', gameId: 'g1' }, true)
    await render(<App />)
    await click('Score')
    expect(currentRoute()).deep.equals({
      name: 'scoreOptions',
      gameId: 'g1'
    })
    const text = document.body.textContent ?? ''
    expect(text).not.includes('Owls')
    expect(button('Score')).equals(null)
    expect(button('Game sections')).equals(null)
    expect(text).includes('Web Widget Scoreboard Link')
    expect(text).includes('http://localhost/scoreboard/g1')
    await click('Scoreboard')
    expect(currentRoute()).deep.equals({
      name: 'scoreboardOverride',
      gameId: 'g1'
    })
    expect(document.body.textContent).includes('Override Scoreboard')
    expect(sockets.latest().url).equals(
      'ws://localhost/api/v1/scoreboard/g1/dashboard'
    )
    await act(async () => {
      sockets.latest().open()
      sockets.latest().receive({
        type: 'state',
        automated: SAMPLE_SCOREBOARD,
        overrides: NO_OVERRIDES,
        final: SAMPLE_SCOREBOARD,
        gameAt: null,
        watcherAt: null
      })
    })
    expect(button('Reset Game State')).not.equals(null)
    // Back returns to the full scoring-choice page, then to the game.
    await click('Back')
    expect(currentRoute()).deep.equals({
      name: 'scoreOptions',
      gameId: 'g1'
    })
    expect(document.body.textContent).not.includes('Owls')
    expect(document.body.textContent).includes('Full game scoring')
    await click('Back')
    expect(currentRoute()).includes({ name: 'game', gameId: 'g1' })
    expect(button('Game sections')).not.equals(null)
  })

  it('opens a link to the Score Game screen or the dashboard with the game beneath it', async function () {
    const sockets = fakeSockets()
    globalThis.WebSocket = sockets.Impl as unknown as typeof WebSocket
    fixtureFetch({ value: true })
    showRoute({ name: 'scoreOptions', gameId: 'g1' }, true)
    await render(<App />)
    expect(document.body.textContent).not.includes('Owls')
    expect(document.body.textContent).includes('Full game scoring')
    await click('Back')
    expect(currentRoute()).includes({ name: 'game', gameId: 'g1' })
    expect(button('Game sections')).not.equals(null)
    await act(async () => {
      root?.unmount()
    })
    showRoute({ name: 'scoreboardOverride', gameId: 'g1' }, true)
    await render(<App />)
    await click('Back')
    expect(currentRoute()).deep.equals({
      name: 'scoreOptions',
      gameId: 'g1'
    })
    await click('Full game scoring')
    expect(currentRoute()).deep.equals({ name: 'scoreGame', gameId: 'g1' })
  })

  it('sends a lapsed session through sign-in and back to the dashboard', async function () {
    // This navigation test mocks only the Worker boundary; real WASM runs in account e2e.
    const oldWorker = Object.getOwnPropertyDescriptor(globalThis, 'Worker')
    const oldUrl = Object.getOwnPropertyDescriptor(
      globalThis,
      'TS_PASSWORD_WORKER_URL'
    )
    Object.defineProperty(globalThis, 'TS_PASSWORD_WORKER_URL', {
      value: '/test-password-worker',
      configurable: true
    })
    Object.defineProperty(globalThis, 'Worker', {
      configurable: true,
      value: class {
        onmessage?: (event: { data: { hash: string } }) => void
        postMessage(): void {
          queueMicrotask(() =>
            this.onmessage?.({ data: { hash: 'ab'.repeat(32) } })
          )
        }

        terminate(): void {}
      }
    })
    try {
      const sockets = fakeSockets()
      globalThis.WebSocket = sockets.Impl as unknown as typeof WebSocket
      const signedIn = { value: true }
      fixtureFetch(signedIn)
      showRoute({ name: 'scoreboardOverride', gameId: 'g1' }, true)
      await render(<App />)
      signedIn.value = false
      await act(async () => {
        sockets.latest().drop(4401)
      })
      expect(currentRoute()).deep.equals({
        name: 'signIn',
        next: '/games/g1/scoreboard-override'
      })
      expect(document.body.textContent).includes('Sign in to TeamStation')
      await press('Use a password instead')
      await type('E-mail address', 'runner@example.com')
      await type('Password', 'secret')
      await press('Sign in')
      expect(currentRoute()).deep.equals({
        name: 'scoreboardOverride',
        gameId: 'g1'
      })
      expect(sockets.sockets).length(2)
    } finally {
      for (const [key, descriptor] of [
        ['Worker', oldWorker],
        ['TS_PASSWORD_WORKER_URL', oldUrl]
      ] as const) {
        if (descriptor == null) Reflect.deleteProperty(globalThis, key)
        else Object.defineProperty(globalThis, key, descriptor)
      }
    }
  })
})
