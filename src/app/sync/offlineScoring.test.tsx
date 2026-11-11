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
import { GameScreen } from '../screens/GameScreen'
import { ThemeProvider } from '../theme/ThemeContext'
import { cacheFileName, type DocumentStore, openCacheStore } from './cacheStore'
import { CachingClient } from './cachingClient'
import { eventsKey, fullRosterKey, lineupsKey, rosterKey } from './documentKeys'
import {
  NEWER_LINEUP_MESSAGE,
  type OutboxNotice,
  type OutboxSummary,
  PENDING_APPROVAL_MESSAGE
} from './outbox'
import {
  OFFLINE_BANNER,
  PARKED_GAME_MESSAGE,
  SERVER_COPY_PENDING
} from './useOffline'

/** The id the server gives the player the phone made offline. */
const SERVER_GUMBO = 900_001

interface Post {
  path: string
  query: string
  body: Record<string, unknown>
}

/**
 * The server of one upcoming game, `g1`, between the Owls (away) and the
 * Hawks (home), scored by a scorekeeper of both: its game, rosters, lineups
 * and the plays already stored, and the two writes scoring makes.
 */
export function fieldServer(stored: {
  plays: GumboPlay[]
  currentPlay: unknown
}): {
  fetch: typeof globalThis.fetch
  offline: boolean
  /** Another device saved the lineups: live posts are stale. */
  stale: boolean
  /** Another device changed the lineups later: lineup saves are refused. */
  newer: boolean
  /** While set, a play's save waits on it before it is answered. */
  holdPlays?: Promise<void>
  /** While set, every request waits on it before it is answered. */
  hold?: Promise<void>
  posts: Post[]
  /** Each write as it reached the server: method and path. */
  writes: string[]
  /** While set, a tag is refused: its event is not the server's. */
  refuseTags: boolean
} {
  const plays = new Map(stored.plays.map(play => [play.about.atBatIndex, play]))
  let currentPlay = stored.currentPlay
  let revision = 1
  // Home and away, as a swap leaves them, and the play generation.
  let swapped = false
  let generation = 0
  const tags = new Map<string, string>()
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
    lineupsDigest: swapped ? 'lineups-swapped' : 'lineups-1',
    generation
  })
  const routes: Record<string, () => unknown> = {
    // The scorekeeper also coaches the Hawks, for Coach Game.
    '/games/g1': () => ({
      ...gameFixture,
      ...(swapped
        ? {
            homeTeamId: gameFixture.awayTeamId,
            awayTeamId: gameFixture.homeTeamId,
            homeTeamName: gameFixture.awayTeamName,
            awayTeamName: gameFixture.homeTeamName
          }
        : {}),
      generation,
      coachSides: ['home']
    }),
    '/games/g1/events': eventsBody,
    '/games/g1/lineups': () => ({
      away: swapped ? side('home', 'Hawks') : side('away', 'Owls'),
      home: swapped ? side('away', 'Owls') : side('home', 'Hawks'),
      digest: swapped ? 'lineups-swapped' : 'lineups-1',
      generation
    }),
    '/tags': () => ({ recent: ['great catch'], popular: [] }),
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
    newer: false,
    holdPlays: undefined as Promise<void> | undefined,
    hold: undefined as Promise<void> | undefined,
    posts: [] as Post[],
    writes: [] as string[],
    refuseTags: false,
    fetch: (async (url: unknown, init?: RequestInit) => {
      if (state.hold != null) await state.hold
      if (state.offline) throw new TypeError('Load failed')
      const target = String(url).replace('http://x/api/v1', '')
      // A post is routed without its query, which says what it is answered.
      const [path, query = ''] =
        init?.method === 'POST' ? target.split('?') : [target]
      const json = (status: number, body: unknown): Response =>
        new Response(JSON.stringify(body), { status })
      if (init?.method != null && init.method !== 'GET')
        state.writes.push(`${init.method} ${path}`)
      const tag = /^\/games\/g1\/tags\/([^/]+)$/.exec(path)?.[1]
      if (tag != null && state.refuseTags)
        return json(404, { code: 'notFound', message: 'No such event.' })
      if (
        tag != null &&
        (init?.method === 'PUT' || init?.method === 'DELETE')
      ) {
        const label =
          init.method === 'PUT'
            ? String((JSON.parse(init.body as string) as { tag: string }).tag)
            : null
        if (label == null) tags.delete(tag)
        else tags.set(tag, label)
        return json(200, {
          targetId: tag,
          tag: label,
          revision: String(revision++)
        })
      }
      if (init?.method === 'POST' && path === '/games/g1/swap-sides') {
        const body = JSON.parse(init.body as string) as Record<string, unknown>
        state.posts.push({ path, query, body })
        const home = swapped ? gameFixture.awayTeamId : gameFixture.homeTeamId
        if (body.homeTeamId !== home)
          return json(409, {
            code: 'conflict',
            message: "This game's teams changed. Open it again."
          })
        const lost = plays.size
        if (typeof body.playsDigest === 'string') {
          if (body.playsDigest !== `plays-${revision}`)
            return json(409, {
              code: 'conflict',
              message: "This game's plays changed. Open it again."
            })
          plays.clear()
          currentPlay = null
          generation++
        }
        swapped = !swapped
        revision++
        return json(200, {
          homeTeamId: swapped ? gameFixture.awayTeamId : gameFixture.homeTeamId,
          awayTeamId: swapped ? gameFixture.homeTeamId : gameFixture.awayTeamId,
          generation,
          reset: { atBats: lost, innings: lost > 0 ? 1 : 0 }
        })
      }
      if (init?.method === 'POST') {
        const body = JSON.parse(init.body as string) as Record<string, unknown>
        state.posts.push({ path, query, body })
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
        if (path === '/games/g1/lineups' && state.newer)
          return json(409, {
            code: 'conflict',
            message: 'Another device changed this lineup later',
            details: { stale: true, newer: true }
          })
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
          await state.holdPlays
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

export function memoryStorage(): PreferenceStorage {
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

interface Fiber {
  type?: { name?: string } | string | null
  memoizedProps?: unknown
  child?: Fiber | null
  sibling?: Fiber | null
  memoizedState?: { memoizedState?: unknown; next?: Fiber['memoizedState'] }
  stateNode?: { current?: Fiber }
}
function findFiber(
  fiber: Fiber | null | undefined,
  name: string
): Fiber | undefined {
  for (let node = fiber; node != null; node = node.sibling) {
    if (typeof node.type === 'function' || typeof node.type === 'object')
      if (node.type?.name === name) return node
    const inside = findFiber(node.child, name)
    if (inside != null) return inside
  }
  return undefined
}
/** The component `name` as React rendered it last under `host`. */
function rendered(host: HTMLElement, name: string): Fiber {
  const key = Object.keys(host).find(key =>
    key.startsWith('__reactContainer$')
  )!
  const fiber = (host as unknown as Record<string, Fiber>)[key]
  const found = findFiber(fiber.stateNode?.current ?? fiber, name)
  if (found == null) throw new Error(`${name} has not rendered`)
  return found
}
/** The props the screen gave `name`: the 3D field's, here. */
function panelProps(host: HTMLElement, name: string): unknown {
  return rendered(host, name).memoizedProps
}
/** Says `transcript` to the scoring screen, as dictation hands it on. */
function dictateTo(
  host: HTMLElement,
  transcript: string,
  actions: unknown[],
  roster: unknown[]
): void {
  const panel = rendered(host, 'ScoringPanel')
  for (let hook = panel.memoizedState; hook != null; hook = hook.next) {
    const ref = hook.memoizedState as
      | {
          current?: {
            onActions?: (t: string, a: unknown[], r: unknown[]) => void
          }
        }
      | undefined
    if (typeof ref?.current?.onActions === 'function') {
      ref.current.onActions(transcript, actions, roster)
      return
    }
  }
  throw new Error('Missing dictated scoring callback')
}

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

    // Add a named player to the batting team's roster, and into its lineup:
    // a pitch is in, so nobody is taken out; he bats at its end.
    await click('Open scoring menu')
    await click('Set Team Rosters')
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
    // The phone's copy names its players, him too; what it will send names
    // nobody, and keeps their names beside it.
    expect(JSON.stringify(events.body)).includes('Mookie B')
    const queued = rows()
    for (const row of queued.slice(1)) {
      expect(String(row.body)).not.includes('Mookie')
      expect(String(row.body)).not.includes('"fullName"')
    }
    expect(
      queued.slice(1).some(row => String(row.names).includes('Mookie B'))
    ).equals(true)
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
    // The phone keeps the whole game it is answered with: it asks for no
    // answer, so every play comes back.
    for (const post of sent.slice(1)) expect(post.query).equals('')
    for (const post of sent.slice(1)) {
      const body = JSON.stringify(post.body)
      expect(body).not.includes(String(local!.gumboId))
      expect(body).not.includes('"fullName"')
      expect(post.body).not.have.property('names')
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

  it('puts the offline line at the top over a field moved under it, says nothing of a tap, and Saving… only while the queue goes out', async function () {
    const { client, net, rows } = await preparedPhone()
    net.offline = true
    await open(client)
    expect(status()).equals(OFFLINE_BANNER)
    // At the top, one line, in the web's place above the board: nothing
    // moves for it there (a phone makes a band, `scoringStatusPlacement`).
    const line = document.querySelector<HTMLElement>(
      '[aria-label="Save status"]'
    )!
    const frame = line.parentElement!.parentElement!
    expect(frame.style.top).equals('8px')
    expect(frame.style.height).equals('28px')
    const moved = (): boolean =>
      [...document.querySelectorAll<HTMLElement>('div')].some(node =>
        node.style.transform.includes('translateY(28px)')
      )
    expect(moved()).equals(false)
    await click('Ball')
    await settle(50)
    await click('Ball')
    await settle(50)
    expect(status()).equals(OFFLINE_BANNER)
    expect(document.body.textContent).not.includes('Saving…')
    expect(rows().filter(row => row.chain === 'game:g1').length).greaterThan(0)

    // Another game's write the server refused, held on this phone.
    executors
      .at(-1)!
      .db.prepare(
        `INSERT INTO outbox (id, idempotency_key, seq, chain, method, path, body, depends_on, state, attempts, lease_until, game_id, message)
         VALUES ('other', 'other-key', 0, 'game:g2', 'POST', '/games/g2/events', '{}', '[]', 'dead', 1, NULL, 'g2', 'Refused')`
      )
      .run()

    // Back online, with this game's plays answered only when let go.
    let release: () => void = () => undefined
    net.holdPlays = new Promise<void>(resolve => {
      release = resolve
    })
    net.offline = false
    // Any request that reaches the server again says so, as the phone's own
    // reads do the moment it has signal.
    client.offline = false
    client.wakeOutbox(true)
    const draining = client.drainOutbox()
    await settle(50)
    expect(status()).equals('Saving…')
    // Saving… sits where a save's line always sat, out of the band.
    expect(
      document.querySelector<HTMLElement>('[aria-label="Save status"]')!
        .parentElement!.parentElement!.style.height
    ).equals('')
    release()
    await act(async () => {
      await draining
      await client.drainOutbox()
    })
    await settle(50)
    expect(rows().filter(row => row.chain === 'game:g1')).deep.equals([])
    // g2's refused write is still on the phone; it keeps nothing busy here.
    expect(rows().some(row => row.chain === 'game:g2')).equals(true)
    expect(hasLabel('Save status')).equals(false)
    expect(moved()).equals(false)
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
    // A pitch is in: no removal, so he moves his leadoff man down a place.
    expect(document.querySelector('[aria-label^="Remove "]')).equals(null)
    const leadoff = document.querySelector<HTMLElement>(
      '[aria-label^="Reorder "]'
    )!
    for (const key of ['Enter', 'ArrowDown', 'Enter'])
      await act(async () => {
        leadoff.dispatchEvent(
          new window.KeyboardEvent('keydown', { key, bubbles: true })
        )
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

  for (const network of ['held', 'offline'] as const)
    it(`shows lineup, defense and roster changes at once with the server ${network === 'held' ? 'holding every request' : 'out of reach'} (U38)`, async function () {
      const { client, net, rows } = await preparedPhone()
      await open(client)
      expect(document.body.textContent).includes('1 balls')
      // From here nothing the server is asked comes back.
      let release!: () => void
      if (network === 'held')
        net.hold = new Promise<void>(resolve => {
          release = resolve
        })
      else net.offline = true
      const before = net.posts.length
      await click('Open scoring menu')
      await click('Set Team Rosters')
      // The editor, at once: no spinner while the game is read behind it.
      expect(hasLabel('Refreshing game')).equals(false)
      expect(hasLabel('Save Rosters')).equals(true)
      // A roster change: a player made on the phone, listed at once.
      await click('Create Player')
      await input('First Name', 'Mookie')
      await input('Last Name', 'Betts')
      await click('Create Player')
      await settle()
      // A lineup change: he bats at the end, saved and shown at once.
      await click('Add Mookie B to Lineup')
      await click('Save Rosters')
      await settle()
      expect(hasLabel('Save Rosters')).equals(false)
      await click('Open scoring menu')
      await click('Set Team Rosters')
      expect(hasLabel('Refreshing game')).equals(false)
      expect(hasLabel('Add Mookie B to Lineup')).equals(false)
      expect(document.body.textContent).includes('Mookie B')
      // A defense change: the whole defense cleared, and the field waits
      // for a pitcher at once.
      await click('Home Team')
      await click('Defense')
      await click('Clear Defense')
      await click('Save Rosters')
      await settle()
      expect(
        document.body.textContent,
        document.body.textContent ?? ''
      ).includes('Assign a pitcher')
      expect(net.posts.length, 'nothing has landed').equals(before)
      expect(rows().length).greaterThan(0)
      if (network === 'held') {
        release()
        net.hold = undefined
      } else net.offline = false
      client.wakeOutbox(true)
      await act(async () => {
        await client.drainOutbox()
      })
      await settle(50)
      expect(rows()).deep.equals([])
      expect(net.posts.slice(before).map(post => post.path)[0]).equals(
        '/teams/away/roster-players'
      )
    })

  it('shows a coach’s lineup save at once while the server holds it (U40)', async function () {
    const { client, net, rows, document: stored } = await preparedPhone()
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
    let release!: () => void
    net.hold = new Promise<void>(resolve => {
      release = resolve
    })
    await click('Lineup')
    const leadoff = document.querySelector<HTMLElement>(
      '[aria-label^="Reorder "]'
    )!
    const moved = leadoff.getAttribute('aria-label')
    for (const key of ['Enter', 'ArrowDown', 'Enter'])
      await act(async () => {
        leadoff.dispatchEvent(
          new window.KeyboardEvent('keydown', { key, bubbles: true })
        )
      })
    await settle()
    await click('Save Rosters')
    await settle(50)
    // Saved on screen: the editor clean over the new order, the save queued.
    expect(
      document
        .querySelector('[aria-label="Save Rosters"]')
        ?.getAttribute('aria-disabled')
    ).equals('true')
    expect(
      document
        .querySelectorAll('[aria-label^="Reorder "]')
        .item(1)
        .getAttribute('aria-label')
    ).equals(moved)
    expect(rows().map(row => row.path)).deep.equals(['/games/g1/lineups'])
    expect(stored(lineupsKey('g1'))!.pending).equals(1)
    const body = JSON.parse(String(rows()[0].body)) as { changedAt?: string }
    expect(Number.isNaN(Date.parse(body.changedAt ?? ''))).equals(false)
    release()
    net.hold = undefined
    client.wakeOutbox(true)
    await act(async () => {
      await client.drainOutbox()
    })
    await settle(50)
    expect(rows()).deep.equals([])
  })
  it('says on Coach Game when another device changed the lineup later, and shows theirs (newer)', async function () {
    const { client, net, rows } = await preparedPhone()
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
    net.offline = true
    await click('Lineup')
    const leadoff = document.querySelector<HTMLElement>(
      '[aria-label^="Reorder "]'
    )!
    for (const key of ['Enter', 'ArrowDown', 'Enter'])
      await act(async () => {
        leadoff.dispatchEvent(
          new window.KeyboardEvent('keydown', { key, bubbles: true })
        )
      })
    await settle()
    await click('Save Rosters')
    await settle(50)
    expect(document.body.textContent).not.includes(NEWER_LINEUP_MESSAGE)
    net.offline = false
    net.newer = true
    client.wakeOutbox(true)
    await act(async () => {
      await client.drainOutbox()
    })
    await settle(100)
    expect(rows()).deep.equals([])
    expect(document.body.textContent).includes(NEWER_LINEUP_MESSAGE)
  })

  it('says on the scoring screen when another device changed a lineup queued here later (newer)', async function () {
    const { client, net } = await preparedPhone()
    await open(client)
    net.offline = true
    await client.saveLineups(
      'g1',
      {
        side: 'home',
        base: 'lineups-1',
        players: [{ gumboId: 10, fullName: 'Player 10', jersey: '10' }],
        battingOrder: [0],
        defense: { P: 0 },
        changedAt: '2026-10-22T18:00:00.000Z'
      },
      { background: true }
    )
    net.offline = false
    net.newer = true
    client.wakeOutbox(true)
    await act(async () => {
      await client.drainOutbox()
    })
    await settle(50)
    expect(document.body.textContent).includes(NEWER_LINEUP_MESSAGE)
  })
  it('opens the game again on the scoring screen when writes naming a player the server did not take were dropped', async function () {
    const { client } = await preparedPhone()
    let tell: ((notice: OutboxNotice) => void) | undefined
    client.subscribeOutboxNotices = listener => {
      tell = listener
      return () => undefined
    }
    let reads = 0
    const events = client.gameEvents.bind(client)
    client.gameEvents = async (...args) => {
      reads++
      return await events(...args)
    }
    await open(client)
    const before = reads
    await act(async () => {
      tell!({
        teamId: 'home',
        message: PENDING_APPROVAL_MESSAGE,
        reread: true
      })
    })
    await settle(100)
    expect(document.body.textContent).includes(PENDING_APPROVAL_MESSAGE)
    expect(reads, 'the game is read again').greaterThan(before)
  })

  describe('with every request held (#237)', function () {
    /** Holds every request the phone makes until `release`. */
    function holdAll(net: ReturnType<typeof fieldServer>): () => void {
      let release: () => void = () => undefined
      net.hold = new Promise<void>(resolve => {
        release = resolve
      })
      return () => {
        net.hold = undefined
        release()
      }
    }
    const text = (): string => document.body.textContent ?? ''
    const disabled = (label: string): boolean => {
      const nodes = document.querySelectorAll(`[aria-label="${label}"]`)
      return (
        nodes.item(nodes.length - 1)?.getAttribute('aria-disabled') === 'true'
      )
    }
    const homeOf = (): string | undefined =>
      /Owls \d+ · Hawks \d+|Hawks \d+ · Owls \d+/.exec(text())?.[0]

    it('opens on what the phone stored, and takes pitches, undo, an override, the end of a half and a lineup change at once, each after the last', async function () {
      const { client, net, rows } = await preparedPhone()
      const release = holdAll(net)
      const before = net.writes.length
      await open(client)
      // Every read the open waits on is held: it opened from the phone.
      expect(text()).includes('Owls 0 · Hawks 0')
      expect(text()).includes('1 balls')
      await click('Ball')
      expect(text()).includes('2 balls')
      await click('Called Strike')
      expect(text()).includes('1 strikes')
      const undo = document
        .querySelector('[aria-label^="Undo "]')
        ?.getAttribute('aria-label')
      expect(undo).to.be.a('string')
      await click(undo!)
      expect(text()).not.includes('1 strikes')
      await click('Open scoring menu')
      await click('Overrides')
      await click('Apply Override')
      expect(hasLabel('Apply Override')).equals(false)
      await click('Open scoring menu')
      await click('End Half Inning')
      await click('Confirm End Half Inning')
      expect(hasLabel('Confirm End Half Inning')).equals(false)
      await click('Open scoring menu')
      await click('Set Team Rosters')
      expect(disabled('Create Player')).equals(false)
      await click('Create Player')
      await input('First Name', 'Mookie')
      await input('Last Name', 'Betts')
      await click('Create Player')
      await settle()
      await click('Add Mookie B to Lineup')
      await click('Save Rosters')
      await settle()
      expect(hasLabel('Save Rosters')).equals(false)
      await click('Ball')
      await settle(50)
      expect(text()).includes('1 balls')
      // Nothing reached the server; all of it is queued, in order.
      expect(net.writes.length).equals(before)
      const queued = rows()
      expect(queued.length).greaterThan(3)
      release()
      client.wakeOutbox(true)
      await act(async () => {
        await client.drainOutbox()
      })
      await settle(50)
      expect(rows()).deep.equals([])
      expect(net.writes.slice(before)).deep.equals(
        queued.map(row => `${String(row.method)} ${String(row.path)}`)
      )
    })

    it('closes Confirm Swap at once, shows the exchanged sides and takes the next pitch, and sends the pitches and the swap in order once let go', async function () {
      const { client, net, rows } = await preparedPhone()
      const release = holdAll(net)
      const before = net.writes.length
      await open(client)
      expect(homeOf()).equals('Owls 0 · Hawks 0')
      await click('Open scoring menu')
      await click('Swap Home and Away')
      await settle()
      // A pitch is in: the swap resets the game.
      expect(disabled('Reset and Swap')).equals(false)
      await click('Reset and Swap')
      expect(hasLabel('Reset and Swap')).equals(false)
      await settle(100)
      expect(homeOf()).equals('Hawks 0 · Owls 0')
      expect(text()).includes(
        'Home and away were swapped and the game was reset.'
      )
      expect(text()).includes('0 balls')
      await click('Ball')
      await settle(50)
      expect(text()).includes('1 balls')
      // Then a second swap, before the first pitch on the new sides counts.
      await click('Open scoring menu')
      await click('Swap Home and Away')
      await settle()
      const label = hasLabel('Confirm Swap') ? 'Confirm Swap' : 'Reset and Swap'
      await click(label)
      expect(hasLabel(label)).equals(false)
      await settle(100)
      expect(homeOf()).equals('Owls 0 · Hawks 0')
      await click('Ball')
      await settle(50)
      expect(net.writes.length).equals(before)
      const queued = rows().map(row => String(row.path))
      expect(queued.filter(path => path.endsWith('/swap-sides'))).length(2)
      release()
      client.wakeOutbox(true)
      await act(async () => {
        await client.drainOutbox()
      })
      await settle(100)
      expect(rows()).deep.equals([])
      // In the order they were entered, each swap behind the plays before it.
      expect(net.writes.slice(before)).deep.equals(
        queued.map(path => `POST ${path}`)
      )
      expect(
        await (await net.fetch('http://x/api/v1/games/g1')).json()
      ).deep.include({ homeTeamId: 'home' })
    })

    /** `client.game` answered only after `ms`, as a phone's slow open would. */
    function slowGame(client: CachingClient, ms: number): void {
      const original = client.game.bind(client)
      ;(client as unknown as { game: typeof client.game }).game = async (
        ...args: Parameters<typeof client.game>
      ) => {
        await new Promise(resolve => setTimeout(resolve, ms))
        return await original(...args)
      }
    }
    /**
     * What the screen shows after each change to the page, however briefly:
     * whether the swap sheet is up, the score line, the balls, and whether
     * it says Loading game.
     */
    function watchDraws(): {
      draws: Array<{
        sheet: boolean
        home?: string
        balls?: string
        loading: boolean
      }>
      stop: () => void
    } {
      const draws: ReturnType<typeof watchDraws>['draws'] = []
      const take = (): void => {
        draws.push({
          sheet: hasLabel('Reset and Swap'),
          home: homeOf(),
          balls: /\d+ balls/.exec(text())?.[0],
          loading: hasLabel('Loading game')
        })
      }
      const observer = new MutationObserver(take)
      observer.observe(document.body, {
        childList: true,
        subtree: true,
        characterData: true,
        attributes: true
      })
      return {
        draws,
        stop: () => {
          if (observer.takeRecords().length > 0) take()
          observer.disconnect()
        }
      }
    }
    /** The plays and writes the server holds once the phone has sent all. */
    async function drained(
      client: CachingClient,
      net: ReturnType<typeof fieldServer>,
      release: () => void
    ): Promise<{ plays: number; writes: string[] }> {
      release()
      client.wakeOutbox(true)
      await act(async () => {
        await client.drainOutbox()
      })
      await settle(50)
      const events = (await (
        await net.fetch('http://x/api/v1/games/g1/events')
      ).json()) as { plays: unknown[]; currentPlay: unknown }
      return {
        plays: events.plays.length + (events.currentPlay == null ? 0 : 1),
        writes: net.writes
      }
    }

    it('draws the swapped game in the same draw that takes the sheet away, with every request held and the game read slow: never Loading game, never an empty stage', async function () {
      const { client, net } = await preparedPhone()
      holdAll(net)
      const before = net.writes.length
      await open(client)
      expect(homeOf()).equals('Owls 0 · Hawks 0')
      await click('Open scoring menu')
      await click('Swap Home and Away')
      await settle()
      // A read of the game would hold the reopen for most of a second.
      slowGame(client, 800)
      const watched = watchDraws()
      try {
        await click('Reset and Swap')
        await settle(100)
      } finally {
        watched.stop()
      }
      const gone = watched.draws.findIndex(draw => !draw.sheet)
      expect(gone, 'the sheet went').not.equals(-1)
      // The first draw without the sheet is the swapped game, and every
      // draw from the tap on has a scoreboard and no loading view.
      expect(watched.draws[gone].home).equals('Hawks 0 · Owls 0')
      expect(watched.draws.filter(draw => draw.loading)).deep.equals([])
      expect(watched.draws.filter(draw => draw.home == null)).deep.equals([])
      expect(watched.draws.slice(gone).map(draw => draw.home)).deep.equals(
        watched.draws.slice(gone).map(() => 'Hawks 0 · Owls 0')
      )
      // Well before the slow read could have answered.
      expect(homeOf()).equals('Hawks 0 · Owls 0')
      await click('Ball')
      await settle(50)
      expect(text()).includes('1 balls')
      // Not one request answered: the swap and the reopen are the phone's.
      expect(net.writes.length).equals(before)
    })

    it('keeps the field and its scoreboard mounted through Confirm Swap, and draws the exchanged sides on that same field', async function () {
      const { client, net } = await preparedPhone()
      holdAll(net)
      await open(client)
      const host = document.body.firstElementChild as HTMLElement
      // The field as the screen opened it: with no WebGL here, the canvas's
      // own stand-in, which a field drawn again would replace.
      const fieldNode = (): Element | undefined =>
        [...document.querySelectorAll('div')].find(
          node =>
            node.childElementCount === 0 &&
            node.textContent === 'This browser cannot start 3D'
        )
      const before = fieldNode()
      expect(before, 'the field').not.equals(undefined)
      const teams = (): { away: string; home: string } => {
        const { teams } = panelProps(host, 'FieldCanvas') as {
          teams: { away: { name: string }; home: { name: string } }
        }
        return { away: teams.away.name, home: teams.home.name }
      }
      expect(teams()).deep.equals({ away: 'Owls', home: 'Hawks' })
      await click('Open scoring menu')
      await click('Swap Home and Away')
      await settle()
      await click('Reset and Swap')
      await settle(100)
      expect(homeOf()).equals('Hawks 0 · Owls 0')
      // The same field, not one made again, and its scoreboard's teams are
      // the exchanged ones.
      expect(before!.isConnected, 'the field stayed').equals(true)
      expect(fieldNode()).equals(before)
      expect(teams()).deep.equals({ away: 'Hawks', home: 'Owls' })
      await click('Ball')
      await settle(50)
      expect(text()).includes('1 balls')
      expect(fieldNode()).equals(before)
    })

    it('leaves scoring for the event screen, painted at once from the phone, with every request held', async function () {
      const { client, net } = await preparedPhone()
      holdAll(net)
      const source = new ServerScoringSource(
        client,
        new ServerClock(async () => await client.serverTime(), memoryStorage())
      )
      function Phone(): React.ReactElement {
        const [scoring, setScoring] = React.useState(true)
        return scoring ? (
          <ScoringScreen
            client={client}
            gameId="g1"
            userId="usr_scorer"
            source={source}
            onExit={() => {
              setScoring(false)
            }}
          />
        ) : (
          <GameScreen
            client={client}
            gameId="g1"
            onScoreGame={() => undefined}
          />
        )
      }
      const host = document.createElement('div')
      document.body.appendChild(host)
      root = createRoot(host)
      await act(async () => {
        root!.render(
          <ThemeProvider>
            <GestureHandlerRootView>
              <Phone />
            </GestureHandlerRootView>
          </ThemeProvider>
        )
      })
      await settle(50)
      expect(homeOf()).equals('Owls 0 · Hawks 0')
      await click('Open scoring menu')
      await click('Exit Current Game')
      await settle(50)
      // The event screen, its game the phone's: no read has answered.
      expect(
        document.querySelector('[role="button"][aria-label="Score"]'),
        'the event screen, with its Score'
      ).not.equals(null)
      expect(text()).includes('Owls')
      expect(text()).includes('Hawks')
    })

    it('refuses a pitch tapped in the same tick as Confirm Swap: never shown, so never lost', async function () {
      const { client, net, rows } = await preparedPhone()
      const release = holdAll(net)
      await open(client)
      expect(text()).includes('1 balls')
      await click('Open scoring menu')
      await click('Swap Home and Away')
      await settle()
      const swap = [
        ...document.querySelectorAll<HTMLElement>(
          '[aria-label="Reset and Swap"]'
        )
      ].at(-1)!
      const watched = watchDraws()
      try {
        await act(async () => {
          swap.click()
          // The old scorer is still on the page: its Ball takes nothing.
          ;[...document.querySelectorAll<HTMLElement>('[aria-label="Ball"]')]
            .at(-1)!
            .click()
        })
        await settle(100)
      } finally {
        watched.stop()
      }
      expect(watched.draws.some(draw => draw.balls === '2 balls')).equals(false)
      expect(homeOf()).equals('Hawks 0 · Owls 0')
      expect(text()).not.includes('1 balls')
      expect(
        rows().map(row => `${String(row.method)} ${String(row.path)}`)
      ).deep.equals(['POST /games/g1/swap-sides'])
      const server = await drained(client, net, release)
      expect(server).deep.equals({
        plays: 0,
        writes: ['POST /games/g1/swap-sides']
      })
    })

    it('queues a pitch tapped just before Confirm Swap, its save not yet made, ahead of the swap, and the server takes both in that order', async function () {
      const { client, net, rows } = await preparedPhone()
      const release = holdAll(net)
      await open(client)
      // The pitch, then straight to the swap: no time for its save to go.
      await click('Ball')
      expect(text()).includes('2 balls')
      await click('Open scoring menu')
      await click('Swap Home and Away')
      await click('Reset and Swap')
      await settle(100)
      expect(homeOf()).equals('Hawks 0 · Owls 0')
      expect(
        rows().map(row => `${String(row.method)} ${String(row.path)}`)
      ).deep.equals(['POST /games/g1/events', 'POST /games/g1/swap-sides'])
      // The reset the scorer confirmed takes the pitch with the rest.
      const server = await drained(client, net, release)
      expect(server).deep.equals({
        plays: 0,
        writes: ['POST /games/g1/events', 'POST /games/g1/swap-sides']
      })
    })

    it('takes a pitch tapped as the swapped game opens on the swapped game, and sends it behind the swap', async function () {
      const { client, net, rows } = await preparedPhone()
      const release = holdAll(net)
      await open(client)
      await click('Open scoring menu')
      await click('Swap Home and Away')
      await settle()
      slowGame(client, 800)
      await click('Reset and Swap')
      await settle(20)
      // No wait on the slow read: the swapped game is the one tapped.
      expect(homeOf()).equals('Hawks 0 · Owls 0')
      await click('Ball')
      await settle(50)
      expect(text()).includes('1 balls')
      await settle(1000)
      expect(homeOf()).equals('Hawks 0 · Owls 0')
      expect(text()).includes('1 balls')
      expect(
        rows().map(row => `${String(row.method)} ${String(row.path)}`)
      ).deep.equals(['POST /games/g1/swap-sides', 'POST /games/g1/events'])
      const server = await drained(client, net, release)
      expect(server).deep.equals({
        plays: 1,
        writes: ['POST /games/g1/swap-sides', 'POST /games/g1/events']
      })
    })

    it('saves an event tag with the editor closing at once, and shows the held-game notice when the server refuses it', async function () {
      const { client, net, rows } = await preparedPhone()
      const release = holdAll(net)
      await open(client)
      await click('Ball')
      await settle(50)
      const undo = document.querySelector<HTMLElement>(
        '[aria-label="Undo Ball"]'
      )!
      await act(async () => {
        undo.dispatchEvent(
          new window.MouseEvent('mousedown', { bubbles: true, button: 0 })
        )
        await new Promise(resolve => setTimeout(resolve, 1700))
      })
      await act(async () => {
        document.dispatchEvent(
          new window.MouseEvent('mouseup', { bubbles: true, button: 0 })
        )
      })
      await click('Tag event: Ball')
      // The stored choices, read before, show with their read held.
      await input('New tag', 'nice eye')
      await click('Save tag')
      expect(hasLabel('New tag')).equals(false)
      await settle(50)
      expect(rows().map(row => String(row.method))).includes('PUT')
      expect(net.writes).deep.equals([])
      // Let go, the server refuses the tag: the game is held, and says so.
      net.refuseTags = true
      release()
      client.wakeOutbox(true)
      await act(async () => {
        await client.drainOutbox()
      })
      await settle(50)
      expect(rows().map(row => [row.method, row.state])).deep.equals([
        ['PUT', 'dead']
      ])
      expect(
        document.querySelector('[data-testid="heldGameMessage"]')?.textContent
      ).equals('Not sent: No such event.')
    })

    it('keeps every control on through the defensive Refresh and a dictated substitution, and leaves without waiting', async function () {
      const { client, net } = await preparedPhone()
      const release = holdAll(net)
      let exits = 0
      const source = new ServerScoringSource(
        client,
        new ServerClock(async () => await client.serverTime(), memoryStorage())
      )
      let leave: (() => Promise<boolean>) | undefined
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
              onExit={() => {
                exits++
              }}
              onBeforeLeave={check => {
                leave = check
                return () => undefined
              }}
            />
          </ThemeProvider>
        )
      })
      await settle(50)
      // The defense sheet over a fielder, whose Refresh reads the game with
      // the read held: once it is closed, the field takes the next pitch.
      const field = (): {
        tapIds?: string[]
        onPlayerTap?: (id: string) => void
      } => (panelProps(host, 'BaseballScreen') as { field: never }).field
      const tapped = field().tapIds?.[0]
      expect(tapped, 'a fielder to tap').to.be.a('string')
      await act(async () => {
        field().onPlayerTap?.(tapped!)
      })
      await settle()
      await click('Create Player')
      await click('Cancel')
      await settle()
      // The Refresh's read is still out.
      expect(hasLabel('Defensive roster')).equals(true)
      await click('Cancel')
      await settle()
      expect(hasLabel('Defensive roster')).equals(false)
      expect(disabled('Ball')).equals(false)
      await click('Ball')
      expect(text()).includes('2 balls')
      // A substitution said aloud opens the rosters at once, over the game
      // as the phone holds it, with the read behind it held.
      await act(async () => {
        dictateTo(
          host,
          'Number 2 pitches',
          [],
          [
            {
              type: 'setPositions',
              places: [{ player: { jersey: '2' }, position: 'P' }]
            }
          ]
        )
      })
      await settle(50)
      expect(hasLabel('Save Rosters')).equals(true)
      expect(disabled('Save Rosters')).equals(false)
      await click('Cancel')
      await settle()

      expect(disabled('Ball')).equals(false)
      let left: boolean | undefined
      await act(async () => {
        left = await leave!()
      })
      expect(left).equals(true)
      expect(exits).equals(0)
      release()
    })
  })
})
