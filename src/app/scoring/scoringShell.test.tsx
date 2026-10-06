import { expect } from 'chai'
import { afterEach, describe, it } from 'mocha'
import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'

import { TeamStationClient } from '../../common/api'
import { App, stackFor } from '../App'
import { BaseballScreen } from '../field/BaseballScreen'
import { StandaloneField } from '../field/StandaloneField'
import { parseRoute } from '../navigation/routes'
import {
  currentRoute,
  setNavigationGuard,
  showRoute,
  useBrowserBack
} from '../navigation/useAddressBar'
import { ThemeProvider } from '../theme/ThemeContext'
import webMusic from '../walkup/walkUpMusic'
import type { PlaybackState, WalkUpMusic } from '../walkup/walkUpMusicTypes'
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
          ? { ...gameFixture, canScore: true }
          : path.endsWith('/live-streams')
            ? { streams: [] }
            : []
    return new Response(JSON.stringify(data), {
      status: path.endsWith('/auth/me') && !signedIn ? 401 : 200,
      headers: { 'Content-Type': 'application/json' }
    })
  }
}
function navigationFixture(past = false): void {
  fixtureFetch()
  const fetchFixture = globalThis.fetch
  globalThis.fetch = async (input, init) => {
    const path = (
      typeof input === 'string'
        ? input
        : input instanceof URL
          ? input.href
          : input.url
    ).split('?')[0]
    if (path.endsWith('/events') && !path.includes('/games/')) {
      return new Response(
        JSON.stringify([
          {
            ...gameFixture,
            startAt: new Date(
              Date.now() + (past ? -1 : 1) * 86400000
            ).toISOString(),
            homeTeamExternal: false,
            awayTeamExternal: false,
            videoCount: 1
          }
        ]),
        { headers: { 'Content-Type': 'application/json' } }
      )
    }
    return await fetchFixture(input, init)
  }
}
async function clickTab(label: string): Promise<void> {
  const nav = document.querySelector('[aria-label="Schedule"]')?.parentElement
  const button = nav?.querySelector<HTMLElement>(`[aria-label="${label}"]`)
  expect(button, `${label} navigation tab`).not.equals(null)
  await act(async () => {
    button?.click()
  })
}
async function openListedGame(): Promise<void> {
  const label = document
    .querySelector('[aria-label^="Owls @ Hawks,"]')
    ?.getAttribute('aria-label')
  expect(
    label,
    Array.from(document.querySelectorAll('[aria-label]'))
      .map(node => node.getAttribute('aria-label'))
      .join(', ')
  ).to.be.a('string')
  await click(label!)
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
    expect(currentRoute()).deep.equals({
      name: 'game',
      gameId: 'g1',
      tab: 'score'
    })
    await click('Full game scoring')
    expect(currentRoute()).deep.equals({ name: 'scoreGame', gameId: 'g1' })
    expect(document.querySelector('[aria-label="Schedule"]')).equals(null)
    await click('Ball')
    expect(document.querySelector('[aria-label="Undo Ball"]')).not.equals(null)
    // The Undo control describes the play: one line, no hint below it.
    const undo = document.querySelector('[aria-label="Undo Ball"]')!
    expect(
      undo.querySelector('[data-testid="scoring-control-label"]')?.textContent
    ).equals('Ball')
    expect(undo.textContent).not.includes('Undo last action')
    await click('Called Strike')
    expect(
      document
        .querySelector('[aria-label="Undo Called Strike"]')
        ?.querySelector('[data-testid="scoring-control-label"]')?.textContent
    ).equals('Called strike')
    await click('Undo Called Strike')
    await click('Undo Ball')
    await click('Open scoring menu')
    // Below ☰, as the web draws it, so ☰ is never under the menu.
    let menuBox = document.querySelector<HTMLElement>(
      '[aria-label="Exit Current Game"]'
    )
    while (menuBox?.style.top === '') menuBox = menuBox.parentElement
    expect(menuBox?.style.top).equals('64px')
    expect(menuBox?.style.right).equals('12px')
    await click('Exit Current Game')
    expect(currentRoute().name).equals('game')
  })
  for (const when of ['upcoming', 'past'] as const) {
    it(`returns Schedule to its ${when} list after exiting scoring twice`, async function () {
      navigationFixture(when === 'past')
      showRoute({ name: 'schedule', when }, true)
      await render(<App />)
      for (let cycle = 0; cycle < 2; cycle++) {
        await openListedGame()
        await click('Score Game')
        await click('Full game scoring')
        await click('Open scoring menu')
        await click('Exit Current Game')
        expect(currentRoute()).include({
          name: 'game',
          gameId: 'g1',
          tab: 'watch'
        })
        await clickTab('Videos')
        await clickTab('Schedule')
        expect(currentRoute()).deep.equals({ name: 'schedule', when })
        expect(
          document.querySelector('[aria-label="Open scoring menu"]')
        ).equals(null)
        expect(document.querySelector('[aria-label="Upcoming"]')).not.equals(
          null
        )
      }
    })
  }
  it('clears Videos after scoring exit and preserves the game held in Schedule', async function () {
    navigationFixture()
    showRoute({ name: 'schedule', when: 'upcoming' }, true)
    await render(<App />)
    await openListedGame()
    await click('Score Game')
    await clickTab('Videos')
    await openListedGame()
    await click('Score Game')
    await click('Full game scoring')
    await click('Open scoring menu')
    await click('Exit Current Game')
    await clickTab('Schedule')
    expect(currentRoute()).include({ name: 'game', gameId: 'g1', tab: 'score' })
    await clickTab('Videos')
    expect(currentRoute().name).equals('videos')
    expect(document.querySelector('[aria-label="Open scoring menu"]')).equals(
      null
    )
  })
  it('returns a direct scoring link to its game without leaving a scorer in Schedule', async function () {
    fixtureFetch()
    showRoute({ name: 'scoreGame', gameId: 'g1' }, true)
    await render(<App />)
    await click('Open scoring menu')
    await click('Exit Current Game')
    expect(currentRoute()).include({ name: 'game', gameId: 'g1', tab: 'watch' })
    await clickTab('Schedule')
    expect(currentRoute().name).equals('schedule')
    await click('Home')
    expect(currentRoute()).include({ name: 'game', gameId: 'g1', tab: 'watch' })
  })
  it('has a visible failure exit, retries the load, and ignores a late response after unmount', async function () {
    const client = new TeamStationClient({ baseUrl: '/api/v1' })
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
    const client = new TeamStationClient({ baseUrl: '/api/v1' })
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
  it('puts the walk-up note in its own row directly above the row More starts', async function () {
    const screen = (walkUp?: React.ReactElement): React.ReactElement => (
      <BaseballScreen
        field={{
          players: [],
          selected: '',
          onSelect: () => undefined,
          view: 'home',
          zoom: 1
        }}
        onMenu={() => undefined}
        onUndo={() => undefined}
        onPitch={() => undefined}
        canPitch
        summary="Game"
        moreControl={<button aria-label="More" />}
        walkUpControl={walkUp}
      />
    )
    await render(screen())
    expect(document.querySelector('[data-testid="walk-up-row"]')).equals(null)
    await act(async () => {
      root?.render(
        <ThemeProvider>{screen(<button aria-label="Note" />)}</ThemeProvider>
      )
    })
    const row = document.querySelector('[data-testid="walk-up-row"]')!
    const note = document.querySelector('[aria-label="Note"]')!
    const more = document.querySelector('[aria-label="More"]')!
    expect(row.contains(note)).equals(true)
    expect(row.contains(more)).equals(false)
    // The next thing down is the deck, whose first row starts with More.
    const deck = row.nextElementSibling!
    expect(deck.contains(more)).equals(true)
    const moreRow = more.parentElement!
    expect(moreRow.firstElementChild).equals(more)
    expect(deck.firstElementChild?.firstElementChild).equals(moreRow)
  })
  it('shows the batter’s note on a phone, and never on the web', async function () {
    const song = {
      provider: 'localFile',
      providerId: 'lf:000000000000000b',
      isrc: null,
      title: 'Walk This Way',
      artist: 'Band',
      album: null,
      artworkUrl: null,
      durationMs: 90000,
      startMs: 10000,
      endMs: 25000
    }
    const roster = (base: number): unknown[] =>
      Array.from({ length: 9 }, (_, index) => ({
        userId: base + index,
        shortName: `P${base + index}`,
        fullName: null,
        avatarUrl: null,
        jersey: String(index + 1),
        positions: [],
        isPlayer: true,
        role: 'member',
        walkUpSong: song
      }))
    globalThis.fetch = async input => {
      const path = (
        typeof input === 'string'
          ? input
          : input instanceof URL
            ? input.href
            : input.url
      ).split('?')[0]
      const data = path.endsWith('/games/g1')
        ? gameFixture
        : path.endsWith('/teams/away/roster')
          ? roster(100)
          : path.endsWith('/teams/home/roster')
            ? roster(200)
            : []
      return new Response(JSON.stringify(data), {
        status: 200,
        headers: { 'Content-Type': 'application/json' }
      })
    }
    const client = new TeamStationClient({ baseUrl: 'http://api.test' })
    const listeners = new Set<(state: PlaybackState) => void>()
    const played: string[] = []
    const stops: number[] = []
    const phone: WalkUpMusic = {
      ...webMusic,
      available: true,
      play: async handle => {
        played.push(handle)
      },
      stop: async fadeMs => {
        stops.push(fadeMs)
      },
      onState: listener => {
        listeners.add(listener)
        return () => {
          listeners.delete(listener)
        }
      }
    }
    const owners: string[] = []
    await render(
      <ScoringScreen
        client={client}
        gameId="g1"
        onExit={() => undefined}
        music={phone}
        resolveSong={async (_song, owner) => {
          owners.push(`${owner.teamId}:${owner.userId}`)
          return 'content://walk'
        }}
      />
    )
    await act(async () => {
      await new Promise(resolve => setTimeout(resolve, 50))
    })
    const note = document.querySelector<HTMLElement>(
      '[data-testid="walk-up-note"]'
    )
    expect(note, 'note').not.equals(null)
    expect(owners[0]).matches(/^away:10\d$/)
    await act(async () => {
      note?.click()
    })
    expect(played).deep.equals(['content://walk'])
    // A pitch ends the walk-up: the note goes.
    await click('Ball')
    expect(document.querySelector('[data-testid="walk-up-note"]')).equals(null)
    expect(stops).deep.equals([1500])
    // Undo brings it back idle; leaving stops the song at once.
    await click('Undo Ball')
    await act(async () => {
      document
        .querySelector<HTMLElement>('[data-testid="walk-up-note"]')
        ?.click()
    })
    expect(played).deep.equals(['content://walk', 'content://walk'])
    await click('Open scoring menu')
    await click('Exit Current Game')
    expect(stops).deep.equals([1500, 0])
    await act(async () => {
      root?.unmount()
    })
    root = undefined

    // The web's music has nothing to play: no note, and nothing looked for.
    owners.length = 0
    await render(
      <ScoringScreen
        client={client}
        gameId="g1"
        onExit={() => undefined}
        music={webMusic}
        resolveSong={async (_song, owner) => {
          owners.push(owner.userId)
          return 'content://walk'
        }}
      />
    )
    await act(async () => {
      await new Promise(resolve => setTimeout(resolve, 50))
    })
    expect(document.querySelector('[data-testid="walk-up-note"]')).equals(null)
    expect(owners).deep.equals([])
  })
})
