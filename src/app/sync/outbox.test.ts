import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { DatabaseSync } from 'node:sqlite'

import { expect } from 'chai'

import type { SaveLineupsBody } from '../../common/api'
import type { CreateGroup } from '../../common/groupCreation'
import type { GumboPlay } from '../../common/gumboPlay'
import type { NewRosterPlayer } from '../../common/playerSettings'
import { type SaveChange, ScoringSession } from '../../common/scoring/session'
import { copyState, setupOf } from '../../common/scoring/state'
import { userIdOfGumbo } from '../../common/userId'
import { nodeSqliteExecutor } from '../../test/nodeSqliteExecutor'
import { scoringSession } from '../../test/scoringSession'
import { guestRenames, sendGuestRenames } from '../scoring/guestRenames'
import { gameFixture } from '../scoring/isUnscoredGame.test'
import {
  draftOfLocalPlayer,
  editLocalPlayerDraft
} from '../scoring/playerDraft'
import { memoryStore } from '../scoring/scoringSource'
import {
  cacheFileName,
  type DocumentStore,
  openCacheStore,
  type SqlExecutor
} from './cacheStore'
import { CachingClient, OFFLINE_CREATE_MESSAGE } from './cachingClient'
import { eventsKey, fullRosterKey, lineupsKey, rosterKey } from './documentKeys'
import {
  appliedEvents,
  appliedLineups,
  namedLocalIds,
  withServerIds
} from './optimistic'
import {
  BACKOFF_MS,
  chainOf,
  JITTER,
  LOST_PLAYER_MESSAGE,
  type OutboxSummary,
  queuedCallOf
} from './outbox'
import { heldGameText, PARKED_GAME_MESSAGE } from './useOffline'

const play = (atBatIndex: number, batter = 7): GumboPlay =>
  ({
    about: { atBatIndex, inning: 1, halfInning: 'top', isScoringPlay: false },
    count: { outs: 1 },
    matchup: { batter: { id: batter } },
    result: {
      eventType: 'single',
      awayScore: 0,
      homeScore: 0,
      description: 'Single'
    },
    playEvents: [{ isPitch: true }]
  }) as unknown as GumboPlay

const side = (teamId: string): Record<string, unknown> => ({
  teamId,
  teamName: teamId,
  start: null,
  changes: [],
  current: null
})

const lineupsDoc = (digest: string): unknown => ({
  away: side('tem_away'),
  home: side('tem_home'),
  digest
})

const eventsDoc = (
  gameId: string,
  digest: string,
  plays: GumboPlay[] = [play(0)]
): unknown => ({
  plays: plays.map((gumbo, index) => ({ id: `evt_${index}`, gameId, gumbo })),
  currentPlay: null,
  playsDigest: `plays-${digest}`,
  lineupsDigest: digest
})

const lineupSave = (
  base: string,
  gumboIds: number[] = [7]
): SaveLineupsBody => ({
  side: 'home',
  base,
  players: gumboIds.map((gumboId, index) => ({
    gumboId,
    fullName: `Player ${index}`,
    jersey: String(index)
  })),
  battingOrder: gumboIds.map((_, index) => index),
  defense: { P: 0 }
})

const newPlayer = (firstName: string): NewRosterPlayer => ({
  firstName,
  lastName: 'Betts',
  jersey: '50',
  positions: ['RF'],
  bats: 'right',
  throws: 'right'
})

/** The entry the server makes for a new player. */
const serverEntry = (gumboId: number, firstName: string): unknown => ({
  userId: userIdOfGumbo(gumboId),
  gumboId,
  nameDetails: { firstName, lastName: 'Betts', displayName: firstName },
  shortName: `${firstName} B`,
  jersey: '50',
  positions: ['RF'],
  isPlayer: true,
  role: 'member',
  section: 'player',
  staffRoles: [],
  inheritedFrom: null
})

interface Sent {
  method: string
  path: string
  body: unknown
  key: string | undefined
}

type Answer = 'offline' | { status?: number; body: unknown; revision?: string }

type Handler = (sent: Sent) => Answer | Promise<Answer>

const refusal = (
  status: number,
  code: string,
  message: string,
  details?: unknown
): Answer => ({
  status,
  body: { code, message, ...(details === undefined ? {} : { details }) }
})

describe('the phone outbox', function () {
  let dir: string
  let executors: Array<SqlExecutor & { db: DatabaseSync }>

  beforeEach(function () {
    dir = mkdtempSync(join(tmpdir(), 'teamstation-outbox-'))
    executors = []
  })
  afterEach(function () {
    rmSync(dir, { recursive: true, force: true })
  })

  /** A phone on `handler`'s server, with its clock and timers in the test's hand. */
  function phone(handler: Handler): {
    client: CachingClient
    sent: Sent[]
    posts: () => Sent[]
    timers: Array<{ run: () => void; ms: number }>
    clock: { now: number }
    rows: () => Array<Record<string, unknown>>
    document: (key: string) => Record<string, unknown> | undefined
    summaries: OutboxSummary[]
  } {
    const sent: Sent[] = []
    const timers: Array<{ run: () => void; ms: number }> = []
    const clock = { now: 1_000_000 }
    const fetch = (async (url: unknown, init: RequestInit) => {
      const headers = init.headers as Record<string, string>
      const call: Sent = {
        method: String(init.method),
        path: String(url).replace('http://x/api/v1', ''),
        body: typeof init.body === 'string' ? JSON.parse(init.body) : undefined,
        key: headers['idempotency-key']
      }
      sent.push(call)
      const answer = await handler(call)
      if (answer === 'offline') throw new TypeError('Load failed')
      return new Response(JSON.stringify(answer.body), {
        status: answer.status ?? 200,
        headers:
          answer.revision == null
            ? {}
            : { 'x-teamstation-revision': answer.revision }
      })
    }) as unknown as typeof globalThis.fetch
    const openCache = async (userId: string): Promise<DocumentStore> => {
      const executor = nodeSqliteExecutor(join(dir, cacheFileName(userId)))
      executors.push(executor)
      return await openCacheStore(executor)
    }
    const client = new CachingClient({
      baseUrl: 'http://x/api/v1',
      token: 'token-1',
      fetch,
      openCache,
      outbox: {
        now: () => clock.now,
        random: () => 0.5,
        setTimer: (run, ms) => {
          timers.push({ run, ms })
          return timers.length
        },
        clearTimer: () => undefined
      }
    })
    client.openFor('usr_1')
    const summaries: OutboxSummary[] = []
    client.subscribeOutbox(summary => summaries.push(summary))
    const db = (): DatabaseSync => executors[executors.length - 1].db
    return {
      client,
      sent,
      posts: () => sent.filter(call => call.method === 'POST'),
      timers,
      clock,
      rows: () => db().prepare('SELECT * FROM outbox ORDER BY seq').all(),
      document: key =>
        db().prepare('SELECT * FROM documents WHERE key = ?').get(key),
      summaries
    }
  }

  /** A server whose GETs answer `reads` and whose POSTs `post` answers. */
  const server =
    (reads: Record<string, unknown>, post: Handler): Handler =>
    async sent =>
      sent.method === 'GET'
        ? sent.path in reads
          ? { body: reads[sent.path], revision: '5' }
          : refusal(404, 'notFound', 'Not found')
        : await post(sent)

  const bodyOf = (row: Record<string, unknown>): Record<string, unknown> =>
    JSON.parse(String(row.body))

  it('reads which calls it queues, and on which chain', function () {
    expect(queuedCallOf('POST', '/teams/t%201/roster-players', {})).deep.equals(
      {
        kind: 'roster',
        teamId: 't 1',
        path: '/teams/t%201/roster-players',
        body: {}
      }
    )
    const live = { mode: 'live' }
    expect(chainOf(queuedCallOf('POST', '/games/g1/events', live)!)).equals(
      'game:g1'
    )
    expect(chainOf(queuedCallOf('POST', '/games/g1/lineups', {})!)).equals(
      'game:g1'
    )
    expect(
      chainOf(queuedCallOf('POST', '/teams/t1/roster-players', {})!)
    ).equals('team:t1')
    // A replace post, another path, another method, a bad id: not queued.
    expect(
      queuedCallOf('POST', '/games/g1/events', { mode: 'replace' })
    ).equals(undefined)
    expect(queuedCallOf('POST', '/games/g1/tags', {})).equals(undefined)
    expect(queuedCallOf('GET', '/games/g1/lineups', {})).equals(undefined)
    expect(queuedCallOf('POST', '/games/%E0/lineups', {})).equals(undefined)
  })

  it('answers a queued live post with the plays it adds, built on the stored game (Optimistic events)', async function () {
    const p = phone(
      server(
        {
          '/games/g1/events': eventsDoc('g1', 'D0'),
          '/games/g1/lineups': lineupsDoc('D0')
        },
        () => 'offline'
      )
    )
    await p.client.gameEvents('g1')
    await p.client.gameLineups('g1')
    const stored = await p.client.saveGameEvents('g1', {
      plays: [play(1)],
      remove: [],
      currentPlay: null,
      lineupsBase: 'D0'
    })
    expect(stored.plays.map(row => row.about.atBatIndex)).deep.equals([0, 1])
    expect(stored.priorPlaysDigest).equals('plays-D0')
    expect(stored.playsDigest).match(/^local-/)
    expect(stored.lineupsDigest).equals('D0')
    const document = p.document(eventsKey('g1'))!
    expect(document.pending).equals(1)
    expect(document.server_digest).equals('D0')
    expect(JSON.parse(String(document.body)).plays).length(2)
    const [row] = p.rows()
    expect(row).deep.include({
      chain: 'game:g1',
      state: 'pending',
      game_id: 'g1',
      path: '/games/g1/events',
      depends_on: '[]'
    })
    expect(bodyOf(row)).deep.include({ mode: 'live', lineupsBase: 'D0' })
    // The phone's copy is what a read of the game answers while it waits.
    expect((await p.client.gameEvents('g1')).plays).length(2)
    const summary = await p.client.outboxSummary()
    expect(summary).deep.equals({
      count: 1,
      chains: { 'game:g1': 1 },
      games: {},
      teams: {}
    })
  })

  it('answers a queued lineup save with both sides, the saved one replaced (Optimistic lineups)', async function () {
    const p = phone(
      server({ '/games/g1/lineups': lineupsDoc('D0') }, () => 'offline')
    )
    await p.client.gameLineups('g1')
    const saved = await p.client.saveLineups('g1', lineupSave('D0', [7, 8]))
    expect(saved.away).deep.equals(side('tem_away'))
    expect(saved.home.teamId).equals('tem_home')
    expect(saved.home.current?.batters).deep.equals([
      { gumboId: 7, name: 'Player 0', jersey: '0' },
      { gumboId: 8, name: 'Player 1', jersey: '1' }
    ])
    expect(saved.home.current?.defense.P).deep.equals({
      gumboId: 7,
      name: 'Player 0',
      jersey: '0'
    })
    expect(saved.home.current?.defense.C).equals(null)
    expect(saved.digest).match(/^local-/)
    expect(p.document(lineupsKey('g1'))!.pending).equals(1)
    expect(p.rows()).length(1)
  })

  it('refuses to queue a game write whose documents the phone does not hold', async function () {
    const p = phone(server({}, () => 'offline'))
    let refused: unknown
    try {
      await p.client.saveLineups('g9', lineupSave('D0'))
    } catch (error) {
      refused = error
    }
    expect(refused).property('code').equals('offline')
    expect(p.rows()).deep.equals([])
  })

  it('sends the second live post on the lineups digest the first one answered (Digest rewrite)', async function () {
    let online = false
    const p = phone(
      server(
        {
          '/games/g1/events': eventsDoc('g1', 'D0'),
          '/games/g1/lineups': lineupsDoc('D0')
        },
        sent => {
          if (!online) return 'offline'
          const index = (sent.body as { plays: GumboPlay[] }).plays[0].about
            .atBatIndex
          return {
            body: eventsDoc(
              'g1',
              `D${index}`,
              Array.from({ length: index + 1 }, (_, at) => play(at))
            )
          }
        }
      )
    )
    await p.client.gameEvents('g1')
    await p.client.gameLineups('g1')
    const first = await p.client.saveGameEvents('g1', {
      plays: [play(1)],
      remove: [],
      lineupsBase: 'D0'
    })
    await p.client.saveGameEvents('g1', {
      plays: [play(2)],
      remove: [],
      lineupsBase: first.lineupsDigest
    })
    online = true
    p.client.wakeOutbox(true)
    await p.client.drainOutbox()
    const posts = p.posts().filter(call => call.key != null)
    const sentBases = posts.map(
      call => (call.body as { lineupsBase?: string }).lineupsBase
    )
    // The first's own base, then the digest the first's answer carried.
    expect(sentBases.slice(-2)).deep.equals(['D0', 'D1'])
    expect(p.rows()).deep.equals([])
    expect(p.document(eventsKey('g1'))).deep.include({
      pending: 0,
      server_digest: 'D2'
    })
    // Its other document carries the game's digest too.
    expect(p.document(lineupsKey('g1'))!.server_digest).equals('D2')
  })

  it('sends a phone-made base as the game’s last server digest, never as itself', async function () {
    let online = false
    const p = phone(
      server(
        {
          '/games/g1/events': eventsDoc('g1', 'D0'),
          '/games/g1/lineups': lineupsDoc('D0')
        },
        sent => {
          if (!online) return 'offline'
          return sent.path.endsWith('/lineups')
            ? { body: lineupsDoc('L1') }
            : { body: eventsDoc('g1', 'L1') }
        }
      )
    )
    await p.client.gameEvents('g1')
    await p.client.gameLineups('g1')
    const saved = await p.client.saveLineups('g1', lineupSave('D0'))
    expect(saved.digest).match(/^local-/)
    const posted = await p.client.saveGameEvents('g1', {
      plays: [play(1)],
      remove: [],
      lineupsBase: saved.digest
    })
    // Built on the phone's lineups: their digest is the phone's.
    expect(posted.lineupsDigest).equals(saved.digest)
    online = true
    p.client.wakeOutbox(true)
    await p.client.drainOutbox()
    const queued = p.posts().filter(call => call.key != null)
    expect(queued.map(call => call.path).slice(-2)).deep.equals([
      '/games/g1/lineups',
      '/games/g1/events'
    ])
    expect(
      (queued[queued.length - 1].body as { lineupsBase: string }).lineupsBase
    ).equals('L1')
    for (const call of queued)
      expect(JSON.stringify(call.body)).not.match(/local-/)

    // A screen that still holds the phone's digest after its row landed
    // sends the game's last one from the server.
    await p.client.saveGameEvents('g1', {
      plays: [play(2)],
      remove: [],
      lineupsBase: saved.digest
    })
    const last = p.posts()[p.posts().length - 1]
    expect((last.body as { lineupsBase: string }).lineupsBase).equals('L1')
    // With no digest from the server at all, a live post names none, and a
    // lineup save sends an empty base.
    const undigested = {
      ...(eventsDoc('g2', 'x') as object),
      lineupsDigest: null
    }
    const bare = phone(
      server(
        {
          '/games/g2/events': undigested,
          '/games/g2/lineups': {
            ...(lineupsDoc('x') as object),
            digest: undefined
          }
        },
        sent =>
          sent.path.endsWith('/lineups')
            ? { body: lineupsDoc('M1') }
            : { body: undigested }
      )
    )
    await bare.client.gameEvents('g2')
    await bare.client.gameLineups('g2')
    await bare.client.saveGameEvents('g2', {
      plays: [play(1)],
      remove: [],
      lineupsBase: 'local-abc'
    })
    await bare.client.saveLineups('g2', lineupSave('local-abc'))
    const [events, lineup] = bare.posts()
    expect(events.body).not.have.property('lineupsBase')
    expect((lineup.body as { base: string }).base).equals('')
  })

  it('sends a lineup naming two players made on the phone only after both, with their server ids (Local players)', async function () {
    let online = false
    let next = 900
    const made = new Map<string, number>()
    const p = phone(
      server(
        {
          '/games/g1/lineups': lineupsDoc('D0'),
          '/teams/tem_home/roster': [],
          '/teams/tem_home/roster?includeFullNames=true': []
        },
        sent => {
          if (!online) return 'offline'
          if (sent.path === '/teams/tem_home/roster-players') {
            const name = (sent.body as NewRosterPlayer).firstName
            const gumboId = made.get(name) ?? next++
            made.set(name, gumboId)
            return { status: 201, body: serverEntry(gumboId, name) }
          }
          return { body: lineupsDoc('D1') }
        }
      )
    )
    await p.client.gameLineups('g1')
    await p.client.roster('tem_home')
    await p.client.roster('tem_home', { includeFullNames: true })
    const one = await p.client.createRosterPlayer(
      'tem_home',
      newPlayer('Yadier')
    )
    const two = await p.client.createRosterPlayer(
      'tem_home',
      newPlayer('Xander')
    )
    expect(one.gumboId).not.equals(two.gumboId)
    expect(one.userId).equals(userIdOfGumbo(one.gumboId!))
    expect(one.nameDetails?.firstName).equals('Yadier')
    expect(one.shortName).equals('Yadier B')
    // On both rosters, the whole name only where a manager reads it.
    const plain = JSON.parse(String(p.document(rosterKey('tem_home'))!.body))
    expect(
      plain.map((entry: { gumboId: number }) => entry.gumboId)
    ).deep.equals([one.gumboId, two.gumboId])
    expect(plain[0]).not.have.property('nameDetails')
    const full = JSON.parse(String(p.document(fullRosterKey('tem_home'))!.body))
    expect(full[1].nameDetails.firstName).equals('Xander')
    expect(p.document(rosterKey('tem_home'))!.pending).equals(1)
    // The roster read while queued is the phone's.
    expect(await p.client.roster('tem_home')).length(2)

    await p.client.saveLineups(
      'g1',
      lineupSave('D0', [one.gumboId!, two.gumboId!])
    )
    const rows = p.rows()
    expect(rows.map(row => row.chain)).deep.equals([
      'team:tem_home',
      'team:tem_home',
      'game:g1'
    ])
    expect(JSON.parse(String(rows[2].depends_on))).deep.equals([
      `player-${one.gumboId}`,
      `player-${two.gumboId}`
    ])
    // The create's body names nobody.
    expect(bodyOf(rows[0])).deep.equals(newPlayer('Yadier'))

    online = true
    p.client.wakeOutbox(true)
    await p.client.drainOutbox()
    const order = p.posts().filter(call => call.key != null)
    expect(order.map(call => call.path).slice(-3)).deep.equals([
      '/teams/tem_home/roster-players',
      '/teams/tem_home/roster-players',
      '/games/g1/lineups'
    ])
    const lineup = order[order.length - 1].body as SaveLineupsBody
    expect(lineup.players.map(player => player.gumboId)).deep.equals([
      made.get('Yadier'),
      made.get('Xander')
    ])
    expect(p.rows()).deep.equals([])
    const landed = JSON.parse(String(p.document(rosterKey('tem_home'))!.body))
    expect(
      landed.map((entry: { gumboId: number }) => entry.gumboId)
    ).deep.equals([made.get('Yadier'), made.get('Xander')])
    expect(landed[0]).not.have.property('nameDetails')
    expect(p.document(rosterKey('tem_home'))!.pending).equals(0)
    expect(p.document(fullRosterKey('tem_home'))!.pending).equals(0)
    // Online, a new player is sent at once and listed with his server ids.
    const third = await p.client.createRosterPlayer(
      'tem_home',
      newPlayer('Wander')
    )
    expect(third.gumboId).equals(made.get('Wander'))
    expect(JSON.parse(String(p.document(rosterKey('tem_home'))!.body))).length(
      3
    )
    // And a lineup naming one made on the phone is sent with his server id.
    await p.client.saveLineups('g1', lineupSave('D1', [one.gumboId!]))
    const now = p.posts()[p.posts().length - 1].body as SaveLineupsBody
    expect(now.players[0].gumboId).equals(made.get('Yadier'))
  })

  it('never parks one phone’s own posts after an online lineup change, and still parks on another writer’s', async function () {
    // The server's stale check, as POST /games/:gameId/events makes it.
    let current = 'L0'
    let online = true
    let plays = 0
    const p = phone(
      server(
        {
          '/games/g1/events': eventsDoc('g1', 'L0'),
          '/games/g1/lineups': lineupsDoc('L0')
        },
        sent => {
          if (!online) return 'offline'
          if (sent.path === '/games/g1/lineups') {
            current = 'L1'
            return { body: lineupsDoc(current) }
          }
          const base = (sent.body as { lineupsBase?: string }).lineupsBase
          if (base !== undefined && base !== current)
            return refusal(
              409,
              'conflict',
              'Somebody else changed the lineups since this game was read',
              { stale: true }
            )
          // A substitution among the plays moves the lineups' digest.
          if (plays++ === 0) current = 'L2'
          return { body: eventsDoc('g1', current) }
        }
      )
    )
    await p.client.gameEvents('g1')
    await p.client.gameLineups('g1')
    // Online: Save Rosters, then the post that leaves the game.
    const saved = await p.client.saveLineups('g1', lineupSave('L0'))
    expect(saved.digest).equals('L1')
    const left = await p.client.saveGameEvents('g1', {
      plays: [play(1)],
      remove: [],
      lineupsBase: saved.digest
    })
    expect(left.lineupsDigest).equals('L2')
    // The lineups the phone holds now name the server's digest.
    const lineups = p.document(lineupsKey('g1'))!
    expect(JSON.parse(String(lineups.body)).digest).equals('L2')
    expect(lineups.server_digest).equals('L2')

    // Offline: two pitches, each built on the answer before it.
    online = false
    const first = await p.client.saveGameEvents('g1', {
      plays: [play(2)],
      remove: [],
      lineupsBase: left.lineupsDigest
    })
    expect(first.lineupsDigest).equals('L2')
    await p.client.saveGameEvents('g1', {
      plays: [play(3)],
      remove: [],
      lineupsBase: first.lineupsDigest
    })
    online = true
    p.client.wakeOutbox(true)
    await p.client.drainOutbox()
    const queued = p.posts().filter(call => call.path === '/games/g1/events')
    expect(
      queued
        .slice(-2)
        .map(call => (call.body as { lineupsBase: string }).lineupsBase)
    ).deep.equals(['L2', 'L2'])
    expect(p.rows()).deep.equals([])
    expect(await p.client.outboxSummary()).deep.equals({
      count: 0,
      chains: {},
      games: {},
      teams: {}
    })

    // Somebody else saves the lineups: the next queued post parks.
    current = 'L9'
    online = false
    await p.client.saveGameEvents('g1', {
      plays: [play(4)],
      remove: [],
      lineupsBase: 'L2'
    })
    online = true
    p.client.wakeOutbox(true)
    await p.client.drainOutbox()
    expect((await p.client.outboxSummary()).games.g1).deep.equals({
      state: 'parked',
      message: 'Somebody else changed the lineups since this game was read'
    })
  })

  it('rewrites only the ids of players the phone made, wherever they stand', function () {
    const landed = new Map([[41, { serverId: 1041, userId: 'usr_server' }]])
    const body = {
      players: [{ gumboId: 41 }, { gumboId: 42 }],
      matchup: { batter: { id: 41 } },
      boxscore: { ID41: { person: 'ID41' }, ID42: {} },
      // A game's players are keyed by the bare gumbo id; a jersey is not one.
      byId: { 41: { id: 41, jersey: '41' }, 42: { id: 42 } },
      who: userIdOfGumbo(41),
      text: 'ID',
      flag: true,
      nothing: null
    }
    expect(withServerIds(body, landed)).deep.equals({
      players: [{ gumboId: 1041 }, { gumboId: 42 }],
      matchup: { batter: { id: 1041 } },
      boxscore: { ID1041: { person: 'ID1041' }, ID42: {} },
      byId: { 1041: { id: 1041, jersey: '41' }, 42: { id: 42 } },
      who: 'usr_server',
      text: 'ID',
      flag: true,
      nothing: null
    })
    expect(withServerIds(body, new Map())).equals(body)
    expect(
      withServerIds(
        { who: userIdOfGumbo(41) },
        new Map([[41, { serverId: 9, userId: null }]])
      )
    ).deep.equals({ who: userIdOfGumbo(41) })
    expect(
      namedLocalIds(
        [
          { a: 41 },
          { ID43: 1 },
          userIdOfGumbo(44),
          'ID45',
          46,
          true,
          { 47: 'x', 48: 'y' }
        ],
        new Set([41, 43, 44, 45, 47])
      ).sort((a, b) => a - b)
    ).deep.equals([41, 43, 44, 45, 47])
  })

  it('applies a post onto a game with no plays, and a save onto lineups with no current lineup', function () {
    const applied = appliedEvents(
      {},
      {
        plays: [play(3), { about: {} }],
        remove: ['x', 0],
        currentPlay: play(4)
      },
      {
        gameId: 'g1',
        plays: 'local-p',
        lineups: null,
        newPlayId: () => 'local-row',
        names: { 7: 'Juan Soto' }
      }
    )
    // The post's plays name nobody; the phone's copy names them from the
    // names kept beside it.
    const named = (gumbo: GumboPlay): GumboPlay => ({
      ...gumbo,
      matchup: { ...gumbo.matchup, batter: { id: 7, fullName: 'Juan Soto' } }
    })
    expect(applied).deep.include({
      currentPlay: named(play(4)),
      priorPlaysDigest: null,
      playsDigest: 'local-p',
      lineupsDigest: null
    })
    expect(applied.plays).deep.equals([
      { id: 'local-row', gameId: 'g1', gumbo: named(play(3)) }
    ])
    const lineups = appliedLineups(
      null,
      { side: 'away', players: [{}], battingOrder: [0, 5], defense: {} },
      'local-d'
    )
    expect(lineups).deep.include({ digest: 'local-d' })
    expect(
      (lineups.away as { current: { batters: unknown[] } }).current.batters
    ).deep.equals([{ gumboId: null, name: '', jersey: '' }, null])
  })

  it('does not send a later post of a game while an earlier one waits, and sends another game’s (Chain order)', async function () {
    const failing = new Set(['g1'])
    const p = phone(
      server(
        {
          '/games/g1/events': eventsDoc('g1', 'D0'),
          '/games/g2/events': eventsDoc('g2', 'E0')
        },
        sent => {
          const gameId = sent.path.split('/')[2]
          if (failing.has(gameId) && sent.key != null)
            return refusal(503, 'unavailable', 'Back soon')
          return { body: eventsDoc(gameId, `${gameId}-next`) }
        }
      )
    )
    await p.client.gameEvents('g1')
    await p.client.gameEvents('g2')
    // The first post's 503 queues it with the key it was sent with.
    await p.client.saveGameEvents('g1', { plays: [play(1)], remove: [] })
    const [queued] = p.rows()
    expect(queued.idempotency_key).equals(p.posts()[0].key)
    expect(queued.attempts).equals(0)
    // The next post of that game waits behind it, and is answered by the phone.
    const behind = await p.client.saveGameEvents('g1', {
      plays: [play(2)],
      remove: []
    })
    expect(behind.plays.map(row => row.about.atBatIndex)).deep.equals([0, 1, 2])
    expect(p.posts()).length(1)
    // Another game's post goes, whatever g1 waits for.
    p.clock.now += 60_000
    await p.client.saveGameEvents('g2', { plays: [play(1)], remove: [] })
    expect(p.posts().map(call => call.path)).deep.equals([
      '/games/g1/events',
      '/games/g2/events'
    ])
    // Its retry fails again: the second g1 post is still not sent.
    await p.client.drainOutbox()
    const g1 = p.posts().filter(call => call.path === '/games/g1/events')
    expect(g1.map(call => call.key)).deep.equals([
      queued.idempotency_key,
      queued.idempotency_key
    ])
    expect(p.rows().map(row => row.state)).deep.equals(['pending', 'pending'])
    expect(p.rows()[0].attempts).equals(1)
  })

  it('stores the first post’s answer and writes the second over it, pending until it lands (Re-apply)', async function () {
    let release: (() => void) | undefined
    let online = false
    const p = phone(
      server({ '/games/g1/events': eventsDoc('g1', 'D0') }, async sent => {
        if (!online) return 'offline'
        const plays = (sent.body as { plays: GumboPlay[] }).plays
        const index = plays[0].about.atBatIndex
        if (index === 2)
          await new Promise<void>(resolve => {
            release = resolve
          })
        return {
          body: {
            ...(eventsDoc(
              'g1',
              `D${index}`,
              Array.from({ length: index + 1 }, (_, at) => play(at))
            ) as object),
            playsDigest: `server-${index}`
          }
        }
      })
    )
    await p.client.gameEvents('g1')
    await p.client.saveGameEvents('g1', { plays: [play(1)], remove: [] })
    await p.client.saveGameEvents('g1', { plays: [play(2)], remove: [] })
    online = true
    p.client.wakeOutbox(true)
    // The first lands while the second is held at the server.
    const held = (): boolean => release != null
    for (let tries = 0; !held() && tries < 100; tries++)
      await new Promise(resolve => setTimeout(resolve, 5))
    const between = p.document(eventsKey('g1'))!
    expect(between.pending).equals(1)
    expect(between.server_digest).equals('D1')
    const body = JSON.parse(String(between.body))
    expect(
      body.plays.map((row: { gumbo: GumboPlay }) => row.gumbo.about.atBatIndex)
    ).deep.equals([0, 1, 2])
    // Written over the server's answer: its digest is the phone's again.
    expect(body.priorPlaysDigest).equals('server-1')
    expect(body.playsDigest).match(/^local-/)
    expect(body.plays[1].id).equals('evt_1')
    release!()
    await p.client.drainOutbox()
    const after = p.document(eventsKey('g1'))!
    expect(after.pending).equals(0)
    expect(JSON.parse(String(after.body)).playsDigest).equals('server-2')
  })

  it('parks a game’s queue on a stale 409 and keeps sending the other game’s (Park)', async function () {
    let online = false
    const p = phone(
      server(
        {
          '/games/g1/events': eventsDoc('g1', 'D0'),
          '/games/g2/events': eventsDoc('g2', 'E0')
        },
        sent => {
          if (!online) return 'offline'
          if (sent.path === '/games/g1/events')
            return refusal(
              409,
              'conflict',
              'Somebody else changed the lineups since this game was read',
              { stale: true }
            )
          return { body: eventsDoc('g2', 'E1') }
        }
      )
    )
    await p.client.gameEvents('g1')
    await p.client.gameEvents('g2')
    await p.client.saveGameEvents('g1', {
      plays: [play(1)],
      remove: [],
      lineupsBase: 'D0'
    })
    await p.client.saveGameEvents('g1', { plays: [play(2)], remove: [] })
    await p.client.saveGameEvents('g2', { plays: [play(1)], remove: [] })
    online = true
    p.client.wakeOutbox(true)
    await p.client.drainOutbox()
    // The first was tried once with no signal, and once more: refused.
    expect(
      p
        .posts()
        .filter(call => call.key != null && call.path === '/games/g1/events')
    ).length(2)
    const rows = p.rows()
    expect(rows.map(row => [row.chain, row.state])).deep.equals([
      ['game:g1', 'parked'],
      ['game:g1', 'parked']
    ])
    expect(rows[0].message).equals(
      'Somebody else changed the lineups since this game was read'
    )
    // The phone keeps the game as it scored it.
    const kept = p.document(eventsKey('g1'))!
    expect(kept.pending).equals(1)
    expect(JSON.parse(String(kept.body)).plays).length(3)
    expect(await p.client.outboxSummary()).deep.equals({
      count: 2,
      chains: { 'game:g1': 2 },
      games: {
        g1: {
          state: 'parked',
          message: 'Somebody else changed the lineups since this game was read'
        }
      },
      teams: {}
    })
    expect(p.summaries[p.summaries.length - 1].games.g1.state).equals('parked')
    // A parked chain sends nothing further, and a new post joins it.
    const sends = p.posts().length
    await p.client.saveGameEvents('g1', { plays: [play(3)], remove: [] })
    await p.client.drainOutbox()
    expect(p.posts()).length(sends)
  })

  it('queues each write with the generation it was made on, and parks a game reset since (A10)', async function () {
    let online = false
    const RESET = 'This game was reset since it was read'
    const p = phone(
      server(
        {
          '/games/g1/events': eventsDoc('g1', 'D0'),
          '/games/g1/lineups': lineupsDoc('D0')
        },
        () =>
          online
            ? refusal(409, 'conflict', RESET, { stale: true, generation: 1 })
            : 'offline'
      )
    )
    await p.client.gameEvents('g1')
    await p.client.gameLineups('g1')
    await p.client.saveGameEvents('g1', {
      plays: [play(1)],
      remove: [],
      generation: 0
    })
    await p.client.saveLineups('g1', { ...lineupSave('D0'), generation: 0 })
    const queued = p.rows()
    expect(queued).length(2)
    for (const row of queued)
      expect(JSON.parse(String(row.body))).deep.include({ generation: 0 })
    online = true
    p.client.wakeOutbox(true)
    await p.client.drainOutbox()
    const sentWith = p
      .posts()
      .filter(call => call.key != null)
      .map(call => (call.body as { generation?: unknown }).generation)
    expect(sentWith).includes(0)
    expect(p.rows().map(row => [row.chain, row.state])).deep.equals([
      ['game:g1', 'parked'],
      ['game:g1', 'parked']
    ])
    expect((await p.client.outboxSummary()).games.g1).deep.equals({
      state: 'parked',
      message: RESET
    })
  })

  it('parks the lineup that waits for a create the server refused (Dead dependency)', async function () {
    let online = false
    const p = phone(
      server(
        {
          '/games/g1/lineups': lineupsDoc('D0'),
          '/teams/tem_home/roster': []
        },
        sent => {
          if (!online) return 'offline'
          if (sent.path.endsWith('/roster-players'))
            return refusal(400, 'badRequest', 'firstName: Too long')
          return { body: lineupsDoc('D1') }
        }
      )
    )
    await p.client.gameLineups('g1')
    await p.client.roster('tem_home')
    const made = await p.client.createRosterPlayer(
      'tem_home',
      newPlayer('Ronald')
    )
    await p.client.saveLineups('g1', lineupSave('D0', [made.gumboId!]))
    online = true
    p.client.wakeOutbox(true)
    await p.client.drainOutbox()
    expect(
      p.rows().map(row => [row.chain, row.state, row.message])
    ).deep.equals([
      ['team:tem_home', 'dead', 'firstName: Too long'],
      ['game:g1', 'parked', 'firstName: Too long']
    ])
    expect(p.posts().some(call => call.path === '/games/g1/lineups')).equals(
      false
    )
    expect(await p.client.outboxSummary()).deep.equals({
      count: 2,
      chains: { 'game:g1': 1, 'team:tem_home': 1 },
      games: {
        g1: { state: 'parked', message: 'firstName: Too long', cause: 'player' }
      },
      teams: { tem_home: { state: 'dead', message: 'firstName: Too long' } }
    })
  })

  it('sends a game parked behind a refused player once the team is tried again, and once the game is', async function () {
    let online = false
    let refuse = true
    const p = phone(
      server(
        {
          '/games/g1/events': eventsDoc('g1', 'D0'),
          '/games/g2/events': eventsDoc('g2', 'E0'),
          '/teams/tem_home/roster': []
        },
        sent => {
          if (!online) return 'offline'
          if (sent.path.endsWith('/roster-players'))
            return refuse
              ? refusal(400, 'badRequest', 'firstName: Too long')
              : {
                  status: 201,
                  body: serverEntry(sent.path.length + 800, 'Ronald')
                }
          return {
            body: eventsDoc(sent.path.includes('g1') ? 'g1' : 'g2', 'D1')
          }
        }
      )
    )
    await p.client.gameEvents('g1')
    await p.client.gameEvents('g2')
    await p.client.roster('tem_home')
    const first = await p.client.createRosterPlayer(
      'tem_home',
      newPlayer('Ronald')
    )
    await p.client.saveGameEvents('g1', {
      plays: [play(1, first.gumboId!)],
      remove: []
    })
    await p.client.saveGameEvents('g1', { plays: [play(2)], remove: [] })
    online = true
    p.client.wakeOutbox(true)
    await p.client.drainOutbox()
    expect(p.rows().map(row => [row.chain, row.state])).deep.equals([
      ['team:tem_home', 'dead'],
      ['game:g1', 'parked'],
      ['game:g1', 'parked']
    ])
    // The game says why: the player's refusal, not a stale lineup.
    const held = (await p.client.outboxSummary()).games.g1
    expect(held).deep.equals({
      state: 'parked',
      message: 'firstName: Too long',
      cause: 'player'
    })
    expect(heldGameText(held)).equals('Not sent: firstName: Too long')

    // The banner's Try Again on the team: the create lands, then the game's
    // plays, both of them, with the server's id for him.
    refuse = false
    await p.client.retryTeam('tem_home')
    await p.client.drainOutbox()
    expect(p.rows()).deep.equals([])
    const sent = p.posts().filter(call => call.path === '/games/g1/events')
    expect(sent, 'both plays, once each').length(2)
    expect(JSON.stringify(sent.at(-2)!.body)).not.includes(
      String(first.gumboId)
    )

    // A second game parked behind another refused player: its own Try
    // Again sends the create and then the game.
    refuse = true
    online = false
    const second = await p.client.createRosterPlayer(
      'tem_home',
      newPlayer('Wander')
    )
    await p.client.saveGameEvents('g2', {
      plays: [play(1, second.gumboId!)],
      remove: []
    })
    online = true
    p.client.wakeOutbox(true)
    await p.client.drainOutbox()
    expect(p.rows().map(row => row.state)).deep.equals(['dead', 'parked'])
    refuse = false
    await p.client.retryGame('g2')
    await p.client.drainOutbox()
    expect(p.rows()).deep.equals([])
    expect(p.posts().at(-1)!.path).equals('/games/g2/events')
  })

  it('says a stale lineup moved on, and a player given up on in its own words', function () {
    expect(heldGameText({ state: 'parked', message: 'stale' })).equals(
      PARKED_GAME_MESSAGE
    )
    expect(
      heldGameText({
        state: 'parked',
        message: LOST_PLAYER_MESSAGE,
        cause: 'player'
      })
    ).equals(`Not sent: ${LOST_PLAYER_MESSAGE}`)
  })

  it('marks a refused write dead with the server’s message, and sends the next', async function () {
    let online = false
    const p = phone(
      server(
        {
          '/games/g1/lineups': lineupsDoc('D0'),
          '/games/g2/lineups': lineupsDoc('E0')
        },
        sent => {
          if (!online) return 'offline'
          if (sent.path === '/games/g1/lineups')
            return refusal(403, 'forbidden', 'Only the team’s head coach')
          return { body: lineupsDoc('E1') }
        }
      )
    )
    await p.client.gameLineups('g1')
    await p.client.gameLineups('g2')
    await p.client.saveLineups('g1', lineupSave('D0'))
    await p.client.saveLineups('g2', lineupSave('E0'))
    online = true
    p.client.wakeOutbox(true)
    await p.client.drainOutbox()
    expect(
      p.rows().map(row => [row.chain, row.state, row.message])
    ).deep.equals([['game:g1', 'dead', 'Only the team’s head coach']])
    expect(p.document(lineupsKey('g2'))!.server_digest).equals('E1')
  })

  it('gives up a parked game for the server’s copy: rows gone, documents no longer pending, read anew (Discard)', async function () {
    let online = false
    const server409 = server(
      {
        '/games/g1/events': eventsDoc('g1', 'D0'),
        '/games/g2/events': eventsDoc('g2', 'E0')
      },
      () =>
        online
          ? refusal(409, 'conflict', 'Somebody else changed the lineups', {
              stale: true
            })
          : 'offline'
    )
    let reads: Record<string, unknown> = {}
    const p = phone(async sent =>
      sent.method === 'GET' && sent.path in reads
        ? { body: reads[sent.path], revision: '9' }
        : await server409(sent)
    )
    await p.client.gameEvents('g1')
    await p.client.gameEvents('g2')
    await p.client.saveGameEvents('g1', { plays: [play(1)], remove: [] })
    await p.client.saveGameEvents('g1', { plays: [play(2)], remove: [] })
    await p.client.saveGameEvents('g2', { plays: [play(1)], remove: [] })
    online = true
    p.client.wakeOutbox(true)
    await p.client.drainOutbox()
    expect(p.rows().map(row => [row.chain, row.state])).deep.equals([
      ['game:g1', 'parked'],
      ['game:g1', 'parked'],
      ['game:g2', 'parked']
    ])
    // The server's copy has moved on: another writer's play.
    reads = { '/games/g1/events': eventsDoc('g1', 'S1', [play(0, 99)]) }
    const before = p.summaries.length
    await p.client.discardGame('g1')
    expect(p.rows().map(row => row.chain)).deep.equals(['game:g2'])
    const freed = p.document(eventsKey('g1'))!
    expect(freed.pending).equals(0)
    expect(freed.server_digest).equals('S1')
    expect(
      (await p.client.gameEvents('g1')).plays.map(
        shown => shown.matchup?.batter?.id
      )
    ).deep.equals([99])
    // Another game's held queue is its own.
    expect(p.document(eventsKey('g2'))!.pending).equals(1)
    expect(p.summaries.length).greaterThan(before)
    expect((await p.client.outboxSummary()).games).not.have.property('g1')
  })

  it('gives up a lineup with the refused create it waits for, and frees the rosters too', async function () {
    let online = false
    let refuse = true
    const p = phone(
      server(
        {
          '/games/g1/lineups': lineupsDoc('D0'),
          '/teams/tem_home/roster': [],
          '/teams/tem_home/roster?includeFullNames=true': []
        },
        sent => {
          if (!online) return 'offline'
          if (sent.path.endsWith('/roster-players'))
            return refuse
              ? refusal(400, 'badRequest', 'firstName: Too long')
              : { status: 201, body: serverEntry(501, 'Ronald') }
          return { body: lineupsDoc('D1') }
        }
      )
    )
    await p.client.gameLineups('g1')
    await p.client.roster('tem_home')
    await p.client.roster('tem_home', { includeFullNames: true })
    const made = await p.client.createRosterPlayer(
      'tem_home',
      newPlayer('Ronald')
    )
    await p.client.saveLineups('g1', lineupSave('D0', [made.gumboId!]))
    online = true
    p.client.wakeOutbox(true)
    await p.client.drainOutbox()
    expect(p.rows().map(row => row.state)).deep.equals(['dead', 'parked'])

    // Retried, a refusal that does not repeat lands both, in order.
    refuse = false
    await p.client.retryGame('g1')
    await p.client.drainOutbox()
    expect(p.rows()).deep.equals([])
    expect(
      p
        .posts()
        .map(call => call.path)
        .slice(-2)
    ).deep.equals(['/teams/tem_home/roster-players', '/games/g1/lineups'])

    // Refused again and given up: nothing is left queued or held.
    refuse = true
    online = false
    const again = await p.client.createRosterPlayer(
      'tem_home',
      newPlayer('Ronald')
    )
    await p.client.saveLineups('g1', lineupSave('D1', [again.gumboId!]))
    online = true
    p.client.wakeOutbox(true)
    await p.client.drainOutbox()
    expect(p.rows().map(row => row.state)).deep.equals(['dead', 'parked'])
    await p.client.discardGame('g1')
    expect(p.rows()).deep.equals([])
    for (const key of [
      lineupsKey('g1'),
      rosterKey('tem_home'),
      fullRosterKey('tem_home')
    ])
      expect(p.document(key)!.pending, key).equals(0)
    expect(await p.client.outboxSummary()).deep.equals({
      count: 0,
      chains: {},
      games: {},
      teams: {}
    })
  })

  it('gives up a team’s refused player: its rows, the player and the pending rosters go, read anew', async function () {
    let online = false
    const p = phone(
      server(
        {
          '/teams/tem_home/roster': [serverEntry(7, 'Mookie')],
          '/teams/tem_home/roster?includeFullNames=true': [
            serverEntry(7, 'Mookie')
          ]
        },
        () =>
          online
            ? refusal(403, 'forbidden', 'Only the team’s staff')
            : 'offline'
      )
    )
    await p.client.roster('tem_home')
    await p.client.roster('tem_home', { includeFullNames: true })
    await p.client.createRosterPlayer('tem_home', newPlayer('Ronald'))
    await p.client.createRosterPlayer('tem_home', newPlayer('Wander'))
    online = true
    p.client.wakeOutbox(true)
    await p.client.drainOutbox()
    expect(p.rows().map(row => row.state)).deep.equals(['dead', 'pending'])
    expect((await p.client.outboxSummary()).teams).deep.equals({
      tem_home: { state: 'dead', message: 'Only the team’s staff' }
    })
    expect(p.document(rosterKey('tem_home'))!.pending).equals(1)
    expect(await p.client.discardTeam('tem_home')).equals(true)
    expect(p.rows()).deep.equals([])
    for (const key of [rosterKey('tem_home'), fullRosterKey('tem_home')]) {
      const doc = p.document(key)!
      expect(doc.pending, key).equals(0)
      expect(JSON.parse(String(doc.body)), key).length(1)
    }
    expect(
      executors[0].db.prepare('SELECT * FROM local_players').all()
    ).deep.equals([])
    expect(await p.client.outboxSummary()).deep.equals({
      count: 0,
      chains: {},
      games: {},
      teams: {}
    })
    // And a refusal that may not repeat goes again from where it stopped.
    online = false
    await p.client.createRosterPlayer('tem_home', newPlayer('Ronald'))
    online = true
    p.client.wakeOutbox(true)
    await p.client.drainOutbox()
    const sends = p.posts().length
    await p.client.retryTeam('tem_home')
    await p.client.drainOutbox()
    expect(p.posts().length).equals(sends + 1)
  })

  it('keeps a refused create another game still waits for, and parks a game whose player was given up', async function () {
    let online = false
    let refuse = true
    const p = phone(
      server(
        {
          '/games/g1/lineups': lineupsDoc('D0'),
          '/games/g2/lineups': lineupsDoc('E0'),
          '/teams/tem_home/roster': []
        },
        sent => {
          if (!online) return 'offline'
          if (sent.path.endsWith('/roster-players'))
            return refuse
              ? refusal(400, 'badRequest', 'firstName: Too long')
              : { status: 201, body: serverEntry(601, 'Ronald') }
          return { body: lineupsDoc(sent.path.includes('g1') ? 'D1' : 'E1') }
        }
      )
    )
    await p.client.gameLineups('g1')
    await p.client.gameLineups('g2')
    await p.client.roster('tem_home')
    const made = await p.client.createRosterPlayer(
      'tem_home',
      newPlayer('Ronald')
    )
    await p.client.saveLineups('g1', lineupSave('D0', [made.gumboId!]))
    await p.client.saveLineups('g2', lineupSave('E0', [made.gumboId!]))
    online = true
    p.client.wakeOutbox(true)
    await p.client.drainOutbox()
    expect(p.rows().map(row => [row.chain, row.state])).deep.equals([
      ['team:tem_home', 'dead'],
      ['game:g1', 'parked'],
      ['game:g2', 'parked']
    ])
    // Game 1 given up: the create stays, for game 2.
    await p.client.discardGame('g1')
    expect(p.rows().map(row => row.chain)).deep.equals([
      'team:tem_home',
      'game:g2'
    ])
    // Game 2 tried again: the create goes first, and the lineup names the
    // server's id for him.
    refuse = false
    await p.client.retryGame('g2')
    await p.client.drainOutbox()
    expect(p.rows()).deep.equals([])
    const sent = p.posts().at(-1)!
    expect(sent.path).equals('/games/g2/lineups')
    expect((sent.body as SaveLineupsBody).players[0].gumboId).equals(601)

    // A team given up with a game still naming its player: the game parks
    // rather than send the phone's own id for him.
    refuse = true
    online = false
    const again = await p.client.createRosterPlayer(
      'tem_home',
      newPlayer('Wander')
    )
    await p.client.saveLineups('g1', lineupSave('D1', [again.gumboId!]))
    online = true
    p.client.wakeOutbox(true)
    await p.client.drainOutbox()
    await p.client.discardTeam('tem_home')
    await p.client.retryGame('g1')
    await p.client.drainOutbox()
    const rows = p.rows()
    expect(rows.map(row => [row.chain, row.state, row.message])).deep.equals([
      ['game:g1', 'parked', LOST_PLAYER_MESSAGE]
    ])
    expect(p.posts().at(-1)!.path).not.equals('/games/g1/lineups')
  })

  it('drops what it gave up even when the server’s copy cannot be read, and says it did not arrive', async function () {
    let online = false
    let reads = true
    const base = server({ '/games/g1/events': eventsDoc('g1', 'D0') }, () =>
      online
        ? refusal(409, 'conflict', 'Somebody else changed the lineups', {
            stale: true
          })
        : 'offline'
    )
    const p = phone(async sent =>
      sent.method === 'GET' && !reads ? 'offline' : await base(sent)
    )
    await p.client.gameEvents('g1')
    await p.client.saveGameEvents('g1', { plays: [play(1, 42)], remove: [] })
    online = true
    p.client.wakeOutbox(true)
    await p.client.drainOutbox()
    expect(p.rows().map(row => row.state)).deep.equals(['parked'])
    reads = false
    expect(await p.client.discardGame('g1')).equals(false)
    expect(p.rows()).deep.equals([])
    // Nothing given up is shown as the server's: the phone has no copy.
    expect(p.document(eventsKey('g1'))).equals(undefined)
    let thrown: unknown
    await p.client.gameEvents('g1').catch((error: unknown) => {
      thrown = error
    })
    expect(thrown).property('code', 'offline')
    reads = true
    expect(
      (await p.client.gameEvents('g1')).plays.map(
        shown => shown.matchup?.batter?.id
      )
    ).deep.equals([7])
  })

  it('sends a row the same, byte for byte, every time under its key', async function () {
    let attempt = 0
    const p = phone(
      server(
        {
          '/games/g1/lineups': lineupsDoc('D0'),
          '/teams/tem_home/roster': []
        },
        sent => {
          if (sent.path.endsWith('/roster-players')) {
            if (attempt === 0) return 'offline'
            return { status: 201, body: serverEntry(701, 'Ronald') }
          }
          attempt++
          // The first answer is lost after the server took it.
          return attempt <= 2
            ? { status: 503, body: { code: 'unavailable', message: 'x' } }
            : { body: lineupsDoc('D1') }
        }
      )
    )
    await p.client.gameLineups('g1')
    await p.client.roster('tem_home')
    const made = await p.client.createRosterPlayer(
      'tem_home',
      newPlayer('Ronald')
    )
    await p.client.saveLineups('g1', lineupSave('D0', [made.gumboId!]))
    attempt = 1
    p.client.wakeOutbox(true)
    await p.client.drainOutbox()
    // The lineup went once and its answer was lost; the row holds what went.
    const [row] = p.rows()
    const first = p.posts().filter(call => call.path === '/games/g1/lineups')
    expect(first).length(1)
    expect(JSON.parse(String(row.body))).deep.equals(first[0].body)
    // Whatever the phone learns meanwhile, the retry is the same request.
    executors[0].db.prepare('UPDATE local_players SET server_id = 999').run()
    for (let i = 0; i < 2; i++) {
      p.clock.now += 60_000
      await p.client.drainOutbox()
    }
    expect(p.rows()).deep.equals([])
    const sends = p.posts().filter(call => call.path === '/games/g1/lineups')
    expect(sends.length).greaterThan(1)
    for (const each of sends)
      expect(JSON.stringify(each.body)).equals(JSON.stringify(first[0].body))
    expect(sends.map(each => each.key)).deep.equals(
      sends.map(() => first[0].key)
    )
  })

  it('queues an online send cut short with the body it sent, under its key', async function () {
    const p = phone(
      server({ '/games/g1/events': eventsDoc('g1', 'D0') }, () => ({
        status: 503,
        body: { code: 'unavailable', message: 'Restarting' }
      }))
    )
    await p.client.gameEvents('g1')
    await p.client.saveGameEvents('g1', {
      plays: [play(1)],
      remove: [],
      lineupsBase: 'local-made-here'
    })
    const [sent] = p.posts()
    expect((sent.body as { lineupsBase?: string }).lineupsBase).equals('D0')
    const [row] = p.rows()
    expect(row.idempotency_key).equals(sent.key)
    expect(JSON.parse(String(row.body))).deep.equals(sent.body)
  })

  it('drops a row whose key the server says went with another request, and reads what it wrote again (Key reused)', async function () {
    let online = false
    let served = eventsDoc('g1', 'D0')
    const p = phone(async sent => {
      if (sent.method === 'GET') return { body: served, revision: '5' }
      if (!online) return 'offline'
      return refusal(
        409,
        'idempotencyKeyReused',
        'This Idempotency-Key was already sent with another request'
      )
    })
    await p.client.gameEvents('g1')
    await p.client.saveGameEvents('g1', { plays: [play(1)], remove: [] })
    // The play landed the first time, as the server now has it.
    served = eventsDoc('g1', 'D2', [play(0), play(1, 55)])
    online = true
    p.client.wakeOutbox(true)
    await p.client.drainOutbox()
    expect(p.rows()).deep.equals([])
    expect(await p.client.outboxSummary()).deep.equals({
      count: 0,
      chains: {},
      games: {},
      teams: {}
    })
    const doc = p.document(eventsKey('g1'))!
    expect(doc.pending).equals(0)
    expect(doc.server_digest).equals('D2')
  })

  it('sends a lineup again, without a tap, when the server says the game moved while it saved', async function () {
    let moved = 0
    const p = phone(
      server({ '/games/g1/lineups': lineupsDoc('D0') }, () => {
        moved++
        return moved <= 2
          ? refusal(
              409,
              'conflict',
              'The game changed while saving; try again',
              {
                retry: true
              }
            )
          : { body: lineupsDoc('D1') }
      })
    )
    await p.client.gameLineups('g1')
    // Online, the first answer is that conflict: queued, not thrown.
    const answer = await p.client.saveLineups('g1', lineupSave('D0'))
    expect(answer.digest).match(/^local-/)
    expect(p.rows().map(row => row.state)).deep.equals(['pending'])
    p.clock.now += 60_000
    await p.client.drainOutbox()
    // The second is that conflict again: still waiting, not refused.
    expect(p.rows().map(row => [row.state, row.attempts])).deep.equals([
      ['pending', 1]
    ])
    expect(await p.client.outboxSummary()).deep.include({ games: {} })
    p.clock.now += 60_000
    await p.client.drainOutbox()
    expect(p.rows()).deep.equals([])
    expect(p.document(lineupsKey('g1'))!.server_digest).equals('D1')
  })

  it('leaves a chain with a send in flight, and does nothing without a file', async function () {
    const p = phone(
      server({ '/games/g1/events': eventsDoc('g1', 'D0') }, () => 'offline')
    )
    await p.client.gameEvents('g1')
    await p.client.saveGameEvents('g1', { plays: [play(1)], remove: [] })
    const [row] = p.rows()
    executors[0].db
      .prepare(
        "UPDATE outbox SET state = 'inflight', lease_until = ? WHERE id = ?"
      )
      .run(p.clock.now + 60_000, String(row.id))
    await p.client.discardGame('g1')
    expect(p.rows()).length(1)
    const bare = new CachingClient({
      baseUrl: 'http://x/api/v1',
      openCache: async () => {
        throw new Error('no file')
      }
    })
    await bare.discardGame('g1')
    await bare.retryGame('g1')
  })

  it('stops after a 401 until the token changes (Auth pause)', async function () {
    let online = false
    const p = phone(
      server(
        {
          '/games/g1/lineups': lineupsDoc('D0'),
          '/games/g2/lineups': lineupsDoc('E0')
        },
        sent => {
          if (!online) return 'offline'
          if (sent.path === '/me/roles')
            return { body: { teams: {}, guardianOf: [] } }
          return p.client.token === 'token-1'
            ? refusal(401, 'unauthorized', 'Sign in to continue')
            : { body: lineupsDoc('X1') }
        }
      )
    )
    let refused = 0
    p.client.onSessionRefused = () => {
      refused++
    }
    await p.client.gameLineups('g1')
    await p.client.gameLineups('g2')
    await p.client.saveLineups('g1', lineupSave('D0'))
    await p.client.saveLineups('g2', lineupSave('E0'))
    online = true
    p.client.wakeOutbox(true)
    await p.client.drainOutbox()
    // One send, refused; the row waits and the next is not sent.
    expect(
      p.posts().filter(call => call.key != null && call.method === 'POST')
        .length
    ).equals(3)
    expect(refused).equals(1)
    expect(p.rows().map(row => row.state)).deep.equals(['pending', 'pending'])
    p.client.wakeOutbox()
    await p.client.drainOutbox()
    expect(refused).equals(1)
    // A new token alone is not the file's session: nothing goes.
    p.client.token = 'token-2'
    p.client.wakeOutbox()
    await p.client.drainOutbox()
    expect(p.rows()).length(2)
    // The same person signed in again (`openFor`): both go.
    p.client.openFor('usr_1')
    await p.client.drainOutbox()
    expect(p.rows()).deep.equals([])
  })

  it('sends nothing of a file once the token is not the one it was opened under, even mid-drain', async function () {
    let online = false
    let switchDuringPick = false
    const p = phone(
      server({ '/games/g1/lineups': lineupsDoc('D0') }, () =>
        online ? { body: lineupsDoc('D1') } : 'offline'
      )
    )
    await p.client.gameLineups('g1')
    await p.client.saveLineups('g1', lineupSave('D0'))
    // Another person signs in while the queue reads the file: their token
    // is set before their own file is opened.
    const store = await (
      p.client as unknown as {
        opened: { store: Promise<DocumentStore> }
      }
    ).opened.store
    const atomically = store.atomically.bind(store)
    store.atomically = async work => {
      const answer = await atomically(work)
      if (switchDuringPick) {
        switchDuringPick = false
        p.client.token = 'token-other'
      }
      return answer
    }
    online = true
    switchDuringPick = true
    const before = p.posts().length
    p.client.wakeOutbox(true)
    await p.client.drainOutbox()
    expect(p.posts().length, 'nothing under the other token').equals(before)
    expect(p.rows().map(row => [row.state, row.lease_until])).deep.equals([
      ['pending', null]
    ])
    // Its documents are not that person's either: a read stores nothing.
    expect(await p.client.cached(lineupsKey('g1'), raw => raw)).equals(
      undefined
    )
    await p.client.prefetch()
    // And a write the other session makes goes straight to the server,
    // never into this file's queue.
    await p.client.saveLineups('g1', lineupSave('D0'))
    expect(p.rows()).length(1)
    // The file's own person, signed in again, sends it once.
    p.client.token = 'token-1b'
    p.client.openFor('usr_1')
    await p.client.drainOutbox()
    expect(p.rows()).deep.equals([])
  })

  it('closes a refused session’s file without deleting it, and opens it again for its person', async function () {
    const p = phone(
      server({ '/games/g1/lineups': lineupsDoc('D0') }, () => 'offline')
    )
    await p.client.gameLineups('g1')
    await p.client.saveLineups('g1', lineupSave('D0'))
    await p.client.sessionRefused()
    expect(p.client.cacheUser).equals(undefined)
    expect(await p.client.outboxSummary()).deep.include({ count: 0 })
    p.client.openFor('usr_1')
    expect((await p.client.outboxSummary()).count).equals(1)
  })

  it('waits 1s, 2s, 4s, 8s and 15s between failed sends, a fifth longer at most, and starts again after a 2xx', async function () {
    let answer: Answer = 'offline'
    const p = phone(
      server({ '/games/g1/lineups': lineupsDoc('D0') }, () => answer)
    )
    await p.client.gameLineups('g1')
    await p.client.saveLineups('g1', lineupSave('D0'))
    const waits: number[] = []
    for (let attempt = 0; attempt < 6; attempt++) {
      const timer = p.timers[p.timers.length - 1]
      waits.push(timer.ms)
      // Woken too soon, nothing is sent.
      const before = p.posts().length
      await p.client.drainOutbox()
      expect(p.posts()).length(before)
      p.clock.now += timer.ms
      timer.run()
      await p.client.drainOutbox()
    }
    expect(waits).deep.equals(
      [...BACKOFF_MS, 15000].map(ms => ms * (1 + 0.5 * JITTER))
    )
    for (const [index, ms] of waits.entries())
      expect(ms).within(
        BACKOFF_MS[Math.min(index, 4)],
        BACKOFF_MS[Math.min(index, 4)] * (1 + JITTER)
      )
    expect(p.rows()[0].attempts).equals(6)
    // A 5xx waits as no signal does; a request that works ends neither.
    answer = refusal(500, 'internal', 'Something went wrong')
    p.clock.now += 20_000
    await p.client.drainOutbox()
    const wait = p.timers[p.timers.length - 1].ms
    expect(wait).equals(15000 * (1 + 0.5 * JITTER))
    await p.client.gameLineups('g1')
    await p.client.drainOutbox()
    expect(p.rows()[0].attempts).equals(7)
    // A 2xx starts the waits again from the first.
    answer = { body: lineupsDoc('D1') }
    p.clock.now += 20_000
    await p.client.drainOutbox()
    expect(p.rows()).deep.equals([])
    answer = 'offline'
    await p.client.saveLineups('g1', lineupSave('D1'))
    expect(p.timers[p.timers.length - 1].ms).equals(1000 * (1 + 0.5 * JITTER))
  })

  it('ends a wait no signal began once a request works', async function () {
    let online = false
    const p = phone(
      server({ '/games/g1/lineups': lineupsDoc('D0') }, () =>
        online ? { body: lineupsDoc('D1') } : 'offline'
      )
    )
    await p.client.gameLineups('g1')
    await p.client.saveLineups('g1', lineupSave('D0'))
    expect(p.rows()).length(1)
    online = true
    // A read that reaches the server wakes the queue, and it sends at once.
    await p.client.gameLineups('g1')
    await p.client.drainOutbox()
    expect(p.rows()).deep.equals([])
  })

  it('sends nothing while the app is in the background', async function () {
    let online = false
    const p = phone(
      server({ '/games/g1/lineups': lineupsDoc('D0') }, () =>
        online ? { body: lineupsDoc('D1') } : 'offline'
      )
    )
    await p.client.gameLineups('g1')
    await p.client.saveLineups('g1', lineupSave('D0'))
    p.client.setActive(false)
    online = true
    p.client.wakeOutbox(true)
    await p.client.drainOutbox()
    expect(p.rows()).length(1)
    p.client.setActive(true)
    await p.client.drainOutbox()
    expect(p.rows()).deep.equals([])
  })

  it('sends what is queued before a prefetch reads (push before pull)', async function () {
    let online = false
    const p = phone(
      server(
        {
          '/games/g1/lineups': lineupsDoc('D0'),
          '/me/roles': { teams: {}, guardianOf: [] },
          '/events?when=upcoming': []
        },
        () => (online ? { body: lineupsDoc('D1') } : 'offline')
      )
    )
    await p.client.gameLineups('g1')
    await p.client.saveLineups('g1', lineupSave('D0'))
    online = true
    p.client.offline = false
    const from = p.sent.length
    await p.client.prefetch()
    expect(p.sent[from].method).equals('POST')
    expect(p.rows()).deep.equals([])
  })

  it('refuses a new team, season, event or game offline, and queues nothing (Refuse creates)', async function () {
    // Only whether they are sent matters: what they carry is not read.
    const blank: unknown = {}
    const team: CreateGroup = {
      kind: 'team',
      name: 'Hawks',
      idempotencyKey: 'create-1'
    }
    type TeamEvent = Parameters<CachingClient['createTeamEvent']>[0]
    type Proposal = Parameters<CachingClient['proposeGame']>[0]
    const p = phone(() => 'offline')
    await p.client.teams().catch(() => undefined)
    expect(p.client.offline).equals(true)
    const sends = p.sent.length
    for (const create of [
      async () => await p.client.createGroup(team),
      async () => await p.client.createTeamEvent(blank as TeamEvent),
      async () => await p.client.proposeGame(blank as Proposal)
    ]) {
      let refused: unknown
      try {
        await create()
      } catch (error) {
        refused = error
      }
      expect(refused).property('message').equals(OFFLINE_CREATE_MESSAGE)
      expect(refused).property('code').equals('offline')
    }
    expect(p.sent).length(sends)
    expect(p.rows()).deep.equals([])
    // Online, they go to the server as before.
    const online = phone(
      server({}, sent =>
        sent.path === '/teams'
          ? {
              status: 201,
              body: { id: 'tem_1', kind: 'team', name: 'Hawks', imageUrl: null }
            }
          : sent.path === '/events'
            ? { status: 201, body: { id: 'tev_1' } }
            : {
                body: {
                  id: 'req_1',
                  status: 'pending',
                  gameId: null
                }
              }
      )
    )
    expect((await online.client.createGroup(team)).id).equals('tem_1')
    expect((await online.client.createTeamEvent(blank as TeamEvent)).id).equals(
      'tev_1'
    )
    expect((await online.client.proposeGame(blank as Proposal)).id).equals(
      'req_1'
    )
    expect(online.rows()).deep.equals([])
  })

  it('answers an online call from the server, and throws a refusal as before', async function () {
    const p = phone(
      server({ '/games/g1/lineups': lineupsDoc('D0') }, sent =>
        (sent.body as SaveLineupsBody).base === 'bad'
          ? refusal(400, 'badRequest', 'No such player')
          : { body: lineupsDoc('D1') }
      )
    )
    await p.client.gameLineups('g1')
    const saved = await p.client.saveLineups('g1', lineupSave('D0'))
    expect(saved.digest).equals('D1')
    expect(p.posts()[0].key).match(/^[0-9a-f]{32}$/)
    expect(p.document(lineupsKey('g1'))).deep.include({
      pending: 0,
      server_digest: 'D1'
    })
    let refused: unknown
    try {
      await p.client.saveLineups('g1', lineupSave('bad'))
    } catch (error) {
      refused = error
    }
    expect(refused).property('code').equals('badRequest')
    expect(p.rows()).deep.equals([])
  })

  it('sends a queued row left in flight once its lease runs out', async function () {
    const p = phone(
      server({ '/games/g1/lineups': lineupsDoc('D0') }, () => ({
        body: lineupsDoc('D1')
      }))
    )
    await p.client.gameLineups('g1')
    await p.client.drainOutbox()
    const db = executors[0].db
    db.prepare(
      `INSERT INTO outbox (id, idempotency_key, seq, chain, method, path, body,
         depends_on, state, attempts, lease_until, game_id)
       VALUES ('r1', 'k1', 1, 'game:g1', 'POST', '/games/g1/lineups', ?, '[]',
         'inflight', 0, ?, 'g1')`
    ).run(JSON.stringify(lineupSave('D0')), p.clock.now + 30_000)
    p.client.wakeOutbox()
    await p.client.drainOutbox()
    // Another process holds it for now: the queue waits for the lease.
    expect(p.posts()).deep.equals([])
    const timer = p.timers[p.timers.length - 1]
    expect(timer.ms).equals(30_000)
    p.clock.now += 30_001
    timer.run()
    await p.client.drainOutbox()
    expect(p.posts().map(call => call.key)).deep.equals(['k1'])
    expect(p.rows()).deep.equals([])
  })

  /** The game's plays, Babe Ruth batting first, named as a read answers them. */
  const namedEvents = (): unknown =>
    eventsDoc('g1', 'D0', [
      {
        ...play(0, 901),
        matchup: { batter: { id: 901, fullName: 'Babe Ruth' } }
      }
    ])
  const guestPath = `/games/g1/guest-players/${userIdOfGumbo(901)}`
  const batterOf = (body: string, at: number): unknown =>
    (JSON.parse(body) as { plays: Array<{ gumbo: GumboPlay }> }).plays[at].gumbo
      .matchup?.batter

  it('reads a game-only player’s rename as a queued call on the game’s chain', function () {
    const rename = queuedCallOf(
      'PUT',
      guestPath,
      { firstName: 'George' },
      {
        901: 'George Ruth'
      }
    )!
    expect(rename).deep.equals({
      kind: 'guestRename',
      gameId: 'g1',
      userId: userIdOfGumbo(901),
      path: guestPath,
      body: { firstName: 'George' },
      names: { 901: 'George Ruth' }
    })
    expect(chainOf(rename)).equals('game:g1')
    expect(queuedCallOf('PUT', '/games/g1/lineups', {})).equals(undefined)
    expect(queuedCallOf('PUT', '/games/%E0/guest-players/u', {})).equals(
      undefined
    )
    expect(
      queuedCallOf('POST', '/games/g1/events', { mode: 'live' }, { 7: 'A' })
    ).deep.include({ kind: 'events', names: { 7: 'A' } })
  })

  it('keeps a post’s names beside it on the phone, names the phone’s copy with them, and sends none', async function () {
    let online = false
    const p = phone(
      server({ '/games/g1/events': namedEvents() }, sent =>
        online ? { body: namedEvents() } : 'offline'
      )
    )
    await p.client.gameEvents('g1')
    await p.client.saveGameEvents('g1', {
      plays: [play(1, 902)],
      remove: [],
      names: { 902: 'Lou Gehrig' }
    })
    const [row] = p.rows()
    expect(JSON.parse(String(row.names))).deep.equals({ 902: 'Lou Gehrig' })
    expect(String(row.body)).not.include('Lou Gehrig')
    expect(bodyOf(row)).not.have.property('names')
    const held = String(p.document(eventsKey('g1'))!.body)
    expect(batterOf(held, 0)).deep.equals({ id: 901, fullName: 'Babe Ruth' })
    expect(batterOf(held, 1)).deep.equals({ id: 902, fullName: 'Lou Gehrig' })
    online = true
    p.clock.now += 60_000
    await p.client.drainOutbox()
    const posted = p.posts().filter(call => call.key != null)
    expect(posted.length).greaterThan(0)
    for (const call of posted) {
      expect(JSON.stringify(call.body)).not.include('Lou Gehrig')
      expect(call.body).not.have.property('names')
    }
    expect(p.rows()).deep.equals([])
  })

  it('queues a rename made offline ahead of the lineup save, and writes the name onto the phone’s copy', async function () {
    let online = false
    const p = phone(
      server(
        {
          '/games/g1/events': namedEvents(),
          '/games/g1/lineups': lineupsDoc('D0')
        },
        sent => {
          if (!online) return 'offline'
          if (sent.method === 'PUT')
            return {
              body: serverEntry(
                901,
                String((sent.body as { firstName: string }).firstName)
              )
            }
          return { body: lineupsDoc('D1') }
        }
      )
    )
    await p.client.gameEvents('g1')
    await p.client.gameLineups('g1')
    const entry = await p.client.renameGuestPlayer(
      'g1',
      userIdOfGumbo(901),
      { firstName: 'George', lastName: 'Ruth' },
      901
    )
    expect(entry).deep.include({
      userId: userIdOfGumbo(901),
      gumboId: 901,
      shortName: 'George Ruth'
    })
    await p.client.saveLineups('g1', lineupSave('D0', [901]))
    expect(p.rows().map(row => [row.method, row.path, row.chain])).deep.equals([
      ['PUT', guestPath, 'game:g1'],
      ['POST', '/games/g1/lineups', 'game:g1']
    ])
    expect(JSON.parse(String(p.rows()[0].names))).deep.equals({
      901: 'George Ruth'
    })
    const held = p.document(eventsKey('g1'))!
    expect(held.pending).equals(1)
    // By the game's short name for him, as the server will name him.
    expect(batterOf(String(held.body), 0)).deep.equals({
      id: 901,
      fullName: 'George R'
    })
    const before = p.sent.length
    online = true
    p.clock.now += 60_000
    await p.client.drainOutbox()
    const sent = p.sent.slice(before).filter(call => call.key != null)
    expect(sent.map(call => [call.method, call.path])).deep.equals([
      ['PUT', guestPath],
      ['POST', '/games/g1/lineups']
    ])
    expect(sent[0].body).deep.equals({ firstName: 'George', lastName: 'Ruth' })
    expect(p.rows()).deep.equals([])
    // The server's to answer again, with the name it now gives him.
    expect(p.document(eventsKey('g1'))!.pending).equals(0)
  })

  it('names a guest renamed offline by the game’s short name, against everyone its plays name, and gives his halves only to his setup players', async function () {
    // George Kell bats second; the at-bat in progress holds both in its setup,
    // with the halves a scorer is answered.
    const setupPlayer = (
      id: number,
      fullName: string,
      firstName: string,
      lastName: string
    ): Record<string, unknown> => ({
      id,
      teamId: 'tem_away',
      fullName,
      firstName,
      lastName
    })
    const atBat = {
      ...play(2, 901),
      about: { atBatIndex: 2, inning: 1, halfInning: 'top', isComplete: false },
      matchup: { batter: { id: 901, fullName: 'Babe R' } },
      teamStation: {
        version: 2,
        setupBefore: {
          players: {
            901: setupPlayer(901, 'Babe R', 'Babe', 'Ruth'),
            902: setupPlayer(902, 'George K', 'George', 'Kell')
          },
          sides: {},
          tagOrder: []
        },
        actions: []
      }
    }
    const p = phone(
      server(
        {
          '/games/g1/events': {
            ...(eventsDoc('g1', 'D0', [
              {
                ...play(0, 901),
                matchup: { batter: { id: 901, fullName: 'Babe R' } }
              },
              {
                ...play(1, 902),
                matchup: { batter: { id: 902, fullName: 'George K' } }
              }
            ]) as Record<string, unknown>),
            currentPlay: atBat
          }
        },
        () => 'offline'
      )
    )
    await p.client.gameEvents('g1')
    await p.client.renameGuestPlayer(
      'g1',
      userIdOfGumbo(901),
      { firstName: 'George', lastName: 'Kirby' },
      901
    )
    const held = JSON.parse(String(p.document(eventsKey('g1'))!.body)) as {
      plays: Array<{ gumbo: GumboPlay }>
      currentPlay: Record<string, any>
    }
    // "George K" is Kell's: the guest takes the letters that tell them apart.
    expect(held.plays.map(row => row.gumbo.matchup?.batter)).deep.equals([
      { id: 901, fullName: 'George Ki' },
      { id: 902, fullName: 'George K' }
    ])
    expect(held.currentPlay.matchup.batter).deep.equals({
      id: 901,
      fullName: 'George Ki'
    })
    expect(held.currentPlay.teamStation.setupBefore.players).deep.equals({
      901: setupPlayer(901, 'George Ki', 'George', 'Kirby'),
      902: setupPlayer(902, 'George K', 'George', 'Kell')
    })
  })

  it('drops a refused rename alone and still sends the lineup save and plays behind it', async function () {
    let online = false
    const p = phone(
      server(
        {
          '/games/g1/events': namedEvents(),
          '/games/g1/lineups': lineupsDoc('D0')
        },
        sent => {
          if (!online) return 'offline'
          if (sent.method === 'PUT')
            return String((sent.body as { firstName: string }).firstName) ===
              'George'
              ? refusal(403, 'forbidden', 'This player can sign in')
              : refusal(409, 'conflict', 'The game moved on', { stale: true })
          if (sent.path === '/games/g1/lineups')
            return { body: lineupsDoc('D1') }
          return { body: namedEvents() }
        }
      )
    )
    await p.client.gameEvents('g1')
    await p.client.gameLineups('g1')
    await p.client.renameGuestPlayer(
      'g1',
      userIdOfGumbo(901),
      { firstName: 'George', lastName: 'Ruth' },
      901
    )
    await p.client.saveLineups('g1', lineupSave('D0', [901]))
    await p.client.renameGuestPlayer(
      'g1',
      userIdOfGumbo(901),
      { firstName: 'Herman', lastName: 'Ruth' },
      901
    )
    await p.client.saveGameEvents('g1', {
      plays: [play(1)],
      remove: [],
      names: { 7: 'Mel Ott' }
    })
    // Renamed on the phone, as the scorer typed it last.
    expect(batterOf(String(p.document(eventsKey('g1'))!.body), 0)).deep.equals({
      id: 901,
      fullName: 'Herman R'
    })
    const before = p.sent.length
    online = true
    p.clock.now += 60_000
    await p.client.drainOutbox()
    const sent = p.sent.slice(before).filter(call => call.key != null)
    expect(sent.map(call => [call.method, call.path])).deep.equals([
      ['PUT', guestPath],
      ['POST', '/games/g1/lineups'],
      ['PUT', guestPath],
      ['POST', '/games/g1/events']
    ])
    expect(p.rows()).deep.equals([])
    expect((await p.client.outboxSummary()).games).deep.equals({})
    // The plays' answer is the server's: the name it gives him.
    const after = p.document(eventsKey('g1'))!
    expect(after.pending).equals(0)
    expect(batterOf(String(after.body), 0)).deep.equals({
      id: 901,
      fullName: 'Babe Ruth'
    })
  })

  it('keeps the halves the server gave a guest over an offline post, so a game reopened from the phone corrects nobody on a jersey edit', async function () {
    // The game as the server keeps it: a guest, "Avery S" in this game, and
    // an at-bat in progress whose setup holds him.
    const game = scoringSession(gameFixture)
    const guest = game.liveData.boxscore.teams.away.players[0]
    Object.assign(game.gameData.players[guest], {
      fullName: 'Avery S',
      firstName: 'Avery',
      lastName: 'Smith'
    })
    const kept = memoryStore()
    const begun = ScoringSession.start(kept, 'g1', game)
    expect(begun.apply({ type: 'pitch', call: 'B' }).problems).deep.equals([])
    await begun.flush()
    const stored = kept.games.get('g1')!
    // Answered to a scorer as the server answers him: named, the setups'
    // players with their halves.
    const named = (await kept.load('g1')).currentPlay!
    const setups = (play: Record<string, any>): Array<Record<string, any>> =>
      [
        play.teamStation?.setupBefore,
        ...(play.teamStation?.actions ?? []).map(
          (action: Record<string, any>) => action.setup
        )
      ].filter(setup => setup?.players != null)
    for (const setup of setups(named))
      for (const player of Object.values<Record<string, any>>(setup.players))
        if (player.id === guest)
          Object.assign(player, { firstName: 'Avery', lastName: 'Smith' })
    expect(setups(named)).not.deep.equals([])
    let online = true
    const p = phone(
      server(
        {
          '/games/g1/events': {
            ...(eventsDoc('g1', 'D0', []) as Record<string, unknown>),
            plays: stored.plays.map((gumbo, index) => ({
              id: `evt_${index}`,
              gameId: 'g1',
              gumbo
            })),
            currentPlay: named
          }
        },
        () => (online ? { body: {} } : 'offline')
      )
    )
    const store = {
      load: async (gameId: string) => await p.client.gameEvents(gameId),
      save: async (gameId: string, change: SaveChange) =>
        await p.client.saveGameEvents(gameId, change)
    }
    const context = {
      gamePk: 'g1',
      teams: game.gameData.teams,
      setup: setupOf(game)
    }
    const scoring = await ScoringSession.open(store, 'g1', context)
    expect(scoring.state.gameData.players[guest]).deep.include({
      firstName: 'Avery',
      lastName: 'Smith'
    })
    // Offline, a pitch is queued, and the phone's copy is written from it.
    online = false
    expect(scoring.apply({ type: 'pitch', call: 'S' }).problems).deep.equals([])
    await scoring.flush()
    expect(p.rows().map(row => [row.method, row.path])).deep.equals([
      ['POST', '/games/g1/events']
    ])
    // Opened again from the phone, still offline: he keeps his halves.
    const reopened = await ScoringSession.open(store, 'g1', context)
    const before = reopened.state
    expect(before.gameData.players[guest]).deep.include({
      fullName: 'Avery S',
      firstName: 'Avery',
      lastName: 'Smith'
    })
    // Only his jersey changes: no rename, and none is queued.
    const draft = copyState(before)
    editLocalPlayerDraft(draft, 'away', guest, {
      ...draftOfLocalPlayer(before.gameData.players[guest]),
      jersey: '42'
    })
    const renames = guestRenames(before, draft)
    expect(renames).deep.equals([])
    await sendGuestRenames(p.client, 'g1', renames, [])
    expect(p.rows().map(row => row.method)).deep.equals(['POST'])
  })

  it('sends a queued write without a cache as a plain request', async function () {
    const sent: string[] = []
    const client = new CachingClient({
      baseUrl: 'http://x/api/v1',
      fetch: (async (_url: unknown, init: RequestInit) => {
        sent.push(
          (init.headers as Record<string, string>)['idempotency-key'] ?? 'none'
        )
        return new Response(JSON.stringify(lineupsDoc('D1')))
      }) as unknown as typeof fetch,
      openCache: async () => {
        throw new Error('no disk')
      }
    })
    client.openFor('usr_2')
    expect((await client.saveLineups('g1', lineupSave('D0'))).digest).equals(
      'D1'
    )
    expect(sent).deep.equals(['none'])
    expect(await client.outboxSummary()).deep.equals({
      count: 0,
      chains: {},
      games: {},
      teams: {}
    })
  })
})
