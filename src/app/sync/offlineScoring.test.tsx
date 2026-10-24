import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { expect } from 'chai'
import { afterEach, beforeEach, describe, it } from 'mocha'
import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { GestureHandlerRootView } from 'react-native-gesture-handler'

import type { GumboPlay } from '../../common/gumboPlay'
import { ScoringSession } from '../../common/scoring/session'
import { userIdOfGumbo } from '../../common/userId'
import { nodeSqliteExecutor } from '../../test/nodeSqliteExecutor'
import { scoringRoster, scoringSession } from '../../test/scoringSession'
import { TRY_AGAIN, USE_SERVER_COPY } from '../scoring/HeldGameNotice'
import { gameFixture } from '../scoring/isUnscoredGame.test'
import type { PreferenceStorage } from '../scoring/scoringPreferenceStore'
import { ScoringScreen } from '../scoring/ScoringScreen'
import { memoryStore, ServerScoringSource } from '../scoring/scoringSource'
import { ServerClock } from '../scoring/serverClock'
import { CoachGameScreen } from '../screens/CoachGameScreen'
import { ThemeProvider } from '../theme/ThemeContext'
import { cacheFileName, type DocumentStore, openCacheStore } from './cacheStore'
import { CachingClient } from './cachingClient'
import { eventsKey, fullRosterKey, lineupsKey, rosterKey } from './documentKeys'
import type { OutboxSummary } from './outbox'
import {
  OFFLINE_BANNER,
  PARKED_GAME_MESSAGE,
  SERVER_COPY_PENDING
} from './useOffline'

/** The id the server gives the player the phone made offline. */
const SERVER_GUMBO = 900_001

interface Post {
  path: string
  body: Record<string, unknown>
}

/**
 * The server of one upcoming game, `g1`, between the Owls (away) and the
 * Hawks (home), scored by a scorekeeper of both: its game, rosters, lineups
 * and the plays already stored, and the two writes scoring makes.
 */
function fieldServer(stored: { plays: GumboPlay[]; currentPlay: unknown }): {
  fetch: typeof globalThis.fetch
  offline: boolean
  /** Another device saved the lineups: live posts are stale. */
  stale: boolean
  posts: Post[]
} {
  const plays = new Map(stored.plays.map(play => [play.about.atBatIndex, play]))
  let currentPlay = stored.currentPlay
  let revision = 1
  const made: Array<{ teamId: string; entry: unknown }> = []
  const roster = (teamId: string): unknown[] => [
    ...JSON.parse(
      JSON.stringify(scoringRoster(teamId === gameFixture.awayTeamId ? 1 : 10))
    ),
    ...made.filter(entry => entry.teamId === teamId).map(entry => entry.entry)
  ]
  const side = (teamId: string, teamName: string): unknown => ({
    teamId,
    teamName,
    start: null,
    changes: [],
    current: null
  })
  const eventsBody = (): unknown => ({
    plays: [...plays.values()]
      .sort((a, b) => a.about.atBatIndex - b.about.atBatIndex)
      .map((gumbo, index) => ({ id: `evt_${index}`, gameId: 'g1', gumbo })),
    currentPlay,
    playsDigest: `plays-${revision}`,
    lineupsDigest: 'lineups-1'
  })
  const routes: Record<string, () => unknown> = {
    // The scorekeeper also coaches the Hawks, for Coach Game.
    '/games/g1': () => ({ ...gameFixture, coachSides: ['home'] }),
    '/games/g1/events': eventsBody,
    '/games/g1/lineups': () => ({
      away: side('away', 'Owls'),
      home: side('home', 'Hawks'),
      digest: 'lineups-1'
    }),
    '/me/roles': () => ({
      teams: { away: ['scorekeeper'], home: ['scorekeeper'] },
      guardianOf: []
    }),
    '/events?when=upcoming': () => [
      {
        id: 'g1',
        seasonId: null,
        homeTeamId: 'home',
        awayTeamId: 'away',
        homeTeamName: 'Hawks',
        awayTeamName: 'Owls',
        homeTeamExternal: false,
        awayTeamExternal: false,
        startAt: '2026-10-22T18:00:00Z',
        venue: null,
        status: 'scheduled',
        homeScore: null,
        awayScore: null,
        ingestStatus: 'none',
        videoCount: 0
      }
    ],
    '/teams': () => [],
    '/teams/away/roster': () => roster('away'),
    '/teams/away/roster?includeFullNames=true': () => roster('away'),
    '/teams/home/roster': () => roster('home'),
    '/teams/home/roster?includeFullNames=true': () => roster('home'),
    '/teams/away/default-lineup': () => ({
      lineup: null,
      fromGameId: null,
      setAt: null
    }),
    '/teams/home/default-lineup': () => ({
      lineup: null,
      fromGameId: null,
      setAt: null
    })
  }
  const state = {
    offline: false,
    stale: false,
    posts: [] as Post[],
    fetch: (async (url: unknown, init?: RequestInit) => {
      if (state.offline) throw new TypeError('Load failed')
      const path = String(url).replace('http://x/api/v1', '')
      const json = (status: number, body: unknown): Response =>
        new Response(JSON.stringify(body), {
          status,
          headers: { 'x-teamstation-revision': String(revision) }
        })
      if (init?.method === 'POST') {
        const body = JSON.parse(init.body as string) as Record<string, unknown>
        state.posts.push({ path, body })
        revision++
        const team = /^\/teams\/([^/]+)\/roster-players$/.exec(path)?.[1]
        if (team != null) {
          const entry = {
            userId: userIdOfGumbo(SERVER_GUMBO),
            gumboId: SERVER_GUMBO,
            shortName: 'Mookie B',
            nameDetails: {
              firstName: body.firstName,
              lastName: body.lastName,
              displayName: 'Mookie Betts'
            },
            jersey: body.jersey,
            positions: body.positions,
            isPlayer: true,
            role: 'member',
            section: 'player',
            staffRoles: [],
            inheritedFrom: null
          }
          made.push({ teamId: team, entry })
          return json(201, entry)
        }
        if (path === '/games/g1/lineups')
          return json(200, {
            away: side('away', 'Owls'),
            home: side('home', 'Hawks'),
            digest: `lineups-${revision}`
          })
        if (path === '/games/g1/events' && state.stale)
          return json(409, {
            code: 'conflict',
            message: 'Somebody else changed the lineups',
            details: { stale: true }
          })
        if (path === '/games/g1/events') {
          for (const index of body.remove as number[]) plays.delete(index)
          for (const play of body.plays as GumboPlay[])
            plays.set(play.about.atBatIndex, play)
          if ('currentPlay' in body) currentPlay = body.currentPlay
          return json(200, eventsBody())
        }
        return json(404, { code: 'notFound', message: 'Not found' })
      }
      const route = routes[path]
      return route == null
        ? json(404, { code: 'notFound', message: 'Not found' })
        : json(200, route())
    }) as unknown as typeof globalThis.fetch
  }
  return state
}

function memoryStorage(): PreferenceStorage {
  const held = new Map<string, string>()
  return {
    getItem: async key => held.get(key) ?? null,
    setItem: async (key, value) => {
      held.set(key, value)
    }
  }
}

// eslint-disable-next-line @typescript-eslint/unbound-method
const getContext = HTMLCanvasElement.prototype.getContext
let root: Root | undefined

async function click(label: string): Promise<void> {
  const nodes = document.querySelectorAll<HTMLElement>(
    `[aria-label="${label}"]`
  )
  const node = nodes.item(nodes.length - 1)
  expect(node, label).not.equals(null)
  await act(async () => {
    node.click()
  })
}

async function input(label: string, value: string): Promise<void> {
  const node = document.querySelector<HTMLInputElement>(
    `[aria-label="${label}"]`
  )
  expect(node, label).not.equals(null)
  await act(async () => {
    Object.getOwnPropertyDescriptor(
      window.HTMLInputElement.prototype,
      'value'
    )!.set!.call(node, value)
    node!.dispatchEvent(new window.Event('input', { bubbles: true }))
  })
}

async function settle(ms = 20): Promise<void> {
  await act(async () => {
    await new Promise(resolve => setTimeout(resolve, ms))
  })
}

const hasLabel = (label: string): boolean =>
  document.querySelector(`[aria-label="${label}"]`) != null

const status = (): string | null | undefined =>
  document.querySelector('[aria-label="Save status"]')?.textContent

describe('scoring an upcoming game on the phone with no signal (S6)', function () {
  let dir: string
  let executors: Array<ReturnType<typeof nodeSqliteExecutor>>

  beforeEach(function () {
    dir = mkdtempSync(join(tmpdir(), 'teamstation-field-'))
    executors = []
    HTMLCanvasElement.prototype.getContext = (() => null) as typeof getContext
  })
  afterEach(async function () {
    await act(async () => {
      root?.unmount()
    })
    root = undefined
    document.body.replaceChildren()
    HTMLCanvasElement.prototype.getContext = getContext
    for (const executor of executors) await executor.close()
    rmSync(dir, { recursive: true, force: true })
  })

  /** A phone that read ahead for `g1` while it had signal. */
  async function preparedPhone(): Promise<{
    client: CachingClient
    net: ReturnType<typeof fieldServer>
    rows: () => Array<Record<string, unknown>>
    document: (key: string) => { body: unknown; pending: number } | undefined
  }> {
    // The game as the last scorer left it: one pitch in.
    const started = memoryStore()
    const first = ScoringSession.start(
      started,
      'g1',
      scoringSession(gameFixture)
    )
    first.apply({ type: 'pitch', call: 'B' })
    await first.flush()
    const net = fieldServer(started.games.get('g1')!)
    const openCache = async (userId: string): Promise<DocumentStore> => {
      const executor = nodeSqliteExecutor(join(dir, cacheFileName(userId)))
      executors.push(executor)
      return await openCacheStore(executor)
    }
    const client = new CachingClient({
      baseUrl: 'http://x/api/v1',
      token: 'token-1',
      fetch: net.fetch,
      openCache,
      outbox: { setTimer: () => 0, clearTimer: () => undefined }
    })
    client.openFor('usr_scorer')
    await client.prefetch()
    const db = (): ReturnType<typeof nodeSqliteExecutor>['db'] =>
      executors.at(-1)!.db
    return {
      client,
      net,
      rows: () => db().prepare('SELECT * FROM outbox ORDER BY seq').all(),
      document: key => {
        const row = db()
          .prepare('SELECT body, pending FROM documents WHERE key = ?')
          .get(key) as { body: string; pending: number } | undefined
        return row == null
          ? undefined
          : { body: JSON.parse(row.body), pending: row.pending }
      }
    }
  }

  async function open(client: CachingClient): Promise<void> {
    const source = new ServerScoringSource(
      client,
      new ServerClock(async () => await client.serverTime(), memoryStorage())
    )
    const host = document.createElement('div')
    document.body.appendChild(host)
    root = createRoot(host)
    await act(async () => {
      root!.render(
        <ThemeProvider>
          <ScoringScreen
            client={client}
            gameId="g1"
            userId="usr_scorer"
            source={source}
            onExit={() => undefined}
          />
        </ThemeProvider>
      )
    })
    await settle(50)
  }

  it('opens the game, adds a named player, puts him in the lineup and records a play, all from the phone, then sends them once', async function () {
    const { client, net, rows, document: stored } = await preparedPhone()
    for (const key of [
      'game.g1',
      eventsKey('g1'),
      'lineups.g1',
      'me.roles',
      rosterKey('away'),
      fullRosterKey('away'),
      rosterKey('home'),
      'defaultLineup.away'
    ])
      expect(stored(key), key).not.equals(undefined)

    // No signal from here on.
    net.offline = true
    const before = net.posts.length
    await open(client)
    expect(document.body.textContent).includes('Owls 0 · Hawks 0')
    expect(document.body.textContent).includes('1 balls')
    expect(status()).equals(OFFLINE_BANNER)

    // Add a named player to the batting team's roster, and into its lineup.
    await click('Open scoring menu')
    await click('Set Team Rosters')
    await click('Remove Player 9')
    await click('Create Player')
    await input('First Name', 'Mookie')
    await input('Last Name', 'Betts')
    await click('Create Player')
    await settle()
    await click('Add Mookie B to Lineup')
    await click('Save Rosters')
    await settle()
    // And one play.
    await click('Ball')
    await settle(50)
    expect(document.body.textContent).includes('2 balls')
    expect(status()).equals(OFFLINE_BANNER)
    expect(net.posts.length, 'nothing left the phone').equals(before)

    // The phone holds the player, the lineup with him in it, and the play.
    const local = (
      stored(fullRosterKey('away'))!.body as Array<{
        gumboId: number
        shortName: string
      }>
    ).find(entry => entry.shortName === 'Mookie B')
    expect(local, 'on the roster the phone shows').not.equals(undefined)
    expect(
      (stored(rosterKey('away'))!.body as Array<{ gumboId: number }>).some(
        entry => entry.gumboId === local!.gumboId
      )
    ).equals(true)
    const events = stored(eventsKey('g1'))!
    expect(events.pending).equals(1)
    expect(JSON.stringify(events.body)).includes(String(local!.gumboId))
    const queued = rows()
    expect(queued.map(row => row.chain)).deep.equals([
      'team:away',
      ...queued.slice(1).map(() => 'game:g1')
    ])
    expect(queued.length).greaterThan(1)
    for (const row of queued.slice(1))
      expect(JSON.parse(String(row.depends_on))).deep.equals([queued[0].id])

    // The server is back: the player is made first, and the plays name him
    // by the id the server gave him, once each.
    net.offline = false
    client.wakeOutbox(true)
    await act(async () => {
      await client.drainOutbox()
    })
    expect(rows()).deep.equals([])
    const sent = net.posts.slice(before)
    expect(sent.map(post => post.path)).deep.equals([
      '/teams/away/roster-players',
      ...sent.slice(1).map(() => '/games/g1/events')
    ])
    expect(sent.filter(post => post.path.includes('roster'))).length(1)
    for (const post of sent.slice(1)) {
      const body = JSON.stringify(post.body)
      expect(body).not.includes(String(local!.gumboId))
      expect(post.body.lineupsBase).not.match(/^local-/)
    }
    // The server's game holds him, under the server's id, and the ball.
    const served = await (
      await net.fetch('http://x/api/v1/games/g1/events')
    ).text()
    expect(served).includes(String(SERVER_GUMBO))
    expect(served).not.includes(String(local!.gumboId))
    expect(stored(eventsKey('g1'))!.pending).equals(0)
  })

  it("says the server copy moved on over a parked game, and gives the phone's innings up for it once confirmed", async function () {
    const { client, net, rows, document: stored } = await preparedPhone()
    net.offline = true
    await open(client)
    await click('Ball')
    await settle(50)
    expect(document.body.textContent).includes('2 balls')
    // The server is back, and another device's lineup made the post stale.
    net.offline = false
    net.stale = true
    client.wakeOutbox(true)
    await act(async () => {
      await client.drainOutbox()
    })
    await settle(50)
    const message = (): string | null | undefined =>
      document.querySelector('[data-testid="heldGameMessage"]')?.textContent
    expect(message()).equals(PARKED_GAME_MESSAGE)
    expect(rows().map(row => row.state)).deep.equals(['parked'])

    // Opening the choice, and cancelling it, changes nothing.
    await click('Unsent changes')
    expect(hasLabel(USE_SERVER_COPY)).equals(true)
    expect(
      hasLabel(TRY_AGAIN),
      'offered, though a stale lineup parks again'
    ).equals(true)
    await click('Cancel')
    expect(hasLabel(USE_SERVER_COPY)).equals(false)
    expect(rows()).length(1)

    await click('Unsent changes')
    await click(USE_SERVER_COPY)
    await settle(100)
    expect(rows()).deep.equals([])
    expect(stored(eventsKey('g1'))!.pending).equals(0)
    expect(message()).equals(undefined)
    // The server's copy: the one ball it had.
    expect(document.body.textContent).includes('1 balls')
  })

  it("says the server's copy has not arrived when it gave the phone's innings up with no signal", async function () {
    const { client, net } = await preparedPhone()
    net.offline = true
    await open(client)
    await click('Ball')
    await settle(50)
    net.offline = false
    net.stale = true
    client.wakeOutbox(true)
    await act(async () => {
      await client.drainOutbox()
    })
    await settle(50)
    // The signal goes again just as the person gives the innings up.
    net.offline = true
    await click('Unsent changes')
    await click(USE_SERVER_COPY)
    await settle(100)
    expect(document.body.textContent).includes(SERVER_COPY_PENDING)
    expect(document.body.textContent).not.includes('2 balls')
    net.offline = false
    await click('Retry loading scoring')
    await settle(100)
    expect(document.body.textContent).includes('1 balls')
  })

  it("shows the server's message over a game whose queued write it refused", async function () {
    const { client } = await preparedPhone()
    client.outboxSummary = async () => ({
      count: 1,
      chains: { 'game:g1': 1 },
      games: { g1: { state: 'dead', message: 'That inning is closed.' } },
      teams: {}
    })
    const asked: string[] = []
    client.retryGame = async gameId => {
      asked.push(`retry ${gameId}`)
    }
    await open(client)
    expect(
      document.querySelector('[data-testid="heldGameMessage"]')?.textContent
    ).equals('Not sent: That inning is closed.')
    await click('Unsent changes')
    await click(TRY_AGAIN)
    await settle()
    expect(asked).deep.equals(['retry g1'])
    expect(hasLabel(TRY_AGAIN), 'closed').equals(false)
  })

  it('offers Coach Game the same way out of a refused game', async function () {
    const { client } = await preparedPhone()
    let held = true
    client.outboxSummary = async (): Promise<OutboxSummary> => ({
      count: held ? 1 : 0,
      chains: held ? { 'game:g1': 1 } : {},
      games: held
        ? { g1: { state: 'dead', message: 'Only the head coach.' } }
        : {},
      teams: {}
    })
    let reads = 0
    const game = client.game.bind(client)
    client.game = async gameId => {
      reads++
      return await game(gameId)
    }
    client.discardGame = async () => {
      held = false
      return true
    }
    const host = document.createElement('div')
    document.body.appendChild(host)
    root = createRoot(host)
    await act(async () => {
      root!.render(
        <ThemeProvider>
          <GestureHandlerRootView>
            <CoachGameScreen
              client={client}
              gameId="g1"
              teamId="home"
              onExit={() => undefined}
            />
          </GestureHandlerRootView>
        </ThemeProvider>
      )
    })
    for (let i = 0; i < 100 && !hasLabel('Save Rosters'); i++) await settle(10)
    expect(
      document.querySelector('[data-testid="heldGameMessage"]')?.textContent
    ).equals('Not sent: Only the head coach.')
    const before = reads
    await click('Unsent changes')
    await click(USE_SERVER_COPY)
    await settle(100)
    expect(held).equals(false)
    expect(reads, 'the game is read again').greaterThan(before)
  })
  it('opens Coach Game from the phone and queues his lineup save until the server answers', async function () {
    const { client, net, rows, document: stored } = await preparedPhone()
    net.offline = true
    const before = net.posts.length
    const host = document.createElement('div')
    document.body.appendChild(host)
    root = createRoot(host)
    await act(async () => {
      root!.render(
        <ThemeProvider>
          <GestureHandlerRootView>
            <CoachGameScreen
              client={client}
              gameId="g1"
              teamId="home"
              onExit={() => undefined}
            />
          </GestureHandlerRootView>
        </ThemeProvider>
      )
    })
    for (let i = 0; i < 100 && !hasLabel('Save Rosters'); i++) await settle(10)
    expect(hasLabel('Save Rosters'), 'the roster screen').equals(true)
    expect(
      document.querySelector('[data-testid="coachOffline"]')?.textContent
    ).equals(OFFLINE_BANNER)

    await click('Lineup')
    const remove = document.querySelector<HTMLElement>(
      '[aria-label^="Remove "]'
    )!
    await act(async () => {
      remove.click()
    })
    await settle()
    await click('Save Rosters')
    await settle(50)
    expect(net.posts.length, 'nothing left the phone').equals(before)
    expect(rows().map(row => [row.chain, row.path])).deep.equals([
      ['game:g1', '/games/g1/lineups']
    ])
    expect(stored(lineupsKey('g1'))!.pending).equals(1)
    expect(document.body.textContent).not.includes('could not')

    net.offline = false
    client.wakeOutbox(true)
    await act(async () => {
      await client.drainOutbox()
    })
    expect(rows()).deep.equals([])
    const sent = net.posts.slice(before)
    expect(sent.map(post => post.path)).deep.equals(['/games/g1/lineups'])
    expect(sent[0].body.base).equals('lineups-1')
    expect(sent[0].body.side).equals('home')
  })
})
