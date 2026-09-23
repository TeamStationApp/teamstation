import { expect } from 'chai'
import { afterEach, describe, it } from 'mocha'
import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'

import { GameStationClient } from '../../common/api'
import { App, stackFor } from '../App'
import { StandaloneField } from '../field/StandaloneField'
import { parseRoute } from '../navigation/routes'
import {
  currentRoute,
  setNavigationGuard,
  showRoute,
  useBrowserBack
} from '../navigation/useAddressBar'
import { ThemeProvider } from '../theme/ThemeContext'
import { gameFixture } from './isUnscoredGame.test'
import { ScoringScreen } from './ScoringScreen'
import { useScoringExit as nativeExit } from './useScoringExit.native'

let root: Root | undefined
const originalFetch = globalThis.fetch
// Save the host method for restoration, not invocation.
// eslint-disable-next-line @typescript-eslint/unbound-method
const getContext = HTMLCanvasElement.prototype.getContext
async function render(element: React.ReactElement): Promise<void> {
  HTMLCanvasElement.prototype.getContext = (() => null) as typeof getContext
  const node = document.createElement('div')
  document.body.appendChild(node)
  root = createRoot(node)
  await act(async () => {
    root?.render(<ThemeProvider>{element}</ThemeProvider>)
  })
}
async function click(label: string): Promise<void> {
  const button = document.querySelector<HTMLElement>(`[aria-label="${label}"]`)
  expect(button, label).not.equals(null)
  await act(async () => {
    button?.click()
  })
}
afterEach(async function () {
  await act(async () => {
    root?.unmount()
  })
  root = undefined
  globalThis.fetch = originalFetch
  HTMLCanvasElement.prototype.getContext = getContext
})
function fixtureFetch(signedIn = true): void {
  globalThis.fetch = async input => {
    const path = (
      typeof input === 'string'
        ? input
        : input instanceof URL
          ? input.href
          : input.url
    ).split('?')[0]
    const data = path.endsWith('/auth/me')
      ? { id: 100, displayName: 'Scorer', isAdmin: false }
      : path.endsWith('/games/g1/events')
        ? { plays: [], currentPlay: null }
        : path.endsWith('/games/g1')
          ? gameFixture
          : path.endsWith('/live-streams')
            ? { streams: [] }
            : []
    return new Response(JSON.stringify(data), {
      status: path.endsWith('/auth/me') && !signedIn ? 401 : 200,
      headers: { 'Content-Type': 'application/json' }
    })
  }
}
describe('scoring shell and exit', function () {
  for (const path of [
    '/',
    '/videos',
    '/schedule',
    '/account',
    '/players/p1',
    '/teams/t1/manage'
  ]) {
    it(`keeps existing navigation reachable at ${path}`, async function () {
      fixtureFetch()
      const route = parseRoute(path)
      showRoute(route, true)
      await render(<App />)
      expect(document.querySelector('[aria-label="Home"]')).not.equals(null)
      expect(currentRoute().name).equals(route.name)
      await click('Schedule')
      expect(currentRoute().name).equals('schedule')
      await click('Videos')
      expect(currentRoute().name).equals('videos')
      await click('Home')
      if (['account', 'player', 'manage'].includes(route.name)) {
        expect(currentRoute().name).equals(route.name)
        await click('Home')
      }
      expect(currentRoute().name).equals('home')
    })
  }
  it('keeps direct scoring links behind sign in', async function () {
    fixtureFetch(false)
    showRoute({ name: 'scoreGame', gameId: 'g1' }, true)
    await render(<App />)
    expect(document.body.textContent).includes('Sign in')
    expect(currentRoute()).deep.equals({ name: 'scoreGame', gameId: 'g1' })
  })
  it('opens the signed-in game and immersive scorer with no global field tab', async function () {
    fixtureFetch()
    showRoute({ name: 'game', gameId: 'g1' }, true)
    await render(<App />)
    await click('Score Game')
    expect(currentRoute()).deep.equals({ name: 'scoreGame', gameId: 'g1' })
    expect(document.querySelector('[aria-label="Schedule"]')).equals(null)
    await click('Ball')
    expect(document.querySelector('[aria-label="Undo Ball"]')).not.equals(null)
    await click('Undo Ball')
    await click('Open scoring menu')
    await click('Exit Current Game')
    expect(currentRoute().name).equals('game')
  })
  it('has a visible failure exit, retries the load, and ignores a late response after unmount', async function () {
    const client = new GameStationClient({ baseUrl: '/api/v1' })
    let loads = 0
    client.game = async () => {
      loads++
      throw new Error('missing')
    }
    let exits = 0
    await render(
      <ScoringScreen
        client={client}
        gameId="g1"
        onExit={() => {
          exits++
        }}
      />
    )
    expect(document.body.textContent).includes('Unable to load scoring.')
    expect(loads).equals(1)
    await click('Retry loading scoring')
    expect(loads).equals(2)
    await click('Exit Current Game')
    expect(exits).equals(1)
  })
  it('warns on dirty exit and document unload, while Undo clears the warning', async function () {
    const client = new GameStationClient({ baseUrl: '/api/v1' })
    client.game = async () => gameFixture
    let exits = 0
    // Save the host method solely for restoration.
    // eslint-disable-next-line @typescript-eslint/unbound-method
    const confirm = window.confirm
    try {
      await render(
        <ScoringScreen
          client={client}
          gameId="g1"
          onExit={() => {
            exits++
          }}
        />
      )
      await click('Ball')
      const unload = new window.Event('beforeunload', { cancelable: true })
      window.dispatchEvent(unload)
      expect(unload.defaultPrevented).equals(true)
      await click('Open scoring menu')
      await click('Exit Current Game')
      expect(exits).equals(0)
      await click('Cancel')
      await click('Open scoring menu')
      await click('Exit Current Game')
      await click('Discard and Exit')
      expect(exits).equals(1)
      await click('Undo Ball')
      const cleanUnload = new window.Event('beforeunload', { cancelable: true })
      window.dispatchEvent(cleanUnload)
      expect(cleanUnload.defaultPrevented).equals(false)
    } finally {
      window.confirm = confirm
    }
  })
  it('retains the standalone field controls and repeated undo', async function () {
    let exits = 0
    await render(
      <StandaloneField
        onExit={() => {
          exits++
        }}
      />
    )
    for (const pitch of [
      'Ball',
      'Called Strike',
      'Swing and Miss',
      'Foul Ball',
      'Ball in Play'
    ])
      await click(pitch)
    for (const pitch of [
      'Ball in Play',
      'Foul Ball',
      'Swing and Miss',
      'Called Strike',
      'Ball'
    ])
      await click(`Undo ${pitch}`)
    await click('More')
    await click('Reset camera')
    await click('More')
    await click('Reset players')
    await click('Open field menu')
    await click('Resume field')
    await click('Open field menu')
    await click('Exit field')
    expect(exits).equals(1)
  })
  it('maps scoring and existing pushed destinations and retains native exit compatibility', function () {
    expect(stackFor({ name: 'scoreGame', gameId: 'g1' })).deep.equals({
      home: [{ name: 'scoreGame', gameId: 'g1' }]
    })
    for (const route of [
      { name: 'account' } as const,
      { name: 'player', userId: 'p1' } as const,
      { name: 'manage', scopeKind: 'team', scopeId: 't1' } as const
    ])
      expect(stackFor(route).home).has.length(1)
    let exits = 0
    nativeExit('g1', false, () => {
      exits++
    })()
    expect(exits).equals(1)
  })
  it('declines and accepts browser Back without adding history entries', async function () {
    const routes: string[] = []
    function Observer(): null {
      useBrowserBack(route => {
        routes.push(route.name)
      })
      return null
    }
    showRoute({ name: 'game', gameId: 'g1' }, true)
    showRoute({ name: 'scoreGame', gameId: 'g1' })
    await render(<Observer />)
    let resolveCheck: ((value: boolean) => void) | undefined
    const remove = setNavigationGuard(
      async () =>
        await new Promise<boolean>(resolve => {
          resolveCheck = resolve
        }),
      { name: 'game', gameId: 'g1' }
    )
    const length = window.history.length
    await act(async () => {
      window.history.back()
      await new Promise(resolve => setTimeout(resolve, 30))
    })
    expect(currentRoute().name).equals('scoreGame')
    expect(resolveCheck).not.equals(undefined)
    await act(async () => {
      resolveCheck?.(false)
    })
    expect(routes).deep.equals([])
    expect(window.history.length).equals(length)
    await act(async () => {
      window.history.back()
      await new Promise(resolve => setTimeout(resolve, 30))
    })
    await act(async () => {
      resolveCheck?.(true)
      await new Promise(resolve => setTimeout(resolve, 30))
    })
    expect(routes).deep.equals(['game'])
    expect(currentRoute().name).equals('game')
    remove()
  })
})
