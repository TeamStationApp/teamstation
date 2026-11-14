import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { DatabaseSync } from 'node:sqlite'

import { expect } from 'chai'

import {
  asRosterEntry,
  REQUEST_DEADLINE_MS,
  type SaveLineupsBody
} from '../../common/api'
import { HttpError } from '../../common/errors'
import type { CreateGroup } from '../../common/groupCreation'
import type { GumboPlay } from '../../common/gumboPlay'
import type { NewRosterPlayer } from '../../common/playerSettings'
import { FOLD_VERSION } from '../../common/scoring/actions'
import { FINAL_INDEX, recordOf } from '../../common/scoring/gumbo'
import {
  type LineupRecovery,
  type SaveChange,
  ScoringSession,
  type SessionLog
} from '../../common/scoring/session'
import { copyState, setupOf } from '../../common/scoring/state'
import { playForWire } from '../../common/scoring/wireRecord'
import { userIdOfGumbo } from '../../common/userId'
import { nodeSqliteExecutor } from '../../test/nodeSqliteExecutor'
import { scoringSession } from '../../test/scoringSession'
import { candidateNames } from '../scoring/candidateNames'
import { shortPlayerNames } from '../scoring/currentSetup'
import { guestRenames, sendGuestRenames } from '../scoring/guestRenames'
import { gameFixture } from '../scoring/isUnscoredGame.test'
import {
  addRosteredPlayer,
  draftOfLocalPlayer,
  editLocalPlayerDraft,
  emptyPlayerDraft
} from '../scoring/playerDraft'
import { memoryStore } from '../scoring/scoringSource'
import {
  cacheFileName,
  type DocumentStore,
  openCacheStore,
  type SqlExecutor,
  type StoredDocument
} from './cacheStore'
import { CachingClient, OFFLINE_CREATE_MESSAGE } from './cachingClient'
import {
  eventsKey,
  fullRosterKey,
  gameKey,
  lineupsKey,
  rosterKey
} from './documentKeys'
import {
  appliedEvents,
  appliedLineups,
  namedLocalIds,
  withServerIds
} from './optimistic'
import {
  BACKOFF_MS,
  chainOf,
  confirmedPlays,
  JITTER,
  LOST_PLAYER_MESSAGE,
  NEWER_LINEUP_MESSAGE,
  OLDER_SAVE_HELD,
  type OutboxNotice,
  type OutboxOptions,
  type OutboxSummary,
  PENDING_APPROVAL_MESSAGE,
  preparedWithoutStore,
  queuedCallOf,
  STAND_IN_MESSAGE,
  swapEffectOf,
  UNVERIFIED_SCORING_HELD
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

/** The at-bats of the plays a phone's events document holds. */
const atBatsOf = (document: Record<string, unknown> | undefined): number[] =>
  (
    JSON.parse(String(document?.body)) as {
      plays: Array<{ gumbo: GumboPlay }>
    }
  ).plays.map(row => row.gumbo.about.atBatIndex)

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
  /** The path, without its query. */
  path: string
  /** The query the call was sent with, if it had one. */
  query?: string
  body: unknown
  key: string | undefined
}

type Answer = 'offline' | { status?: number; body: unknown }

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
  function phone(
    handler: Handler,
    /** Stands between the client and its file, when given. */
    wrap?: (store: DocumentStore) => DocumentStore,
    /** The queue's other options: how it judges an older build's save. */
    outbox: Pick<OutboxOptions, 'olderSave' | 'rebuildEvents'> = {},
    /** How long a send waits for an answer to begin, when not the app's. */
    requestDeadlineMs?: number,
    /** Told when a request misses its deadline or a give-up cuts it off. */
    onDeadlineMissed?: () => void
  ): {
    client: CachingClient
    sent: Sent[]
    /** The signal each of `sent` went with, in the same order. */
    signals: Array<AbortSignal | undefined>
    posts: () => Sent[]
    /** Each timer the queue set: when, for how long, and whether cleared. */
    timers: Array<{ run: () => void; ms: number; at: number; cleared?: true }>
    clock: { now: number }
    rows: () => Array<Record<string, unknown>>
    /** Runs a statement on the phone's file, as an older build left it. */
    sql: (statement: string) => void
    document: (key: string) => Record<string, unknown> | undefined
    summaries: OutboxSummary[]
  } {
    const sent: Sent[] = []
    const signals: Array<AbortSignal | undefined> = []
    const timers: Array<{
      run: () => void
      ms: number
      at: number
      cleared?: true
    }> = []
    const clock = { now: 1_000_000 }
    const fetch = (async (url: unknown, init: RequestInit) => {
      const headers = init.headers as Record<string, string>
      const [path, query] = String(url)
        .replace('http://x/api/v1', '')
        .split('?')
      const call: Sent = {
        method: String(init.method),
        path,
        ...(query == null ? {} : { query }),
        body: typeof init.body === 'string' ? JSON.parse(init.body) : undefined,
        key: headers['idempotency-key']
      }
      sent.push(call)
      signals.push(init.signal ?? undefined)
      const answer = await handler(call)
      if (answer === 'offline') throw new TypeError('Load failed')
      return new Response(JSON.stringify(answer.body), {
        status: answer.status ?? 200
      })
    }) as unknown as typeof globalThis.fetch
    const openCache = async (userId: string): Promise<DocumentStore> => {
      const executor = nodeSqliteExecutor(join(dir, cacheFileName(userId)))
      executors.push(executor)
      const store = await openCacheStore(executor)
      return wrap == null ? store : wrap(store)
    }
    const client = new CachingClient({
      baseUrl: 'http://x/api/v1',
      token: 'token-1',
      fetch,
      openCache,
      ...(requestDeadlineMs == null ? {} : { requestDeadlineMs }),
      ...(onDeadlineMissed == null ? {} : { onDeadlineMissed }),
      outbox: {
        now: () => clock.now,
        random: () => 0.5,
        setTimer: (run, ms) => {
          timers.push({ run, ms, at: clock.now })
          return timers.length
        },
        clearTimer: handle => {
          const timer = timers[Number(handle) - 1]
          if (timer != null) timer.cleared = true
        },
        ...outbox
      }
    })
    // These transport fixtures model a current session starting before its
    // first scoring mutation. Upgrade tests strip the persisted wire metadata.
    const saveEvents = client.saveGameEvents.bind(client)
    client.saveGameEvents = async (gameId, change, handoff) =>
      await saveEvents(gameId, { scoringBase: null, ...change }, handoff)
    client.openFor('usr_1')
    const summaries: OutboxSummary[] = []
    client.subscribeOutbox(summary => summaries.push(summary))
    const db = (): DatabaseSync => executors[executors.length - 1].db
    return {
      client,
      sent,
      signals,
      posts: () => sent.filter(call => call.method === 'POST'),
      timers,
      clock,
      rows: () => db().prepare('SELECT * FROM outbox ORDER BY seq').all(),
      sql: statement => {
        db().exec(statement)
      },
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
          ? { body: reads[sent.path] }
          : refusal(404, 'notFound', 'Not found')
        : await post(sent)

  const bodyOf = (row: Record<string, unknown>): Record<string, unknown> =>
    JSON.parse(String(row.body))

  it('reads what a reset confirms from the server’s copy of the game, whoever reads the file (1.harness-review.4)', async function () {
    const docs: Record<string, { body: string; pending?: boolean }> = {}
    const read = async (key: string): Promise<StoredDocument | undefined> =>
      key in docs
        ? ({
            key,
            body: docs[key].body,
            serverBody: null,
            pending: docs[key].pending === true
          } as unknown as StoredDocument)
        : undefined
    expect(await confirmedPlays(read, 'g1')).deep.equals({})
    docs[gameKey('g1')] = { body: JSON.stringify({ generation: 3 }) }
    expect(await confirmedPlays(read, 'g1')).deep.equals({ generation: 3 })
    docs[eventsKey('g1')] = {
      body: JSON.stringify({ generation: 4, playsDigest: 'P4' })
    }
    expect(await confirmedPlays(read, 'g1')).deep.equals({
      generation: 4,
      playsDigest: 'P4'
    })
    // A digest that is not one, and a body that cannot be read, name nothing.
    docs[eventsKey('g1')] = { body: JSON.stringify({ playsDigest: 7 }) }
    expect(await confirmedPlays(read, 'g1')).deep.equals({ generation: 3 })
    docs[eventsKey('g1')] = { body: '{not json' }
    docs[gameKey('g1')] = { body: '{not json' }
    expect(await confirmedPlays(read, 'g1')).deep.equals({})
  })

  it('reads a queued swap’s effect from its body, before and after it is prepared (1.harness-review.3)', function () {
    const swap = (body: unknown): Parameters<typeof swapEffectOf>[0] => {
      const call = queuedCallOf(
        'POST',
        '/games/g1/swap-sides',
        body,
        undefined,
        false,
        undefined,
        'swap'
      )
      if (call?.kind !== 'swapSides') throw new Error('not a swap')
      return call
    }
    const sides = { homeTeamId: 'tem_a', awayTeamId: 'tem_b' }
    expect(swapEffectOf(swap({ ...sides, effect: 'swap' }))).equals('swap')
    expect(swapEffectOf(swap({ ...sides, effect: 'reset' }))).equals('reset')
    // Prepared: the effect is gone, and a swap names only the sides.
    expect(swapEffectOf(swap(sides))).equals('swap')
    expect(
      swapEffectOf(swap({ ...sides, playsDigest: 'P1', generation: 2 }))
    ).equals('reset')
    // A reset prepared where the phone held no digest still is one.
    expect(swapEffectOf(swap({ ...sides, generation: 2 }))).equals('reset')
  })

  it('reads which calls it queues, and on which chain', function () {
    expect(queuedCallOf('POST', '/teams/t%201/roster-players', {})).deep.equals(
      {
        kind: 'roster',
        teamId: 't 1',
        path: '/teams/t%201/roster-players',
        body: {}
      }
    )
    // An existing player is added by id after a search: never queued.
    expect(
      queuedCallOf('POST', '/teams/t1/roster-players', { userId: 'usr_one' })
    ).equals(undefined)
    const live = { mode: 'live' }
    expect(chainOf(queuedCallOf('POST', '/games/g1/events', live)!)).equals(
      'game:g1'
    )
    // Asked for its edits by the client, it is queued to answer every play.
    expect(
      queuedCallOf('POST', '/games/g%201/events?answer=edits', live)
    ).deep.equals({
      kind: 'events',
      gameId: 'g 1',
      path: '/games/g%201/events',
      body: live
    })
    expect(queuedCallOf('POST', '/games/g1/events?answer=all', live)).equals(
      undefined
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

  it('sends a live post asking for no answer, so every play, writes that answer as the game, and answers its digests (M4)', async function () {
    let bare = false
    const p = phone(
      server(
        {
          '/games/g1/events': eventsDoc('g1', 'D0'),
          '/games/g1/lineups': lineupsDoc('D0')
        },
        () => ({
          body: bare
            ? { plays: [], currentPlay: null }
            : {
                ...(eventsDoc('g1', 'D1', [play(0), play(1)]) as object),
                priorPlaysDigest: 'plays-D0',
                generation: 3
              }
        })
      )
    )
    await p.client.gameEvents('g1')
    const saved = await p.client.saveGameEvents('g1', {
      plays: [play(1)],
      remove: [],
      lineupsBase: 'D0'
    })
    const [post] = p.posts()
    // Sent with no answer asked for, so the server answers every play.
    expect(post.path).equals('/games/g1/events')
    expect(post.query).equals(undefined)
    expect(post.key).to.be.a('string')
    expect(saved).deep.equals({
      playsDigest: 'plays-D1',
      priorPlaysDigest: 'plays-D0',
      lineupsDigest: 'D1',
      generation: 3
    })
    // The whole answer is the phone's copy of the game now.
    const document = p.document(eventsKey('g1'))!
    expect(atBatsOf(document)).deep.equals([0, 1])
    expect(document.pending).equals(0)
    expect(document.server_digest).equals('D1')
    // A server mocked with a bare list answers no digests, and no error.
    bare = true
    expect(
      await p.client.saveGameEvents('g1', { plays: [play(2)], remove: [] })
    ).deep.equals({})
    expect(p.posts().map(sent => sent.query)).deep.equals([
      undefined,
      undefined
    ])
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
    expect(stored.priorPlaysDigest).equals('plays-D0')
    expect(stored.playsDigest).match(/^local-/)
    expect(stored.lineupsDigest).equals('D0')
    const document = p.document(eventsKey('g1'))!
    expect(document.pending).equals(1)
    expect(document.server_digest).equals('D0')
    expect(atBatsOf(document)).deep.equals([0, 1])
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
    // The send the drain made offline has failed by now.
    await p.client.drainOutbox()
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
    // The send the drain made offline has failed by now.
    await p.client.drainOutbox()
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
    await p.client.drainOutbox()
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
    await bare.client.drainOutbox()
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
    expect(one).not.have.property('publicName')
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

    // The send the drain made offline has failed by now.
    await p.client.drainOutbox()
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
    await p.client.drainOutbox()
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

  it('preserves an unchanged final marker unless an offline edit explicitly removes it', async () => {
    let online = true
    const p = phone(
      server({ '/games/g1/events': eventsDoc('g1', 'L0') }, () =>
        online ? { body: eventsDoc('g1', 'L0') } : 'offline'
      )
    )
    await p.client.gameEvents('g1')
    online = false
    await p.client.saveGameEvents('g1', {
      plays: [play(0), play(FINAL_INDEX)],
      remove: [],
      currentPlay: null,
      scoringMutation: { at: 1, id: 'final', revision: 0, frontier: 1 }
    })
    for (const removeFinal of [false, true]) {
      const before = await p.client.gameEvents('g1')
      await p.client.saveGameEvents('g1', {
        plays: [play(0)],
        remove: removeFinal ? [FINAL_INDEX] : [],
        currentPlay: null,
        scoringBase: before.scoringMutation,
        scoringMutation: {
          at: 2,
          id: `correction-${removeFinal}`,
          revision: 0,
          frontier: 1
        }
      })
      const stored = await p.client.gameEvents('g1')
      expect(
        stored.plays.some(row => row.about.atBatIndex === FINAL_INDEX)
      ).equals(!removeFinal)
    }
  })
  it('keeps an offline Undo from carrying its queued parent’s discarded tail', async () => {
    let online = false
    const p = phone(
      server({ '/games/g1/events': eventsDoc('g1', 'L0') }, () =>
        online ? { body: eventsDoc('g1', 'L0') } : 'offline'
      )
    )
    online = true
    await p.client.gameEvents('g1')
    online = false
    await p.client.saveGameEvents('g1', {
      plays: [play(0), play(1)],
      remove: [],
      currentPlay: null,
      scoringMutation: { at: 1, id: 'before-undo', revision: 0, frontier: 2 }
    })
    await p.client.saveGameEvents('g1', {
      plays: [play(0)],
      remove: [1],
      currentPlay: null,
      scoringMutation: { at: 2, id: 'undo-tail', revision: 0, frontier: 1 }
    })
    const child = JSON.parse(String(p.rows().at(-1)!.body)) as SaveChange
    expect(child.plays.map(play => play.about.atBatIndex)).deep.equals([0])
    expect(child.remove).deep.equals([1])
  })

  for (const childBase of ['L0', 'local-parent'])
    it(`keeps a superseded parent's lineup precondition for its child (${childBase})`, async function () {
      let online = true
      const bases: unknown[] = []
      const p = phone(
        server({ '/games/g1/events': eventsDoc('g1', 'L0') }, sent => {
          if (!online) return 'offline'
          const body = sent.body as SaveChange
          if (body.scoringMutation?.id === 'parent')
            return {
              body: {
                ...(eventsDoc('g1', 'coach') as object),
                superseded: true
              }
            }
          bases.push(body.lineupsBase)
          if (body.lineupsBase !== 'coach')
            return refusal(409, 'conflict', 'The coach changed the lineup', {
              stale: true
            })
          return { body: eventsDoc('g1', 'overwritten') }
        })
      )
      await p.client.gameEvents('g1')
      online = false
      for (const [id, base, at] of [
        ['parent', 'L0', 1],
        ['child', childBase, 3]
      ] as const)
        await p.client.saveGameEvents('g1', {
          plays: [],
          remove: [],
          currentPlay: null,
          lineupsBase: base,
          scoringMutation: { at, id, revision: 0, frontier: 0 }
        })
      if (childBase.startsWith('local-')) {
        // A persisted pre-normalization alias from an earlier queue writer.
        const child = p.rows().at(-1)!
        const body = {
          ...JSON.parse(String(child.body)),
          lineupsBase: childBase
        }
        executors
          .at(-1)!
          .db.prepare('UPDATE outbox SET body = ? WHERE id = ?')
          .run(JSON.stringify(body), String(child.id))
      }
      online = true
      p.client.wakeOutbox(true)
      await p.client.drainOutbox()
      expect(bases).deep.equals(['L0'])
      expect((await p.client.outboxSummary()).games.g1?.state).equals('parked')
    })

  it('keeps superseded on its acknowledgment, not the cached game or a later optimistic score', async function () {
    let online = true
    const p = phone(
      server({ '/games/g1/events': eventsDoc('g1', 'L0') }, () =>
        online
          ? {
              body: {
                ...(eventsDoc('g1', 'L1') as Record<string, unknown>),
                superseded: true
              }
            }
          : 'offline'
      )
    )
    await p.client.gameEvents('g1')
    const change: SaveChange = {
      plays: [],
      remove: [],
      currentPlay: { ...play(1), about: { atBatIndex: 1, isComplete: false } },
      scoringMutation: { at: 1, id: 'older', revision: 0, frontier: 1 }
    }
    const answer = await p.client.saveGameEvents('g1', change)
    expect(answer.superseded).equals(true)
    expect(bodyOf(p.document(eventsKey('g1'))!)).not.has.property('superseded')
    online = false
    const optimistic = await p.client.saveGameEvents('g1', {
      ...change,
      scoringMutation: { at: 2, id: 'newer', revision: 0, frontier: 1 }
    })
    expect(optimistic.superseded).equals(undefined)
    expect(optimistic.scoringMutation?.id).equals('newer')
  })

  it('answers a skipped optimistic write as superseded without poisoning its cache', async () => {
    let online = true
    const winner = { at: 3000, id: 'peer', revision: 1, frontier: 1 }
    const canonical = {
      ...(eventsDoc('g1', 'L0') as object),
      scoringMutation: winner
    }
    const p = phone(
      server({ '/games/g1/events': canonical }, () =>
        online ? { body: canonical } : 'offline'
      )
    )
    await p.client.gameEvents('g1')
    online = false
    const answer = await p.client.saveGameEvents('g1', {
      plays: [play(0)],
      remove: [],
      currentPlay: null,
      scoringBase: null,
      scoringMutation: { at: 2000, id: 'local', revision: 1, frontier: 1 }
    })
    expect(answer.superseded).equals(true)
    expect(answer.scoringMutation).deep.equals(winner)
    expect(bodyOf(p.document(eventsKey('g1'))!)).deep.equals(canonical)
    expect(p.rows()).has.length(1)
  })

  it('keeps a known winner visible for stale descendants regardless of their clocks', function () {
    const canonical = {
      plays: [],
      currentPlay: { ...play(0), count: { balls: 0, strikes: 1 } },
      scoringMutation: { at: 3, id: 'peer', revision: 0, frontier: 0 },
      playsDigest: 'canonical',
      superseded: true
    }
    const game = {
      gameId: 'g1',
      plays: 'local',
      lineups: null,
      newPlayId: () => 'unused'
    }
    const queued = {
      plays: [],
      currentPlay: { ...play(0), count: { balls: 2, strikes: 0 } },
      scoringBase: { at: 1, id: 'rejected-parent', revision: 0, frontier: 0 },
      scoringMutation: { at: 2, id: 'older-child', revision: 0, frontier: 0 }
    }
    const held = appliedEvents(canonical, queued, game)
    expect(held.currentPlay).deep.equals(canonical.currentPlay)
    expect(held.scoringMutation).deep.equals(canonical.scoringMutation)
    expect(held.playsDigest).equals('canonical')
    expect(held).not.has.property('superseded')
    const newer = appliedEvents(
      canonical,
      {
        ...queued,
        scoringMutation: { ...queued.scoringMutation, at: 4 }
      },
      game
    )
    expect((newer.currentPlay as GumboPlay).count).deep.equals(
      canonical.currentPlay.count
    )
    expect(newer.scoringMutation).deep.equals(canonical.scoringMutation)
    const sequential = appliedEvents(
      canonical,
      { ...queued, scoringBase: canonical.scoringMutation },
      game
    )
    expect((sequential.currentPlay as GumboPlay).count).deep.equals(
      queued.currentPlay.count
    )
    expect(sequential.scoringMutation).deep.equals(queued.scoringMutation)
  })

  it('preserves accepted ancestry and its tail against a displaced optimistic base', function () {
    const original = play(0)
    const competing = {
      ...play(0),
      result: { ...play(0).result, eventType: 'double' }
    }
    const applied = appliedEvents(
      {
        plays: [competing, play(1), play(2)].map((gumbo, i) => ({
          id: `row-${i}`,
          gumbo
        })),
        scoringMutation: { at: 2, id: 'peer', revision: 0, frontier: 3 }
      },
      {
        plays: [],
        currentPlay: null,
        scoringBase: null,
        scoringHistory: [original],
        scoringMutation: { at: 3, id: 'child', revision: 0, frontier: 1 }
      },
      {
        gameId: 'g1',
        plays: 'local-p',
        lineups: null,
        newPlayId: () => 'new-row'
      }
    )
    expect(
      (applied.plays as Array<{ id: string; gumbo: GumboPlay }>).map(row => ({
        id: row.id,
        event: row.gumbo.result.eventType
      }))
    ).deep.equals([
      { id: 'row-0', event: 'double' },
      { id: 'row-1', event: 'single' },
      { id: 'row-2', event: 'single' }
    ])
  })

  it('reconciles scoring when a guest rename is the last queued events writer', async () => {
    let online = true
    const p = phone(
      server({ '/games/g1/events': namedEvents() }, sent => {
        if (!online) return 'offline'
        if (sent.method === 'PUT') return { body: serverEntry(901, 'George') }
        return { body: { ...(namedEvents() as object), superseded: true } }
      })
    )
    const notices: OutboxNotice[] = []
    p.client.subscribeOutboxNotices(notice => notices.push(notice))
    await p.client.gameEvents('g1')
    online = false
    await p.client.saveGameEvents('g1', {
      plays: [play(1, 902)],
      remove: [],
      currentPlay: null,
      scoringMutation: { at: 1, id: 'losing', revision: 0, frontier: 2 }
    })
    await p.client.renameGuestPlayer(
      'g1',
      userIdOfGumbo(901),
      { firstName: 'George', lastName: 'Ruth' },
      901
    )
    expect(p.rows()).has.length(2)
    online = true
    p.client.wakeOutbox(true)
    await p.client.drainOutbox()
    expect(p.rows()).has.length(0)
    expect(p.document(eventsKey('g1'))!.pending).equals(0)
    expect(notices.some(notice => notice.reconcileScoring === true)).equals(
      true
    )
    expect(
      notices.find(notice => notice.reconcileScoring)?.rejectedScoring
    ).deep.equals({ at: 1, id: 'losing', revision: 0, frontier: 2 })
  })

  for (const refusal of [false, true])
    it(`persists rejected scoring through restart and queued renames (refused=${refusal})`, async () => {
      let online = true
      let renameOnline = false
      const p = phone(
        server({ '/games/g1/events': namedEvents() }, sent => {
          if (!online || (sent.method === 'PUT' && !renameOnline))
            return 'offline'
          if (sent.method === 'PUT')
            return refusal
              ? {
                  status: 400,
                  body: { code: 'badRequest', message: 'Rename refused' }
                }
              : { body: serverEntry(901, 'George') }
          return { body: { ...(namedEvents() as object), superseded: true } }
        })
      )
      const notices: OutboxNotice[] = []
      p.client.subscribeOutboxNotices(notice => notices.push(notice))
      await p.client.gameEvents('g1')
      online = false
      const rejected = { at: 1, id: 'losing', revision: 0, frontier: 2 }
      await p.client.saveGameEvents('g1', {
        plays: [play(1, 902)],
        remove: [],
        currentPlay: null,
        scoringMutation: rejected
      })
      for (const lastName of ['Ruth', 'Ruth Jr'])
        await p.client.renameGuestPlayer(
          'g1',
          userIdOfGumbo(901),
          { firstName: 'George', lastName },
          901
        )
      online = true
      p.client.wakeOutbox(true)
      await p.client.drainOutbox()
      expect(p.rows()).has.length(2)
      for (const row of p.rows())
        expect(JSON.parse(String(row.rejected_scoring))).deep.equals(rejected)
      expect(notices.filter(notice => notice.reconcileScoring)).has.length(0)
      await p.client.sessionRefused()
      p.client.openFor('usr_1')
      renameOnline = true
      p.client.wakeOutbox(true)
      await p.client.drainOutbox()
      expect(p.rows()).has.length(0)
      expect(notices.filter(notice => notice.reconcileScoring)).deep.equals([
        {
          gameId: 'g1',
          message: '',
          reconcileScoring: true,
          rejectedScoring: rejected
        }
      ])
      expect(
        p.sent
          .filter(sent => sent.method === 'PUT')
          .every(sent => !JSON.stringify(sent.body).includes('losing'))
      ).equals(true)
    })

  it('removes old response-only status when applying an optimistic score', function () {
    const applied = appliedEvents(
      { superseded: true },
      { plays: [], currentPlay: null },
      {
        gameId: 'g1',
        plays: 'local-p',
        lineups: null,
        newPlayId: () => 'local-row'
      }
    )
    expect(applied).not.has.property('superseded')
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
    await p.client.saveGameEvents('g1', {
      plays: [play(2)],
      remove: []
    })
    expect(atBatsOf(p.document(eventsKey('g1')))).deep.equals([0, 1, 2])
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
    // Sent from the queue too, it asks for no answer, so every play.
    expect(g1.map(call => call.query)).deep.equals([undefined, undefined])
    expect(p.rows().map(row => row.state)).deep.equals(['pending', 'pending'])
    expect(p.rows()[0].attempts).equals(1)
  })

  it('stores the first post’s answer and writes the second over it, pending until it lands, its reader’s names kept (Re-apply)', async function () {
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
            playsDigest: `server-${index}`,
            // Whom the poster reads in full, beside plays named for all.
            readerNames: { 7: 'Mookie Betts' }
          }
        }
      })
    )
    await p.client.gameEvents('g1')
    await p.client.saveGameEvents('g1', { plays: [play(1)], remove: [] })
    await p.client.saveGameEvents('g1', { plays: [play(2)], remove: [] })
    // The send the drain made offline has failed by now.
    await p.client.drainOutbox()
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
    expect(body.readerNames).deep.equals({ 7: 'Mookie Betts' })
    release!()
    await p.client.drainOutbox()
    const after = p.document(eventsKey('g1'))!
    expect(after.pending).equals(0)
    expect(JSON.parse(String(after.body)).playsDigest).equals('server-2')
    expect(JSON.parse(String(after.body)).readerNames).deep.equals({
      7: 'Mookie Betts'
    })
  })

  it('names a player the cached answer does not hold as the public reads him, his full name apart, from the rosters on the phone', async function () {
    const p = phone(
      server(
        {
          '/games/g1': { ...gameFixture, id: 'g1' },
          '/games/g1/events': eventsDoc('g1', 'D0', []),
          // The scorer reads 7 in full; 8 is told from a teammate he reads
          // in full by a letter the public reads, which his list does not.
          '/teams/home/roster': [
            {
              ...(serverEntry(7, 'Mookie') as object),
              shortName: 'Mookie Betts',
              nameFormat: 'full',
              compactName: 'Mookie B'
            },
            {
              ...(serverEntry(8, 'Matt') as object),
              shortName: 'Matt B',
              compactName: 'Matt Be'
            }
          ]
        },
        () => 'offline'
      )
    )
    await p.client.game('g1')
    await p.client.roster('home')
    await p.client.gameEvents('g1')
    await p.client.saveGameEvents('g1', {
      plays: [play(0), play(1, 8), play(2, 9)],
      remove: [],
      names: { 7: 'Mookie Betts', 8: 'Matt B', 9: 'Juan Soto' }
    })
    const body = JSON.parse(String(p.document(eventsKey('g1'))!.body))
    expect(
      body.plays.map(
        (row: { gumbo: GumboPlay }) => row.gumbo.matchup?.batter?.fullName
      )
    ).deep.equals(['Mookie B', 'Matt Be', 'Juan Soto'])
    expect(body.readerNames).deep.equals({ 7: 'Mookie Betts' })
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
    // The send the drain made offline has failed by now.
    await p.client.drainOutbox()
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
    // The send the drain made offline has failed by now.
    await p.client.drainOutbox()
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
    // The send the drain made offline has failed by now.
    await p.client.drainOutbox()
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
    // The send the drain made offline has failed by now.
    await p.client.drainOutbox()
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
    // The send the drain made offline has failed by now.
    await p.client.drainOutbox()
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
    // The send the drain made offline has failed by now.
    await p.client.drainOutbox()
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
        ? { body: reads[sent.path] }
        : await server409(sent)
    )
    await p.client.gameEvents('g1')
    await p.client.gameEvents('g2')
    await p.client.saveGameEvents('g1', { plays: [play(1)], remove: [] })
    await p.client.saveGameEvents('g1', { plays: [play(2)], remove: [] })
    await p.client.saveGameEvents('g2', { plays: [play(1)], remove: [] })
    // The send the drain made offline has failed by now.
    await p.client.drainOutbox()
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
    // The send the drain made offline has failed by now.
    await p.client.drainOutbox()
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
    // The send the drain made offline has failed by now.
    await p.client.drainOutbox()
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
    // The send the drain made offline has failed by now.
    await p.client.drainOutbox()
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
    // The send the drain made offline has failed by now.
    await p.client.drainOutbox()
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
    // The send the drain made offline has failed by now.
    await p.client.drainOutbox()
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
    // The send the drain made offline has failed by now.
    await p.client.drainOutbox()
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
    // The send the drain made offline has failed by now.
    await p.client.drainOutbox()
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
    await p.client.drainOutbox()
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
      if (sent.method === 'GET') return { body: served }
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
    // The send the drain made offline has failed by now.
    await p.client.drainOutbox()
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

  describe('a save of plays an older build queued', function () {
    /** A game's plays saved offline, then left as a build before `fold_version` left them. */
    async function queuedByOlderBuild(
      outbox: Pick<OutboxOptions, 'olderSave' | 'rebuildEvents'>,
      older = true,
      /** The game's plays as the server answers them once the signal is back. */
      served: unknown = eventsDoc('g1', 'D0'),
      /** The session log the save keeps beside it, as this build's do. */
      log?: SessionLog,
      legacyProtocol = false
    ): Promise<ReturnType<typeof phone>> {
      let online = false
      const reads: Record<string, unknown> = {
        '/games/g1/events': eventsDoc('g1', 'D0'),
        '/games/g1/lineups': lineupsDoc('D0'),
        '/games/g2/lineups': lineupsDoc('E0')
      }
      const p = phone(
        server(reads, sent => {
          if (!online) return 'offline'
          if (sent.path === '/me/roles')
            return { body: { teams: {}, guardianOf: [] } }
          return sent.path === '/games/g1/events'
            ? { body: eventsDoc('g1', 'D1', [play(0), play(1)]) }
            : { body: lineupsDoc('E1') }
        }),
        undefined,
        outbox
      )
      await p.client.gameEvents('g1')
      await p.client.gameLineups('g2')
      await p.client.saveGameEvents('g1', {
        plays: [play(1)],
        remove: [],
        currentPlay: null,
        lineupsBase: 'D0',
        generation: 3,
        ...(log == null ? {} : { log })
      })
      await p.client.saveLineups('g2', lineupSave('E0'))
      if (older)
        p.sql("UPDATE outbox SET fold_version = NULL WHERE game_id = 'g1'")
      if (legacyProtocol)
        p.sql(
          "UPDATE outbox SET body = json_remove(body, '$.scoringBase', '$.scoringMutation', '$.scoringHistory') WHERE game_id = 'g1'"
        )
      // Only what goes once the signal is back is counted.
      p.sent.splice(0)
      reads['/games/g1/events'] = served
      online = true
      p.client.wakeOutbox(true)
      await p.client.drainOutbox()
      return p
    }
    const sentEvents = (p: ReturnType<typeof phone>): Sent[] =>
      p
        .posts()
        .filter(call => call.path === '/games/g1/events' && call.key != null)
    const sentLineups = (p: ReturnType<typeof phone>): Sent[] =>
      p
        .posts()
        .filter(call => call.path === '/games/g2/lineups' && call.key != null)
    const indexes = (sent: Sent): number[] =>
      (sent.body as { plays: GumboPlay[] }).plays.map(
        gumbo => gumbo.about.atBatIndex
      )

    it('cuts off at the request deadline a judging read a give-up waits on, and gives the save up (2.harness-review.1)', async function () {
      let online = false
      let asked: AbortSignal | undefined
      const p = phone(
        server(
          {
            '/games/g1/events': eventsDoc('g1', 'D0'),
            '/games/g1/lineups': lineupsDoc('D0')
          },
          () => (online ? { body: eventsDoc('g1', 'D1') } : 'offline')
        ),
        undefined,
        {
          // A read of the server's plays that stalls mid-answer.
          olderSave: async (_gameId, _foldVersion, signal) => {
            asked = signal
            return await new Promise<boolean>((_resolve, reject) => {
              signal?.addEventListener('abort', () => {
                reject(new DOMException('Aborted', 'AbortError'))
              })
            })
          }
        }
      )
      await p.client.gameEvents('g1')
      await p.client.saveGameEvents('g1', {
        plays: [play(1)],
        remove: [],
        currentPlay: null,
        lineupsBase: 'D0',
        generation: 3
      })
      p.sql("UPDATE outbox SET fold_version = NULL WHERE game_id = 'g1'")
      // Only what goes once the signal is back is counted.
      p.sent.splice(0)
      online = true
      p.client.wakeOutbox(true)
      const draining = p.client.drainOutbox()
      const judging = (): boolean => asked != null
      for (let i = 0; i < 2000 && !judging(); i++)
        await new Promise(resolve => setTimeout(resolve, 1))
      expect(asked?.aborted).equals(false)
      const given = p.client.giveUpGame('g1')
      for (let i = 0; i < 20; i++)
        await new Promise(resolve => setTimeout(resolve, 1))
      p.timers
        .find(
          timer => timer.ms === REQUEST_DEADLINE_MS && timer.cleared !== true
        )!
        .run()
      // Never sent, it is given up and counted like any queued save.
      expect(await given).deep.equals({ lost: 1, unsure: 0 })
      expect(asked?.aborted).equals(true)
      await draining
      expect(p.rows()).deep.equals([])
      expect(p.posts().filter(call => call.key != null)).deep.equals([])
    })

    it('goes as it was queued where that build folded the game alike', async function () {
      const asked: Array<[string, number | null]> = []
      const p = await queuedByOlderBuild({
        olderSave: async (gameId, foldVersion) => {
          asked.push([gameId, foldVersion])
          return true
        }
      })
      expect(asked).deep.equals([['g1', null]])
      const sent = sentEvents(p)
      expect(sent).length(1)
      expect(indexes(sent[0])).deep.equals([1])
      expect(sent[0].body).deep.include({ lineupsBase: 'D0', generation: 3 })
      expect(sentLineups(p)).length(1)
      expect(p.rows()).deep.equals([])
    })

    it('sends a save this build queued with no judging', async function () {
      const asked: string[] = []
      const p = await queuedByOlderBuild(
        {
          olderSave: async gameId => {
            asked.push(gameId)
            return false
          }
        },
        false
      )
      expect(asked).deep.equals([])
      expect(indexes(sentEvents(p)[0])).deep.equals([1])
      expect(p.rows()).deep.equals([])
    })

    const held: Array<[string, Pick<OutboxOptions, 'olderSave'>]> = [
      ['folded it otherwise', { olderSave: async () => false }],
      [
        'cannot be judged',
        {
          olderSave: async () => {
            throw new Error('no game on the phone')
          }
        }
      ]
    ]
    for (const [what, outbox] of held)
      it(`holds the game, parked with why, where that build ${what}, and sends every other write`, async function () {
        const p = await queuedByOlderBuild(outbox)
        expect(sentEvents(p)).length(0)
        expect(
          p.rows().map(row => [row.game_id, row.state, row.message])
        ).deep.equals([['g1', 'parked', OLDER_SAVE_HELD]])
        expect(sentLineups(p)).length(1)
      })

    it('lets the phone judge by the game’s plays: held where the server kept an at-bat', async function () {
      const kept = {
        ...play(0),
        teamStation: {
          version: 2,
          actions: [{ type: 'gameFlow', kind: 'endHalf', keepAtBat: true }]
        }
      } as unknown as GumboPlay
      const p = await queuedByOlderBuild(
        {},
        true,
        eventsDoc('g1', 'D0', [kept])
      )
      expect(sentEvents(p)).length(0)
      expect(p.rows().map(row => [row.state, row.message])).deep.equals([
        ['parked', OLDER_SAVE_HELD]
      ])
      expect(sentLineups(p)).length(1)
    })

    it('lets the phone judge by the game’s plays: sent where nothing kept an at-bat', async function () {
      const p = await queuedByOlderBuild({})
      expect(indexes(sentEvents(p)[0])).deep.equals([1])
      expect(p.rows()).deep.equals([])
    })

    it('tries again later when the server cannot be read, and sends it then', async function () {
      let reachable = false
      const p = await queuedByOlderBuild({
        olderSave: async () => {
          if (!reachable)
            throw new HttpError(
              'offline',
              'Cannot reach TeamStation. Check your connection and try again.'
            )
          return true
        }
      })
      // No signal for one read is no signal for the rest: the queue waits.
      expect(sentEvents(p)).length(0)
      expect(p.rows().map(row => [row.game_id, row.state])).deep.equals([
        ['g1', 'pending'],
        ['g2', 'pending']
      ])
      expect(p.timers.length).greaterThan(0)
      reachable = true
      p.clock.now += 60_000
      p.client.wakeOutbox(true)
      await p.client.drainOutbox()
      expect(indexes(sentEvents(p)[0])).deep.equals([1])
      expect(sentLineups(p)).length(1)
      expect(p.rows()).deep.equals([])
    })

    const kept: SessionLog = {
      actions: [
        { type: 'pitch', call: 'B' },
        { type: 'pitch', call: 'C' }
      ],
      times: ['2026-11-09T18:00:00.000Z', null]
    }

    it('reconciles a persisted current-fold save missing its observed scoring base', async () => {
      const base = { at: 1, id: 'accepted', revision: 0, frontier: 0 }
      const mutation = { at: 2, id: 'rebuilt', revision: 0, frontier: 1 }
      let rebuilt = 0
      let judged = 0
      const p = await queuedByOlderBuild(
        {
          rebuildEvents: async (_gameId, log) => {
            expect(log).deep.equals(kept)
            rebuilt++
            return {
              plays: [play(0), play(1)],
              remove: [],
              currentPlay: null,
              scoringBase: base,
              scoringMutation: mutation,
              scoringHistory: [play(0)]
            }
          },
          olderSave: async () => {
            judged++
            return true
          }
        },
        false,
        eventsDoc('g1', 'D0'),
        kept,
        true
      )
      expect(rebuilt).equals(1)
      expect(judged).equals(0)
      expect(sentEvents(p)).length(1)
      expect(sentEvents(p)[0].body).deep.include({
        scoringBase: base,
        scoringMutation: mutation,
        generation: 3,
        lineupsBase: 'D0'
      })
      expect(sentEvents(p)[0].body).not.has.property('scoringHistory')
      expect(p.rows()).deep.equals([])
    })

    it('persists a new key for a verified legacy replay and reuses it after a lost response', async () => {
      let online = false
      let lost = true
      let rebuilt = 0
      const p = phone(
        server({ '/games/g1/events': eventsDoc('g1', 'D0') }, () => {
          if (!online) return 'offline'
          if (lost) {
            lost = false
            return 'offline'
          }
          return { body: eventsDoc('g1', 'D1') }
        }),
        undefined,
        {
          rebuildEvents: async () => {
            rebuilt++
            return {
              plays: [play(0)],
              remove: [],
              currentPlay: null,
              scoringBase: null,
              scoringMutation: {
                at: 2,
                id: 'replayed',
                revision: 0,
                frontier: 1
              }
            }
          }
        }
      )
      await p.client.gameEvents('g1')
      await p.client.saveGameEvents('g1', {
        plays: [play(0)],
        remove: [],
        log: kept
      })
      const oldKey = p.rows()[0].idempotency_key
      p.sql("UPDATE outbox SET body = json_remove(body, '$.scoringBase')")
      p.sent.splice(0)
      online = true
      p.client.wakeOutbox(true)
      await p.client.drainOutbox()
      const first = sentEvents(p)[0]
      expect(first.key).not.equals(oldKey)
      expect(p.rows()[0].idempotency_key).equals(first.key)
      p.client.wakeOutbox(true)
      await p.client.drainOutbox()
      expect(rebuilt).equals(1)
      expect(sentEvents(p)).length(2)
      expect(sentEvents(p)[1].key).equals(first.key)
      expect(sentEvents(p)[1].body).deep.equals(first.body)
      expect(p.rows()).deep.equals([])
    })

    for (const log of [undefined, kept])
      it(`retains legacy scoring ${log == null ? 'without a log' : 'with a conflicting log'} instead of sending an unverified base`, async () => {
        const p = await queuedByOlderBuild(
          {
            rebuildEvents: async () => null,
            olderSave: async () => true
          },
          false,
          eventsDoc('g1', 'D0'),
          log,
          true
        )
        expect(sentEvents(p)).length(0)
        expect(sentLineups(p)).length(1)
        expect(p.rows().map(row => [row.state, row.message])).deep.equals([
          ['parked', UNVERIFIED_SCORING_HELD]
        ])
        expect(JSON.parse(String(p.rows()[0].body))).not.have.property(
          'scoringBase'
        )
      })

    it('retains a legacy save when a replay callback provides no verified base', async () => {
      const p = await queuedByOlderBuild(
        {
          rebuildEvents: async () => ({ plays: [play(0)], remove: [] })
        },
        false,
        eventsDoc('g1', 'D0'),
        kept,
        true
      )
      expect(sentEvents(p)).length(0)
      expect(p.rows().map(row => row.state)).deep.equals(['parked'])
    })

    it('keeps the session log beside a queued save, never sent', async function () {
      const p = phone(
        server({ '/games/g1/events': eventsDoc('g1', 'D0') }, () => 'offline')
      )
      await p.client.gameEvents('g1')
      await p.client.saveGameEvents('g1', {
        plays: [play(1)],
        remove: [],
        log: kept
      })
      const [row] = p.rows()
      expect(JSON.parse(String(row.log))).deep.equals(kept)
      expect(row.fold_version).equals(FOLD_VERSION)
      expect(JSON.stringify(p.sent)).not.includes('2026-11-09T18:00:00.000Z')
    })

    it('sends a save that kept its log as the game folds once that log is played again', async function () {
      const asked: Array<[string, SessionLog]> = []
      let judged = 0
      const rebuilt: SaveChange = {
        plays: [play(0, 9), play(1, 8), play(2, 7)],
        remove: [5],
        currentPlay: null,
        fenceDistanceFt: 200,
        names: { '9': 'Ann Bee' }
      }
      const p = await queuedByOlderBuild(
        {
          rebuildEvents: async (gameId, log) => {
            asked.push([gameId, log])
            return rebuilt
          },
          olderSave: async () => {
            judged++
            return false
          }
        },
        true,
        eventsDoc('g1', 'D0'),
        kept
      )
      expect(asked).deep.equals([['g1', kept]])
      expect(judged).equals(0)
      const sent = sentEvents(p)
      expect(sent).length(1)
      expect(indexes(sent[0])).deep.equals([0, 1, 2])
      expect(sent[0].body).deep.include({
        mode: 'live',
        lineupsBase: 'D0',
        generation: 3,
        remove: [5],
        currentPlay: null,
        fenceDistanceFt: 200
      })
      expect(sentLineups(p)).length(1)
      expect(p.rows()).deep.equals([])
    })

    it('sends as it was queued a save whose log cannot be played again, where both builds fold the game alike', async function () {
      const p = await queuedByOlderBuild(
        { rebuildEvents: async () => null, olderSave: async () => true },
        true,
        eventsDoc('g1', 'D0'),
        kept
      )
      expect(indexes(sentEvents(p)[0])).deep.equals([1])
      expect(p.rows()).deep.equals([])
    })

    it('holds a save whose log cannot be played again in a game that kept an at-bat, parked with why', async function () {
      const p = await queuedByOlderBuild(
        { rebuildEvents: async () => null, olderSave: async () => false },
        true,
        eventsDoc('g1', 'D0'),
        kept
      )
      expect(sentEvents(p)).length(0)
      expect(p.rows().map(row => [row.state, row.message])).deep.equals([
        ['parked', OLDER_SAVE_HELD]
      ])
      expect(sentLineups(p)).length(1)
    })

    it('tries a rebuild again later when the server cannot be read', async function () {
      let reachable = false
      const p = await queuedByOlderBuild(
        {
          rebuildEvents: async () => {
            if (!reachable)
              throw new HttpError(
                'offline',
                'Cannot reach TeamStation. Check your connection and try again.'
              )
            return { plays: [play(0), play(1)], remove: [] }
          }
        },
        true,
        eventsDoc('g1', 'D0'),
        kept
      )
      expect(sentEvents(p)).length(0)
      expect(p.rows().map(row => row.state)).deep.equals(['pending', 'pending'])
      reachable = true
      p.clock.now += 60_000
      p.client.wakeOutbox(true)
      await p.client.drainOutbox()
      expect(indexes(sentEvents(p)[0])).deep.equals([0, 1])
      expect(p.rows()).deep.equals([])
    })

    it('lets the phone judge a save whose log it cannot play again for want of the game: sent where nothing kept an at-bat', async function () {
      const p = await queuedByOlderBuild({}, true, eventsDoc('g1', 'D0'), kept)
      expect(indexes(sentEvents(p)[0])).deep.equals([1])
      expect(p.rows()).deep.equals([])
    })

    it('lets the phone judge a save whose log it cannot play again for want of the game: held where the server kept an at-bat', async function () {
      const keptAtBat = {
        ...play(0),
        teamStation: {
          version: 2,
          actions: [{ type: 'gameFlow', kind: 'endHalf', keepAtBat: true }]
        }
      } as unknown as GumboPlay
      const p = await queuedByOlderBuild(
        {},
        true,
        eventsDoc('g1', 'D0', [keptAtBat]),
        kept
      )
      expect(sentEvents(p)).length(0)
      expect(p.rows().map(row => [row.state, row.message])).deep.equals([
        ['parked', OLDER_SAVE_HELD]
      ])
    })

    it('keeps only the newest log of a game, and rebuilds and sends the game once for all its older saves', async function () {
      let online = false
      const p = phone(
        server(
          {
            '/games/g1/events': eventsDoc('g1', 'D0'),
            '/games/g1/lineups': lineupsDoc('D0')
          },
          sent => {
            if (!online) return 'offline'
            if (sent.path === '/me/roles')
              return { body: { teams: {}, guardianOf: [] } }
            return { body: eventsDoc('g1', 'D1', [play(0), play(1)]) }
          }
        ),
        undefined,
        {
          rebuildEvents: async (gameId, log) => {
            asked.push([gameId, log])
            return { plays: [play(0), play(1), play(2)], remove: [] }
          }
        }
      )
      const asked: Array<[string, SessionLog]> = []
      const longer: SessionLog = {
        actions: [...kept.actions, { type: 'pitch', call: 'B' }],
        times: [...kept.times, null]
      }
      await p.client.gameEvents('g1')
      await p.client.saveGameEvents('g1', {
        plays: [play(1)],
        remove: [],
        log: kept
      })
      await p.client.saveGameEvents('g1', {
        plays: [play(1), play(2)],
        remove: [],
        log: longer
      })
      expect(p.rows().map(row => row.log)).deep.equals([
        null,
        JSON.stringify(longer)
      ])
      p.sql("UPDATE outbox SET fold_version = NULL WHERE game_id = 'g1'")
      p.sent.splice(0)
      online = true
      p.client.wakeOutbox(true)
      await p.client.drainOutbox()
      // The rebuilt game goes once, in the first save: it holds the second.
      expect(asked).deep.equals([['g1', longer]])
      expect(sentEvents(p).map(indexes)).deep.equals([[0, 1, 2]])
      expect(p.rows()).deep.equals([])
    })

    for (const code of ['notFound', 'forbidden', 'badRequest'] as const)
      it(`holds the save, parked, when the read that judges it is refused as ${code}`, async function () {
        const p = await queuedByOlderBuild(
          {
            rebuildEvents: async () => {
              throw new HttpError(code, 'Not found')
            }
          },
          true,
          eventsDoc('g1', 'D0'),
          kept
        )
        expect(
          p.rows().map(row => [row.game_id, row.state, row.message])
        ).deep.equals([['g1', 'parked', OLDER_SAVE_HELD]])
        expect(sentLineups(p)).length(1)
      })

    it('sends a rebuilt game in its last older save, after a lineup change queued between them', async function () {
      let online = false
      const p = phone(
        server(
          {
            '/games/g1/events': eventsDoc('g1', 'D0'),
            '/games/g1/lineups': lineupsDoc('D0')
          },
          sent => {
            if (!online) return 'offline'
            if (sent.path === '/me/roles')
              return { body: { teams: {}, guardianOf: [] } }
            return sent.path === '/games/g1/lineups'
              ? { body: lineupsDoc('D1') }
              : { body: eventsDoc('g1', 'D1', [play(0), play(1), play(2)]) }
          }
        ),
        undefined,
        {
          rebuildEvents: async () => ({
            plays: [play(0), play(1), play(2)],
            remove: []
          })
        }
      )
      await p.client.gameEvents('g1')
      await p.client.gameLineups('g1')
      await p.client.saveGameEvents('g1', {
        plays: [play(1)],
        remove: [],
        lineupsBase: 'D0',
        log: kept
      })
      await p.client.saveLineups('g1', lineupSave('D0'))
      await p.client.saveGameEvents('g1', {
        plays: [play(2)],
        remove: [],
        lineupsBase: 'after-lineups',
        log: kept
      })
      p.sql(
        "UPDATE outbox SET fold_version = NULL WHERE path = '/games/g1/events'"
      )
      p.sent.splice(0)
      online = true
      p.client.wakeOutbox(true)
      await p.client.drainOutbox()
      const posts = p
        .posts()
        .filter(call => call.key != null)
        .map(call => call.path)
      expect(posts).deep.equals(['/games/g1/lineups', '/games/g1/events'])
      const [rebuilt] = sentEvents(p)
      expect(indexes(rebuilt)).deep.equals([0, 1, 2])
      expect(rebuilt.body).deep.include({ lineupsBase: 'after-lineups' })
      expect(p.rows()).deep.equals([])
    })

    it('waits for its person to sign in again when the rebuild is refused as signed out, and holds nothing', async function () {
      let signedIn = false
      const p = await queuedByOlderBuild(
        {
          rebuildEvents: async () => {
            if (!signedIn)
              throw new HttpError('unauthorized', 'Sign in to continue')
            return { plays: [play(0), play(1)], remove: [] }
          }
        },
        true,
        eventsDoc('g1', 'D0'),
        kept
      )
      expect(sentEvents(p)).length(0)
      expect(p.rows().map(row => [row.game_id, row.state])).deep.equals([
        ['g1', 'pending'],
        ['g2', 'pending']
      ])
      // Signed in again: a new token, the same person's file.
      signedIn = true
      p.client.token = 'token-2'
      p.client.openFor('usr_1')
      await p.client.drainOutbox()
      expect(indexes(sentEvents(p)[0])).deep.equals([0, 1])
      expect(p.rows()).deep.equals([])
    })

    it('holds only the game, waiting for the update, when the rebuild is refused as too old', async function () {
      const p = await queuedByOlderBuild(
        {
          rebuildEvents: async () => {
            throw new HttpError(
              'unavailable',
              'Update TeamStation to keep scoring games.',
              { reason: 'updateRequired' }
            )
          }
        },
        true,
        eventsDoc('g1', 'D0'),
        kept
      )
      expect(sentEvents(p)).length(0)
      expect(p.rows().map(row => [row.game_id, row.state])).deep.equals([
        ['g1', 'pending']
      ])
      expect(sentLineups(p)).length(1)
    })

    it('reads nothing for a save that is not the session’s to send', async function () {
      let online = false
      const asked: string[] = []
      const p = phone(
        server({ '/games/g1/events': eventsDoc('g1', 'D0') }, () =>
          online ? { body: eventsDoc('g1', 'D1') } : 'offline'
        ),
        undefined,
        {
          rebuildEvents: async gameId => {
            asked.push(gameId)
            return null
          }
        }
      )
      await p.client.gameEvents('g1')
      await p.client.saveGameEvents('g1', {
        plays: [play(1)],
        remove: [],
        log: kept
      })
      p.sql("UPDATE outbox SET fold_version = NULL WHERE game_id = 'g1'")
      // Another person signs in while the queue reads the file.
      const store = await (
        p.client as unknown as {
          opened: { store: Promise<DocumentStore> }
        }
      ).opened.store
      const atomically = store.atomically.bind(store)
      let switching = true
      store.atomically = async work => {
        const answer = await atomically(work)
        if (switching) {
          switching = false
          p.client.token = 'token-other'
        }
        return answer
      }
      online = true
      p.client.wakeOutbox(true)
      await p.client.drainOutbox()
      expect(asked).deep.equals([])
      expect(p.rows().map(row => [row.state, row.message])).deep.equals([
        ['pending', null]
      ])
    })

    it('judges a held game again when its scorer tries again', async function () {
      let alike = false
      const p = await queuedByOlderBuild({ olderSave: async () => alike })
      expect(p.rows().map(row => row.state)).deep.equals(['parked'])
      alike = true
      await p.client.retryGame('g1')
      await p.client.drainOutbox()
      expect(indexes(sentEvents(p)[0])).deep.equals([1])
      expect(p.rows()).deep.equals([])
    })
  })

  it('queues a write sent at once and refused as too old to save, and holds only its game', async function () {
    const p = phone(
      server(
        {
          '/games/g1/lineups': lineupsDoc('D0'),
          '/games/g2/lineups': lineupsDoc('E0')
        },
        sent => {
          if (sent.path === '/me/roles')
            return { body: { teams: {}, guardianOf: [] } }
          if (sent.path.startsWith('/games/g1/'))
            return refusal(
              503,
              'unavailable',
              'Update TeamStation to keep scoring games.',
              { reason: 'updateRequired' }
            )
          return { body: lineupsDoc('E1') }
        }
      )
    )
    let told = 0
    p.client.onUpdateRequired = () => {
      told++
    }
    await p.client.gameLineups('g1')
    await p.client.gameLineups('g2')
    // Online, the save goes at once; refused, it waits on the phone.
    await p.client.saveLineups('g1', lineupSave('D0'))
    expect(told).equals(1)
    expect(p.rows().map(row => [row.chain, row.state])).deep.equals([
      ['game:g1', 'pending']
    ])
    await p.client.saveLineups('g2', lineupSave('E0'))
    p.client.wakeOutbox(true)
    await p.client.drainOutbox()
    const to = (game: string): number =>
      p
        .posts()
        .filter(
          call => call.key != null && call.path.startsWith(`/games/${game}/`)
        ).length
    expect(to('g1')).equals(1)
    expect(to('g2')).equals(1)
    expect(p.rows().map(row => [row.chain, row.state])).deep.equals([
      ['game:g1', 'pending']
    ])
  })

  it('holds only the game refused as too old to save, and sends every other write', async function () {
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
          if (sent.path.startsWith('/games/g1/'))
            return refusal(
              503,
              'unavailable',
              'Update TeamStation to keep scoring games.',
              { reason: 'updateRequired' }
            )
          return { body: lineupsDoc('E1') }
        }
      )
    )
    let told = 0
    p.client.onUpdateRequired = () => {
      told++
    }
    await p.client.gameLineups('g1')
    await p.client.gameLineups('g2')
    await p.client.saveLineups('g1', lineupSave('D0'))
    await p.client.saveLineups('g1', lineupSave('D0'))
    await p.client.saveLineups('g2', lineupSave('E0'))
    // What the calls tried before the signal came back is not counted.
    const offline = p.posts().length
    online = true
    p.client.wakeOutbox(true)
    await p.client.drainOutbox()
    const sentTo = (game: string): number =>
      p
        .posts()
        .slice(offline)
        .filter(
          call =>
            call.key != null &&
            call.method === 'POST' &&
            call.path.startsWith(`/games/${game}/`)
        ).length
    expect(told).equals(1)
    // The other game's write went; the refused game's wait, neither given up
    // nor held, for the update.
    expect(sentTo('g2')).equals(1)
    expect(p.rows().map(row => [row.chain, row.state])).deep.equals([
      ['game:g1', 'pending'],
      ['game:g1', 'pending']
    ])
    const refused = sentTo('g1')
    expect(refused).equals(1)
    p.client.wakeOutbox(true)
    await p.client.drainOutbox()
    expect(sentTo('g1')).equals(refused)
    expect(told).equals(1)
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
    await p.client.drainOutbox()
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
    await p.client.drainOutbox()
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
    // A 5xx is the game's own trouble: its chain waits on a backoff of its
    // own, from the first wait; a request that works ends neither.
    answer = refusal(500, 'internal', 'Something went wrong')
    p.clock.now += 20_000
    await p.client.drainOutbox()
    const wait = p.timers[p.timers.length - 1].ms
    expect(wait).equals(1000 * (1 + 0.5 * JITTER))
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
    await p.client.drainOutbox()
    expect(p.timers[p.timers.length - 1].ms).equals(1000 * (1 + 0.5 * JITTER))
  })

  /**
   * Lets the queue's own timers run, each when it is due, the clock moved to
   * it, until `ms` from now: nothing else wakes the queue.
   */
  async function timersOnly(
    p: ReturnType<typeof phone>,
    ms: number
  ): Promise<void> {
    const until = p.clock.now + ms
    const ran = new Set<number>()
    const rest = async (): Promise<void> => {
      for (let i = 0; i < 10; i++)
        await new Promise(resolve => setTimeout(resolve, 2))
    }
    await rest()
    for (;;) {
      const live = p.timers
        .map((timer, index) => ({ timer, index }))
        .filter(({ timer, index }) => timer.cleared == null && !ran.has(index))
        .sort((a, b) => a.timer.at + a.timer.ms - (b.timer.at + b.timer.ms))
      const next = live[0]
      if (next == null || next.timer.at + next.timer.ms > until) break
      ran.add(next.index)
      p.clock.now = Math.max(p.clock.now, next.timer.at + next.timer.ms)
      next.timer.run()
      await rest()
    }
  }

  it('sends a game’s write that a 5xx sent back on its own backoff, while another chain’s send holds a lease, with nothing else waking the queue (Q9)', async function () {
    let failing = true
    let landRoster: (() => void) | undefined
    const p = phone(
      server(
        {
          '/games/g1/lineups': lineupsDoc('D0'),
          '/teams/tem_home/roster': [],
          '/teams/tem_home/roster?includeFullNames=true': []
        },
        async sent => {
          if (sent.path === '/teams/tem_home/roster-players') {
            await new Promise<void>(resolve => {
              landRoster = resolve
            })
            return { status: 201, body: serverEntry(901, 'Jordan') }
          }
          if (failing)
            return refusal(500, 'internal', 'BadRequestError: request aborted')
          return { body: lineupsDoc('D1') }
        }
      )
    )
    await p.client.gameLineups('g1')
    await p.client.roster('tem_home')
    await p.client.roster('tem_home', { includeFullNames: true })
    // A roster add goes out at once and stays out, holding its chain.
    const adding = p.client.createRosterPlayer('tem_home', newPlayer('Jordan'))
    await new Promise(resolve => setTimeout(resolve, 20))
    expect(landRoster).not.equals(undefined)
    // The game's write is queued and its first send gets a 5xx.
    await p.client.saveLineups('g1', lineupSave('D0'))
    await p.client.drainOutbox()
    expect(p.posts().map(call => call.path)).deep.equals([
      '/teams/tem_home/roster-players',
      '/games/g1/lineups'
    ])
    expect(p.rows().map(row => row.chain)).includes('game:g1')
    // The server is back, and the roster add lands.
    failing = false
    landRoster!()
    await adding
    // Only the queue's own timers from here, for less than one lease.
    await timersOnly(p, BACKOFF_MS[0] * (1 + JITTER) + 1)
    expect(p.posts().map(call => call.path)).deep.equals([
      '/teams/tem_home/roster-players',
      '/games/g1/lineups',
      '/games/g1/lineups'
    ])
    expect(p.rows()).deep.equals([])
  })

  for (const [status, code] of [
    [429, 'rateLimited'],
    [503, 'unavailable']
  ] as const)
    it(`holds every chain on one backoff when the server asks the phone to slow down (${status}, 3.harness-review.6)`, async function () {
      let online = false
      let slow = true
      const p = phone(
        server(
          {
            '/games/g1/events': eventsDoc('g1', 'D0'),
            '/games/g2/events': eventsDoc('g2', 'E0')
          },
          sent => {
            if (!online) return 'offline'
            const gameId = sent.path.split('/')[2]
            // One game's send is asked to slow down.
            if (slow && gameId === 'g1')
              return refusal(status, code, 'Slow down')
            return { body: eventsDoc(gameId, `${gameId}-next`) }
          }
        )
      )
      const sentOf = (gameId: string): number =>
        p
          .posts()
          .filter(
            call => call.path === `/games/${gameId}/events` && call.key != null
          ).length
      await p.client.gameEvents('g1')
      await p.client.gameEvents('g2')
      // Offline: one save for each game queued.
      await p.client.saveGameEvents('g1', { plays: [play(1)], remove: [] })
      await p.client.saveGameEvents('g2', { plays: [play(1)], remove: [] })
      p.sent.splice(0)
      online = true
      p.clock.now += 60 * 60 * 1000
      p.client.wakeOutbox(true)
      await p.client.drainOutbox()
      // The first send was asked to slow down: the other game's waits too.
      expect([sentOf('g1'), sentOf('g2')]).deep.equals([1, 0])
      expect(p.rows()).has.length(2)
      // Once the wait is over and the server answers, both go.
      slow = false
      p.clock.now += 60 * 60 * 1000
      p.client.wakeOutbox(true)
      await p.client.drainOutbox()
      expect(p.rows()).deep.equals([])
    })

  it('keeps a failing game’s backoff its own, growing, while another game’s writes land beside it', async function () {
    const p = phone(
      server(
        {
          '/games/g1/events': eventsDoc('g1', 'D0'),
          '/games/g2/events': eventsDoc('g2', 'E0')
        },
        sent => {
          const gameId = sent.path.split('/')[2]
          if (gameId === 'g1') return refusal(500, 'internal', 'It broke')
          return { body: eventsDoc(gameId, `${gameId}-next`) }
        }
      )
    )
    const sentOf = (gameId: string): number =>
      p.posts().filter(call => call.path === `/games/${gameId}/events`).length
    const busy = async (): Promise<void> => {
      for (let i = 0; i < 3; i++) {
        await p.client.saveGameEvents('g2', {
          plays: [play(i + 1)],
          remove: []
        })
        await p.client.drainOutbox()
      }
    }
    await p.client.gameEvents('g1')
    await p.client.gameEvents('g2')
    await p.client.saveGameEvents('g1', { plays: [play(1)], remove: [] })
    await p.client.drainOutbox()
    expect(sentOf('g1')).equals(1)
    // The other game's sends land, and neither send the failing one again
    // at once nor end its wait.
    const before = sentOf('g2')
    await busy()
    expect(sentOf('g2')).equals(before + 3)
    expect(sentOf('g1')).equals(1)
    await timersOnly(p, BACKOFF_MS[0] * (1 + JITTER) + 1)
    expect(sentOf('g1')).equals(2)
    await busy()
    expect(sentOf('g1')).equals(2)
    // Its second wait is the second backoff, not the first again.
    await timersOnly(p, BACKOFF_MS[0] * (1 + JITTER) + 1)
    expect(sentOf('g1')).equals(2)
    await timersOnly(p, BACKOFF_MS[1] * (1 + JITTER) + 1)
    expect(sentOf('g1')).equals(3)
  })

  it('sends a game’s write a 5xx sent back once another send succeeds, its backoff passed, with nothing else waking the queue (Q9)', async function () {
    let failing = true
    const p = phone(
      server(
        {
          '/games/g1/events': eventsDoc('g1', 'D0'),
          '/games/g2/events': eventsDoc('g2', 'E0')
        },
        sent => {
          const gameId = sent.path.split('/')[2]
          if (gameId === 'g1' && failing)
            return refusal(503, 'unavailable', 'Back soon')
          return { body: eventsDoc(gameId, `${gameId}-next`) }
        }
      )
    )
    await p.client.gameEvents('g1')
    await p.client.gameEvents('g2')
    await p.client.saveGameEvents('g1', { plays: [play(1)], remove: [] })
    await p.client.drainOutbox()
    expect(p.rows()).length(1)
    failing = false
    // Another game's write lands: the skipped chain goes on its backoff.
    await p.client.saveGameEvents('g2', { plays: [play(1)], remove: [] })
    await timersOnly(p, BACKOFF_MS[0] * (1 + JITTER) + 1)
    expect(p.rows()).deep.equals([])
    expect(
      p
        .posts()
        .map(call => call.path)
        .filter(path => path === '/games/g1/events')
    ).length(2)
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
    // The send the drain made offline has failed by now.
    await p.client.drainOutbox()
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
    expect(entry).not.have.property('publicName')
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
    await p.client.drainOutbox()
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

  it('names a guest renamed offline by his own short name, the label the server stores, beside a player who shares it, and gives his halves only to his setup players', async function () {
    // Josh Smith bats second; the at-bat in progress holds both in its setup,
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
            902: setupPlayer(902, 'Josh S', 'Josh', 'Smith')
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
                matchup: { batter: { id: 902, fullName: 'Josh S' } }
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
      { firstName: 'Josh', lastName: 'Staumont' },
      901
    )
    const held = JSON.parse(String(p.document(eventsKey('g1'))!.body)) as {
      plays: Array<{ gumbo: GumboPlay }>
      currentPlay: Record<string, any>
    }
    // "Josh S" is Smith's too: each name is written alone, as the server does.
    expect(held.plays.map(row => row.gumbo.matchup?.batter)).deep.equals([
      { id: 901, fullName: 'Josh S' },
      { id: 902, fullName: 'Josh S' }
    ])
    expect(held.currentPlay.matchup.batter).deep.equals({
      id: 901,
      fullName: 'Josh S'
    })
    expect(held.currentPlay.teamStation.setupBefore.players).deep.equals({
      901: setupPlayer(901, 'Josh S', 'Josh', 'Staumont'),
      902: setupPlayer(902, 'Josh S', 'Josh', 'Smith')
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
    await p.client.drainOutbox()
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

  describe('written in the background (U36)', function () {
    const homeRoster = [serverEntry(201, 'Hawk'), serverEntry(202, 'Owl')]
    const gameDoc = { ...gameFixture, id: 'g1' }

    it('reads the kinds only a screen that does not wait queues, and on which chain', function () {
      // A foreground add of somebody who exists is not queued, as before.
      expect(
        queuedCallOf('POST', '/teams/t1/roster-players', { userId: 'usr_a' })
      ).equals(undefined)
      expect(
        queuedCallOf('POST', '/games/g1/guest-players', { side: 'home' })
      ).equals(undefined)
      expect(queuedCallOf('PUT', '/games/g1/unroster', {})).equals(undefined)
      const existing = queuedCallOf(
        'POST',
        '/teams/t1/roster-players',
        { userId: 'usr_a' },
        { usr_a: 'Mookie B' },
        true
      )!
      expect(existing).deep.include({ kind: 'existingPlayer', teamId: 't1' })
      expect(chainOf(existing)).equals('team:t1')
      const pool = queuedCallOf(
        'POST',
        '/games/g1/guest-players',
        { side: 'home', userId: 'usr_a' },
        undefined,
        true
      )!
      expect(pool).deep.include({ kind: 'existingPlayer', gameId: 'g1' })
      expect(chainOf(pool)).equals('game:g1')
      const guest = queuedCallOf(
        'POST',
        '/games/g1/guest-players',
        { side: 'home' },
        undefined,
        true
      )!
      expect(guest.kind).equals('guestPlayer')
      expect(chainOf(guest)).equals('game:g1')
      const unroster = queuedCallOf(
        'PUT',
        '/games/g1/unroster',
        {},
        undefined,
        true
      )!
      expect(unroster.kind).equals('unroster')
      expect(chainOf(unroster)).equals('game:g1')
      // A roster create, a lineup, a rename still read as they did.
      expect(
        queuedCallOf('POST', '/games/g1/lineups', {}, undefined, true)!.kind
      ).equals('lineups')
      expect(
        queuedCallOf(
          'PUT',
          '/games/g1/guest-players/usr_a',
          {},
          undefined,
          true
        )!.kind
      ).equals('guestRename')
      expect(
        queuedCallOf('POST', '/teams/t1/roster-players', {}, undefined, true)!
          .kind
      ).equals('roster')
      expect(
        queuedCallOf('GET', '/games/g1/unroster', {}, undefined, true)
      ).equals(undefined)
    })

    it('answers a lineup save at once while the server holds it, and lands it after', async function () {
      let release!: () => void
      const held = new Promise<void>(resolve => {
        release = resolve
      })
      const p = phone(
        server({ '/games/g1/lineups': lineupsDoc('D0') }, async () => {
          await held
          return { body: lineupsDoc('D1') }
        })
      )
      await p.client.gameLineups('g1')
      const saved = await p.client.saveLineups('g1', lineupSave('D0', [7]), {
        background: true
      })
      // The phone's answer, before the server has said anything.
      expect(saved.digest).match(/^local-/)
      expect(saved.home.current?.batters).deep.equals([
        { gumboId: 7, name: 'Player 0', jersey: '0' }
      ])
      expect(p.rows().map(row => row.background)).deep.equals([1])
      expect(p.document(lineupsKey('g1'))!.pending).equals(1)
      release()
      await p.client.drainOutbox()
      await p.client.drainOutbox()
      expect(p.rows()).deep.equals([])
      expect(p.document(lineupsKey('g1'))!.server_digest).equals('D1')
    })

    it('leaves a player off a game at once, from the phone’s rosters, and takes the server’s lists when it lands', async function () {
      let online = false
      const p = phone(
        server(
          {
            '/games/g1': gameDoc,
            '/teams/home/roster': homeRoster
          },
          sent => {
            if (!online) return 'offline'
            expect(sent.method).equals('PUT')
            return { body: { away: [], home: [202, 201] } }
          }
        )
      )
      await p.client.game('g1')
      await p.client.roster('home')
      const lists = await p.client.setRostered(
        'g1',
        { side: 'home', userId: userIdOfGumbo(201), rostered: false },
        { background: true }
      )
      expect(lists).deep.equals({ away: [], home: [201] })
      const held = p.document(gameKey('g1'))!
      expect(held.pending).equals(1)
      expect(JSON.parse(String(held.body)).unrostered).deep.equals(lists)
      const [row] = p.rows()
      expect(row).deep.include({
        method: 'PUT',
        chain: 'game:g1',
        path: '/games/g1/unroster',
        background: 1
      })
      // Put back: the phone's lists lose him again.
      expect(
        await p.client.setRostered(
          'g1',
          { side: 'home', userId: userIdOfGumbo(201), rostered: true },
          { background: true }
        )
      ).deep.equals({ away: [], home: [] })
      await p.client.drainOutbox()
      online = true
      p.clock.now += 60_000
      p.client.wakeOutbox(true)
      await p.client.drainOutbox()
      expect(p.rows()).deep.equals([])
      const landed = p.document(gameKey('g1'))!
      expect(landed.pending).equals(0)
      expect(JSON.parse(String(landed.body)).unrostered).deep.equals({
        away: [],
        home: [202, 201]
      })
    })

    it('refuses a player it cannot find on the phone, and sends nothing', async function () {
      const p = phone(
        server({ '/games/g1': gameDoc }, () => ({
          body: { away: [], home: [999] }
        }))
      )
      await p.client.game('g1')
      const before = p.sent.length
      let refused: unknown
      try {
        await p.client.setRostered(
          'g1',
          { side: 'home', userId: userIdOfGumbo(999), rostered: false },
          { background: true }
        )
      } catch (error) {
        refused = error
      }
      // Scoring has the game on the phone: a write it cannot answer from
      // there is not sent to wait on the server instead.
      expect(refused).property('code').equals('unavailable')
      expect(p.sent.slice(before)).deep.equals([])
      expect(p.rows()).deep.equals([])
    })

    it('makes a game-only player with a phone id, and sends a play naming him with the server’s once he lands', async function () {
      let online = false
      const p = phone(
        server({ '/games/g1/events': eventsDoc('g1', 'D0') }, sent => {
          if (!online) return 'offline'
          if (sent.path === '/games/g1/guest-players')
            return { status: 201, body: serverEntry(555, 'Babe') }
          return { body: eventsDoc('g1', 'D1') }
        })
      )
      await p.client.gameEvents('g1')
      const entry = await p.client.createGuestPlayer(
        'g1',
        'home',
        newPlayer('Babe'),
        'home',
        { background: true }
      )
      const localId = entry.gumboId!
      expect(localId).not.equals(555)
      expect(entry.shortName).equals('Babe B')
      await p.client.saveGameEvents('g1', {
        plays: [play(1, localId)],
        remove: []
      })
      const [create, post] = p.rows()
      expect(create).deep.include({
        id: `player-${localId}`,
        chain: 'game:g1',
        background: 1
      })
      expect(JSON.parse(String(post.depends_on))).deep.equals([
        `player-${localId}`
      ])
      // The tries made with no signal end before it comes back.
      await p.client.drainOutbox()
      online = true
      p.clock.now += 60_000
      p.client.wakeOutbox(true)
      await p.client.drainOutbox()
      await p.client.drainOutbox()
      expect(p.rows()).deep.equals([])
      const sentPost = p.posts().find(call => call.path === '/games/g1/events')!
      expect(
        (sentPost.body as { plays: GumboPlay[] }).plays[0].matchup?.batter?.id
      ).equals(555)
    })

    it('adds somebody who exists with the name the search gave, and lands him after the store is opened again', async function () {
      const p = phone(
        server(
          {
            '/teams/home/roster': homeRoster,
            '/teams/home/roster?includeFullNames=true': homeRoster
          },
          () => 'offline'
        )
      )
      await p.client.roster('home')
      await p.client.roster('home', { includeFullNames: true })
      const userId = userIdOfGumbo(777)
      const answer = await p.client.addExistingRosterPlayer(
        'home',
        { userId, jersey: '12', positions: ['SS'] },
        { background: true, deviceNames: { [userId]: 'Mookie B' } }
      )
      expect('entry' in answer).equals(true)
      const entry = (answer as { entry: Record<string, unknown> }).entry
      expect(entry).deep.include({
        userId,
        shortName: 'Mookie B',
        jersey: '12',
        positions: ['SS']
      })
      const localId = entry.gumboId as number
      const [row] = p.rows()
      expect(row).deep.include({
        id: `player-${localId}`,
        chain: 'team:home',
        background: 1,
        names: JSON.stringify({ [userId]: 'Mookie B' })
      })
      expect(
        JSON.parse(String(p.document(rosterKey('home'))!.body)).map(
          (listed: { userId: string }) => listed.userId
        )
      ).includes(userId)
      // The next launch, online: the stored row is the same call.
      await p.client.drainOutbox()
      const again = phone(
        server({ '/teams/home/roster': homeRoster }, () => ({
          status: 201,
          body: { ...(serverEntry(777, 'Mookie') as object), userId }
        }))
      )
      again.clock.now += 60_000
      again.client.wakeOutbox(true)
      await again.client.drainOutbox()
      await again.client.drainOutbox()
      expect(again.posts().map(call => call.body)).deep.equals([
        { userId, jersey: '12', positions: ['SS'] }
      ])
      expect(again.rows()).deep.equals([])
      const roster = JSON.parse(
        String(again.document(fullRosterKey('home'))!.body)
      ) as Array<{ userId: string; gumboId: number }>
      expect(roster.filter(listed => listed.userId === userId)).deep.equals([
        { ...(serverEntry(777, 'Mookie') as object), userId }
      ])
    })

    it('keeps the public label beside a name the search gave in full', async function () {
      const p = phone(
        server(
          {
            '/teams/home/roster': homeRoster,
            '/teams/home/roster?includeFullNames=true': homeRoster
          },
          () => 'offline'
        )
      )
      await p.client.roster('home')
      await p.client.roster('home', { includeFullNames: true })
      const userId = userIdOfGumbo(777)
      // A coach of his reads him in full; everyone else reads Mookie B.
      const names = candidateNames({
        userId,
        gumboId: 777,
        externalIds: [],
        shortName: 'Mookie Betts',
        nameFormat: 'full',
        compactName: 'Mookie B',
        shortParts: { first: 'Mookie', last: 'Betts' },
        avatarUrl: null,
        bats: null,
        throws: null,
        teams: [],
        affiliations: '',
        tier: 'mine'
      })
      const answer = await p.client.addExistingRosterPlayer(
        'home',
        { userId, jersey: '12', positions: ['SS'] },
        { background: true, deviceNames: names }
      )
      const entry = (answer as { entry: Record<string, unknown> }).entry
      expect(entry).deep.include({
        userId,
        gumboId: 777,
        shortName: 'Mookie Betts',
        nameFormat: 'full',
        compactName: 'Mookie B'
      })
      expect(entry.compactFormat).equals(undefined)
      for (const key of [rosterKey('home'), fullRosterKey('home')])
        expect(
          JSON.parse(String(p.document(key)!.body)).find(
            (listed: { userId: string }) => listed.userId === userId
          )
        ).deep.include({ shortName: 'Mookie Betts', compactName: 'Mookie B' })
      // What leaves the reader takes the public label, as on the server's entry.
      const session = scoringSession(gameFixture)
      const id = addRosteredPlayer(
        session,
        'home',
        asRosterEntry({
          ...entry,
          role: 'member',
          section: 'player',
          staffRoles: [],
          inheritedFrom: null
        }),
        { ...emptyPlayerDraft(), firstName: 'Mookie', lastName: 'Betts' }
      )
      expect(
        shortPlayerNames(Object.values(session.gameData.players)).get(id)
      ).equals('Mookie B')
      // The body sent is the add alone.
      const [row] = p.rows()
      expect(JSON.parse(String(row.body))).deep.equals({
        userId,
        jersey: '12',
        positions: ['SS']
      })
    })

    it('keeps the gumbo id somebody who exists already has, and adds a pool player to the game', async function () {
      let online = false
      const p = phone(
        server({ '/games/g1': gameDoc }, () =>
          online
            ? {
                status: 201,
                body: { ...(serverEntry(888, 'Aaron') as object), pool: true }
              }
            : 'offline'
        )
      )
      await p.client.game('g1')
      const userId = userIdOfGumbo(888)
      const answer = await p.client.addExistingGuest(
        'g1',
        'home',
        { userId, jersey: null, positions: [] },
        'home',
        {
          background: true,
          deviceNames: { [userId]: 'Aaron J', '888': 'Aaron J' }
        }
      )
      expect((answer as { entry: Record<string, unknown> }).entry).deep.include(
        { gumboId: 888, pool: true, shortName: 'Aaron J' }
      )
      expect(p.rows().map(row => row.chain)).deep.equals(['game:g1'])
      // The send the drain made offline has failed by now.
      await p.client.drainOutbox()
      online = true
      p.client.wakeOutbox(true)
      await p.client.drainOutbox()
      expect(p.rows()).deep.equals([])
    })

    it('drops a lineup a later change on another device beat, without holding the game, and reads the server’s (newer)', async function () {
      let served = lineupsDoc('D0')
      const p = phone(async sent => {
        if (sent.method === 'GET') return { body: served, revision: '5' }
        served = lineupsDoc('D9')
        return refusal(409, 'conflict', 'Changed later on another device', {
          stale: true,
          newer: true
        })
      })
      await p.client.gameLineups('g1')
      const notices: OutboxNotice[] = []
      p.client.subscribeOutboxNotices(notice => notices.push(notice))
      await p.client.saveLineups(
        'g1',
        { ...lineupSave('D0'), changedAt: '2026-11-06T12:00:00.000Z' },
        { background: true }
      )
      await p.client.drainOutbox()
      expect(p.rows()).deep.equals([])
      // Said to the game's screens, which showed the save as made.
      expect(notices.filter(notice => !notice.reconcileScoring)).deep.equals([
        { gameId: 'g1', message: NEWER_LINEUP_MESSAGE }
      ])
      expect(await p.client.outboxSummary()).deep.equals({
        count: 0,
        chains: {},
        games: {},
        teams: {}
      })
      const doc = p.document(lineupsKey('g1'))!
      expect(doc.pending).equals(0)
      expect(doc.server_digest).equals('D9')
    })

    /** A phone whose events post is held at the server until released. */
    function heldPitch(
      answer: () => Answer = () => ({
        body: eventsDoc('g1', 'D1')
      })
    ): {
      p: ReturnType<typeof phone>
      release: () => void
      held: () => boolean
    } {
      let release: (() => void) | undefined
      const p = phone(
        server({ '/games/g1/events': eventsDoc('g1', 'D0') }, async sent => {
          // Only the first post is held; any after it is answered at once.
          if (sent.path === '/games/g1/events' && release == null) {
            await new Promise<void>(resolve => {
              release = resolve
            })
            return answer()
          }
          if (sent.path === '/games/g1/events')
            return { body: eventsDoc('g1', 'D2') }
          return { status: 201, body: serverEntry(555, 'Babe') }
        })
      )
      return {
        p,
        release: () => {
          release!()
        },
        held: () => release != null
      }
    }
    const whilePitchHeld = async (held: () => boolean): Promise<void> => {
      for (let tries = 0; !held() && tries < 100; tries++)
        await new Promise(resolve => setTimeout(resolve, 5))
      expect(held()).equals(true)
    }
    const writes = (p: ReturnType<typeof phone>): string[] =>
      p.sent.filter(call => call.method !== 'GET').map(call => call.path)

    it('answers a background add at once while a direct pitch post of its chain is in flight, and sends it after the pitch', async function () {
      const { p, release, held } = heldPitch()
      await p.client.gameEvents('g1')
      const pitch = p.client.saveGameEvents('g1', {
        plays: [play(1)],
        remove: []
      })
      await whilePitchHeld(held)
      // The add answers with the phone's entry, the pitch still out.
      const entry = await p.client.createGuestPlayer(
        'g1',
        'home',
        newPlayer('Babe'),
        'home',
        { background: true }
      )
      expect(entry.shortName).equals('Babe B')
      // An offline add carries no label: its tile is its id's colour.
      expect(entry).not.have.property('publicName')
      for (let tries = 0; tries < 10; tries++)
        await new Promise(resolve => setTimeout(resolve, 5))
      // One write of the chain in flight: the pitch.
      expect(writes(p)).deep.equals(['/games/g1/events'])
      release()
      await pitch
      await p.client.drainOutbox()
      expect(writes(p)).deep.equals([
        '/games/g1/events',
        '/games/g1/guest-players'
      ])
      expect(p.rows()).deep.equals([])
    })

    it('keeps the order calls were made in: a pitch post in flight, the next pitch, then a background add', async function () {
      const { p, release, held } = heldPitch()
      await p.client.gameEvents('g1')
      const first = p.client.saveGameEvents('g1', {
        plays: [play(1)],
        remove: []
      })
      await whilePitchHeld(held)
      const second = p.client.saveGameEvents('g1', {
        plays: [play(2)],
        remove: []
      })
      await p.client.createGuestPlayer(
        'g1',
        'home',
        newPlayer('Babe'),
        'home',
        { background: true }
      )
      release()
      await first
      await second
      for (let round = 0; round < 3; round++) await p.client.drainOutbox()
      const posts = p.sent.filter(call => call.method === 'POST')
      expect(
        posts.map(call =>
          call.path === '/games/g1/events'
            ? `pitch ${(call.body as { plays: GumboPlay[] }).plays[0].about.atBatIndex}`
            : 'add'
        )
      ).deep.equals(['pitch 1', 'pitch 2', 'add'])
      expect(p.rows()).deep.equals([])
    })

    it('refuses a background change with no answer of the phone’s at once, while a pitch post of its game is out', async function () {
      let release: (() => void) | undefined
      const p = phone(
        server({ '/games/g1/events': eventsDoc('g1', 'D0') }, async sent => {
          if (sent.path === '/games/g1/events') {
            await new Promise<void>(resolve => {
              release = resolve
            })
            return { body: eventsDoc('g1', 'D1') }
          }
          return { body: { away: [], home: [201] } }
        })
      )
      // The game itself is not on the phone: leaving a player off it has no
      // answer of the phone's.
      await p.client.gameEvents('g1')
      // The pitch goes to the server at once, and is held there.
      const pitched = p.client.saveGameEvents('g1', {
        plays: [play(1)],
        remove: []
      })
      const held = (): boolean => release != null
      for (let tries = 0; !held() && tries < 100; tries++)
        await new Promise(resolve => setTimeout(resolve, 5))
      let refused: unknown
      try {
        await p.client.setRostered(
          'g1',
          { side: 'home', userId: userIdOfGumbo(201), rostered: false },
          { background: true }
        )
      } catch (error) {
        refused = error
      }
      expect(refused).property('code').equals('unavailable')
      expect(writes(p)).deep.equals(['/games/g1/events'])
      release!()
      await pitched
      await p.client.drainOutbox()
      expect(writes(p)).deep.equals(['/games/g1/events'])
      expect(p.rows()).deep.equals([])
    })

    it('keeps a direct pitch post that could not be answered ahead of a background write queued while it was out', async function () {
      const { p, release, held } = heldPitch(() => 'offline')
      await p.client.gameEvents('g1')
      const pitch = p.client.saveGameEvents('g1', {
        plays: [play(1)],
        remove: []
      })
      await whilePitchHeld(held)
      await p.client.createGuestPlayer(
        'g1',
        'home',
        newPlayer('Babe'),
        'home',
        { background: true }
      )
      release()
      await pitch
      expect(p.rows().map(row => row.path)).deep.equals([
        '/games/g1/events',
        '/games/g1/guest-players'
      ])
    })

    it('gives a placeholder the queued lineup save and live post that name somebody whose add waits on approval, and sends them after it', async function () {
      let online = false
      const p = phone(async sent => {
        if (sent.method === 'GET') {
          const reads: Record<string, unknown> = {
            '/games/g1': gameDoc,
            '/games/g1/events': eventsDoc('g1', 'D0'),
            '/games/g1/lineups': lineupsDoc('D0'),
            '/teams/home/roster': homeRoster,
            '/teams/home/roster?includeFullNames=true': homeRoster
          }
          return sent.path in reads
            ? { body: reads[sent.path], revision: '5' }
            : refusal(404, 'notFound', 'Not found')
        }
        if (!online) return 'offline'
        if (sent.path === '/teams/home/roster-players')
          return { status: 202, body: { pending: { requestId: 'req_1' } } }
        if (sent.path === '/games/g1/guest-players')
          return { status: 201, body: serverEntry(556, 'Placeholder') }
        if (sent.path === '/games/g1/lineups') return { body: lineupsDoc('D1') }
        return { body: eventsDoc('g1', 'D1') }
      })
      await p.client.game('g1')
      await p.client.gameEvents('g1')
      await p.client.gameLineups('g1')
      await p.client.roster('home')
      await p.client.roster('home', { includeFullNames: true })
      const notices: OutboxNotice[] = []
      p.client.subscribeOutboxNotices(notice => notices.push(notice))
      const userId = userIdOfGumbo(777)
      const answer = await p.client.addExistingRosterPlayer(
        'home',
        { userId, jersey: '12', positions: [] },
        { background: true, deviceNames: { [userId]: 'Mookie B' } }
      )
      const localId = (answer as { entry: { gumboId: number } }).entry.gumboId
      // He is put in the lineup and bats, both still on the phone.
      const save = lineupSave('D0', [localId])
      save.players[0].fullName = 'Mookie Betts'
      await p.client.saveLineups('g1', save, { background: true })
      await p.client.saveGameEvents('g1', {
        plays: [play(1, localId)],
        remove: []
      })
      await p.client.drainOutbox()
      online = true
      p.clock.now += 60_000
      p.client.wakeOutbox(true)
      for (let round = 0; round < 4; round++) await p.client.drainOutbox()
      // Everything scored went, after the placeholder was made.
      expect(p.rows()).deep.equals([])
      const sent = p.sent.filter(
        call =>
          call.method === 'POST' && call.path !== '/teams/home/roster-players'
      )
      expect(sent.map(call => call.path)).deep.equals([
        '/games/g1/guest-players',
        '/games/g1/lineups',
        '/games/g1/events'
      ])
      expect(sent[0].body).deep.include({
        side: 'home',
        firstName: 'HAWKS',
        lastName: 'A'
      })
      const lineup = sent[1].body as SaveLineupsBody
      expect(lineup.players[0]).deep.include({
        gumboId: 556,
        fullName: 'HAWKS A'
      })
      expect(
        (sent[2].body as { plays: GumboPlay[] }).plays[0].matchup?.batter?.id
      ).equals(556)
      for (const call of sent)
        expect(JSON.stringify(call.body)).not.match(/Mookie|Betts/)
      expect((await p.client.outboxSummary()).games).deep.equals({})
      expect(notices.filter(notice => !notice.reconcileScoring)).deep.equals([
        { gameId: 'g1', message: STAND_IN_MESSAGE, reread: true }
      ])
    })

    it('gives a placeholder the kept log naming somebody whose add waits on approval, on a save that does not name him, and rebuilds from it with the server’s ids', async function () {
      let online = false
      const rebuiltFrom: SessionLog[] = []
      const p = phone(
        async sent => {
          if (sent.method === 'GET') {
            const reads: Record<string, unknown> = {
              '/games/g1': gameDoc,
              '/games/g1/events': eventsDoc('g1', 'D0'),
              '/games/g1/lineups': lineupsDoc('D0'),
              '/teams/home/roster': homeRoster,
              '/teams/home/roster?includeFullNames=true': homeRoster
            }
            return sent.path in reads
              ? { body: reads[sent.path], revision: '5' }
              : refusal(404, 'notFound', 'Not found')
          }
          if (!online) return 'offline'
          if (sent.path === '/teams/home/roster-players')
            return { status: 202, body: { pending: { requestId: 'req_1' } } }
          if (sent.path === '/games/g1/guest-players')
            return { status: 201, body: serverEntry(556, 'Placeholder') }
          if (sent.path === '/games/g1/lineups')
            return { body: lineupsDoc('D1') }
          return { body: eventsDoc('g1', 'D1') }
        },
        undefined,
        {
          rebuildEvents: async (_gameId, log) => {
            rebuiltFrom.push(log)
            return { plays: [play(1, 556)], remove: [] }
          }
        }
      )
      await p.client.game('g1')
      await p.client.gameEvents('g1')
      await p.client.gameLineups('g1')
      await p.client.roster('home')
      await p.client.roster('home', { includeFullNames: true })
      const notices: OutboxNotice[] = []
      p.client.subscribeOutboxNotices(notice => notices.push(notice))
      const userId = userIdOfGumbo(777)
      const answer = await p.client.addExistingRosterPlayer(
        'home',
        { userId, jersey: '12', positions: [] },
        { background: true, deviceNames: { [userId]: 'Mookie B' } }
      )
      const localId = (answer as { entry: { gumboId: number } }).entry.gumboId
      // He is put in the lineup and bats, both still on the phone.
      const save = lineupSave('D0', [localId])
      save.players[0].fullName = 'Mookie Betts'
      await p.client.saveLineups('g1', save, { background: true })
      await p.client.saveGameEvents('g1', {
        plays: [play(1, localId)],
        remove: [],
        log: { actions: [], times: [] }
      })
      // The newest save names somebody else; only its kept log names him.
      await p.client.saveGameEvents('g1', {
        plays: [play(2, 7)],
        remove: [],
        log: {
          actions: [
            { type: 'baseRunning', kind: 'steal', runner: localId, to: '2B' }
          ],
          times: [null]
        }
      })
      // Queued by a build of an older fold.
      p.sql(
        "UPDATE outbox SET fold_version = NULL WHERE path = '/games/g1/events'"
      )
      await p.client.drainOutbox()
      online = true
      p.clock.now += 60_000
      p.client.wakeOutbox(true)
      for (let round = 0; round < 4; round++) await p.client.drainOutbox()
      // Rebuilt from the log as the placeholder holds it, by the server's id.
      expect(p.rows()).deep.equals([])
      expect(rebuiltFrom).deep.equals([
        {
          actions: [
            { type: 'baseRunning', kind: 'steal', runner: 556, to: '2B' }
          ],
          times: [null]
        }
      ])
      const events = p.sent.filter(
        call => call.method === 'POST' && call.path === '/games/g1/events'
      )
      expect(
        (events.at(-1)!.body as { plays: GumboPlay[] }).plays[0].matchup?.batter
          ?.id
      ).equals(556)
    })

    it('gives a placeholder the writes that name somebody with a gumbo id of his own whose add waits on approval', async function () {
      let online = false
      const p = phone(async sent => {
        if (sent.method === 'GET') {
          const reads: Record<string, unknown> = {
            '/games/g1': gameDoc,
            '/games/g1/events': eventsDoc('g1', 'D0'),
            '/games/g1/lineups': lineupsDoc('D0'),
            '/teams/home/roster': homeRoster,
            '/teams/home/roster?includeFullNames=true': homeRoster
          }
          return sent.path in reads
            ? { body: reads[sent.path], revision: '5' }
            : refusal(404, 'notFound', 'Not found')
        }
        if (!online) return 'offline'
        if (sent.path === '/teams/home/roster-players')
          return { status: 202, body: { pending: { requestId: 'req_1' } } }
        if (sent.path === '/games/g1/guest-players')
          return { status: 201, body: serverEntry(556, 'Placeholder') }
        if (sent.path === '/games/g1/lineups') return { body: lineupsDoc('D1') }
        return { body: eventsDoc('g1', 'D1') }
      })
      await p.client.game('g1')
      await p.client.gameEvents('g1')
      await p.client.gameLineups('g1')
      await p.client.roster('home')
      await p.client.roster('home', { includeFullNames: true })
      const notices: OutboxNotice[] = []
      p.client.subscribeOutboxNotices(notice => notices.push(notice))
      const userId = userIdOfGumbo(777)
      const answer = await p.client.addExistingRosterPlayer(
        'home',
        { userId, jersey: '12', positions: [] },
        {
          background: true,
          deviceNames: { [userId]: 'Mookie B', '777': 'Mookie B' }
        }
      )
      const localId = (answer as { entry: { gumboId: number } }).entry.gumboId
      expect(localId).equals(777)
      // He is put in the lineup and bats, both still on the phone.
      const save = lineupSave('D0', [localId])
      save.players[0].fullName = 'Mookie Betts'
      await p.client.saveLineups('g1', save, { background: true })
      await p.client.saveGameEvents('g1', {
        plays: [play(1, localId)],
        remove: []
      })
      await p.client.drainOutbox()
      online = true
      p.clock.now += 60_000
      p.client.wakeOutbox(true)
      for (let round = 0; round < 4; round++) await p.client.drainOutbox()
      // Everything scored went, after the placeholder was made.
      expect(p.rows()).deep.equals([])
      const sent = p.sent.filter(
        call =>
          call.method === 'POST' && call.path !== '/teams/home/roster-players'
      )
      expect(sent.map(call => call.path)).deep.equals([
        '/games/g1/guest-players',
        '/games/g1/lineups',
        '/games/g1/events'
      ])
      expect(sent[0].body).deep.include({
        side: 'home',
        firstName: 'HAWKS',
        lastName: 'A'
      })
      const lineup = sent[1].body as SaveLineupsBody
      expect(lineup.players[0]).deep.include({
        gumboId: 556,
        fullName: 'HAWKS A'
      })
      expect(
        (sent[2].body as { plays: GumboPlay[] }).plays[0].matchup?.batter?.id
      ).equals(556)
      for (const call of sent)
        expect(JSON.stringify(call.body)).not.match(/Mookie|Betts/)
      expect((await p.client.outboxSummary()).games).deep.equals({})
      expect(notices.filter(notice => !notice.reconcileScoring)).deep.equals([
        { gameId: 'g1', message: STAND_IN_MESSAGE, reread: true }
      ])
    })

    /** A phone with g1 and the home rosters read, and a way to answer the add. */
    async function knownAdd(
      add: () => Answer | Promise<Answer>,
      /** A player made on the phone first, whose create the server refuses. */
      blockTeam = false
    ): Promise<{ p: ReturnType<typeof phone>; notices: OutboxNotice[] }> {
      const p = phone(async sent => {
        if (sent.method === 'GET') {
          const reads: Record<string, unknown> = {
            '/games/g1': gameDoc,
            '/games/g1/events': eventsDoc('g1', 'D0'),
            '/games/g1/lineups': lineupsDoc('D0'),
            '/teams/home/roster': homeRoster,
            '/teams/home/roster?includeFullNames=true': homeRoster
          }
          return sent.path in reads
            ? { body: reads[sent.path], revision: '5' }
            : refusal(404, 'notFound', 'Not found')
        }
        if (sent.path === '/teams/home/roster-players')
          return (sent.body as { userId?: string }).userId == null
            ? refusal(400, 'invalid', 'firstName: Too long')
            : await add()
        if (sent.path === '/games/g1/guest-players')
          return { status: 201, body: serverEntry(556, 'Placeholder') }
        if (sent.path === '/games/g1/lineups') return { body: lineupsDoc('D1') }
        return { body: eventsDoc('g1', 'D1') }
      })
      await p.client.game('g1')
      await p.client.gameEvents('g1')
      await p.client.gameLineups('g1')
      await p.client.roster('home')
      await p.client.roster('home', { includeFullNames: true })
      const notices: OutboxNotice[] = []
      p.client.subscribeOutboxNotices(notice => notices.push(notice))
      if (blockTeam)
        await p.client.createRosterPlayer('home', newPlayer('Babe'), {
          background: true
        })
      const userId = userIdOfGumbo(777)
      await p.client.addExistingRosterPlayer(
        'home',
        { userId, jersey: '12', positions: [] },
        {
          background: true,
          deviceNames: { [userId]: 'Mookie B', '777': 'Mookie B' }
        }
      )
      await p.client.saveLineups('g1', lineupSave('D0', [777]), {
        background: true
      })
      await p.client.saveGameEvents('g1', {
        plays: [play(1, 777)],
        remove: []
      })
      return { p, notices }
    }
    const gamePosts = (p: ReturnType<typeof phone>): string[] =>
      p.sent
        .filter(
          call => call.method === 'POST' && call.path.startsWith('/games/')
        )
        .map(call => call.path)

    it('holds writes naming somebody added with a gumbo id of his own until his add lands', async function () {
      // His team's queue is held behind a player the server refused first.
      const { p } = await knownAdd(
        () => ({ status: 201, body: serverEntry(777, 'Mookie') }),
        true
      )
      for (let round = 0; round < 4; round++) await p.client.drainOutbox()
      // Nothing naming him has gone ahead of his add: each waits for it.
      expect(gamePosts(p)).deep.equals([])
      const rows = p.rows()
      const add = rows.find(
        row =>
          row.path === '/teams/home/roster-players' &&
          String(row.body).includes(userIdOfGumbo(777))
      )!
      for (const path of ['/games/g1/lineups', '/games/g1/events'])
        expect(
          JSON.parse(String(rows.find(row => row.path === path)!.depends_on)),
          path
        ).deep.equals([add.id])
    })

    it('gives a placeholder the writes naming somebody whose add of his own gumbo id is refused, and holds nothing', async function () {
      const { p, notices } = await knownAdd(() =>
        refusal(403, 'forbidden', 'You cannot add this player.')
      )
      for (let round = 0; round < 4; round++) await p.client.drainOutbox()
      expect(p.rows()).deep.equals([])
      expect(gamePosts(p)).deep.equals([
        '/games/g1/guest-players',
        '/games/g1/lineups',
        '/games/g1/events'
      ])
      const lineup = p.sent.find(
        call => call.method === 'POST' && call.path === '/games/g1/lineups'
      )!.body as SaveLineupsBody
      expect(lineup.players[0].gumboId).equals(556)
      expect(await p.client.outboxSummary()).deep.include({
        games: {},
        teams: {}
      })
      expect(notices.filter(notice => !notice.reconcileScoring)).deep.equals([
        {
          gameId: 'g1',
          message:
            'Not added: You cannot add this player. A placeholder plays for him in this game.',
          reread: true
        }
      ])
    })

    it('tells each landing’s notices once its own transaction commits, whatever lands beside it', async function () {
      let releasePitch: (() => void) | undefined
      // The add's landing is held between its writes and its commit.
      let holdLanding = false
      let releaseLanding: (() => void) | undefined
      const p = phone(
        server(
          {
            '/games/g1/events': eventsDoc('g1', 'D0'),
            '/teams/home/roster': homeRoster,
            '/teams/home/roster?includeFullNames=true': homeRoster
          },
          async sent => {
            if (sent.path === '/teams/home/roster-players') {
              holdLanding = true
              return { status: 202, body: { pending: { requestId: 'req_1' } } }
            }
            await new Promise<void>(resolve => {
              releasePitch = resolve
            })
            return { body: eventsDoc('g1', 'D1') }
          }
        ),
        store => ({
          ...store,
          atomically: async run =>
            await store.atomically(async tx => {
              const value = await run(tx)
              if (holdLanding) {
                holdLanding = false
                await new Promise<void>(resolve => {
                  releaseLanding = resolve
                })
              }
              return value
            })
        })
      )
      await p.client.gameEvents('g1')
      await p.client.roster('home')
      await p.client.roster('home', { includeFullNames: true })
      const notices: OutboxNotice[] = []
      p.client.subscribeOutboxNotices(notice => notices.push(notice))
      const pitch = p.client.saveGameEvents('g1', {
        plays: [play(1)],
        remove: []
      })
      const pitchHeld = (): boolean => releasePitch != null
      for (let tries = 0; !pitchHeld() && tries < 100; tries++)
        await new Promise(resolve => setTimeout(resolve, 5))
      const userId = userIdOfGumbo(777)
      await p.client.addExistingRosterPlayer(
        'home',
        { userId, jersey: null, positions: [] },
        { background: true, deviceNames: { [userId]: 'Mookie B' } }
      )
      const drained = p.client.drainOutbox()
      const landingHeld = (): boolean => releaseLanding != null
      for (let tries = 0; !landingHeld() && tries < 100; tries++)
        await new Promise(resolve => setTimeout(resolve, 5))
      // The pitch lands while the add's landing has yet to commit.
      releasePitch!()
      for (let tries = 0; tries < 10; tries++)
        await new Promise(resolve => setTimeout(resolve, 5))
      releaseLanding!()
      await pitch
      await drained
      expect(notices.filter(notice => !notice.reconcileScoring)).deep.equals([
        { teamId: 'home', message: PENDING_APPROVAL_MESSAGE }
      ])
    })

    it('takes back an add of somebody who exists that waits on approval, on the team’s rosters and on a game (202 pending)', async function () {
      let online = false
      const p = phone(
        server(
          {
            '/games/g1': gameDoc,
            '/teams/home/roster': homeRoster,
            '/teams/home/roster?includeFullNames=true': homeRoster
          },
          () =>
            online
              ? { status: 202, body: { pending: { requestId: 'req_1' } } }
              : 'offline'
        )
      )
      await p.client.game('g1')
      await p.client.roster('home')
      await p.client.roster('home', { includeFullNames: true })
      const notices: OutboxNotice[] = []
      p.client.subscribeOutboxNotices(notice => notices.push(notice))
      const member = userIdOfGumbo(777)
      await p.client.addExistingRosterPlayer(
        'home',
        { userId: member, jersey: '12', positions: [] },
        { background: true, deviceNames: { [member]: 'Mookie B' } }
      )
      const guest = userIdOfGumbo(778)
      await p.client.addExistingGuest(
        'g1',
        'home',
        { userId: guest, jersey: null, positions: [] },
        'home',
        { background: true, deviceNames: { [guest]: 'Aaron J' } }
      )
      const localPlayers = (): unknown[] =>
        executors.at(-1)!.db.prepare('SELECT * FROM local_players').all()
      expect(localPlayers()).length(2)
      await p.client.drainOutbox()
      online = true
      p.clock.now += 60_000
      p.client.wakeOutbox(true)
      await p.client.drainOutbox()
      await p.client.drainOutbox()
      expect(p.rows()).deep.equals([])
      // Nobody was added: the phone's entry and the ids it gave go.
      expect(localPlayers()).deep.equals([])
      for (const key of [rosterKey('home'), fullRosterKey('home')]) {
        const listed = JSON.parse(String(p.document(key)!.body)) as Array<{
          userId?: string
        }>
        expect(
          listed.map(entry => entry.userId),
          key
        ).deep.equals(listed.map((_, index) => userIdOfGumbo(201 + index)))
      }
      expect(notices.filter(notice => !notice.reconcileScoring)).deep.equals([
        { teamId: 'home', message: PENDING_APPROVAL_MESSAGE },
        { gameId: 'g1', message: PENDING_APPROVAL_MESSAGE }
      ])
    })

    it('refuses a background write of a game not on the phone, and lands another game’s beside it', async function () {
      // g1 is not on the phone, so leaving a player off it has no answer of
      // the phone's; g2 is.
      const p = phone(
        server(
          {
            '/games/g2': { ...gameFixture, id: 'g2' },
            '/teams/home/roster': homeRoster
          },
          () => ({ body: { away: [], home: [201] } })
        )
      )
      await p.client.game('g2')
      await p.client.roster('home')
      let refused: unknown
      try {
        await p.client.setRostered(
          'g1',
          { side: 'home', userId: userIdOfGumbo(201), rostered: false },
          { background: true }
        )
      } catch (error) {
        refused = error
      }
      expect(refused).property('code').equals('unavailable')
      await p.client.setRostered(
        'g2',
        { side: 'home', userId: userIdOfGumbo(201), rostered: false },
        { background: true }
      )
      await p.client.drainOutbox()
      expect(p.rows()).deep.equals([])
      expect(p.document(gameKey('g2'))!.pending).equals(0)
      expect(writes(p)).deep.equals(['/games/g2/unroster'])
    })

    it('sends a background write with no file to keep it in as a plain request', async function () {
      const client = new CachingClient({
        baseUrl: 'http://x/api/v1',
        fetch: async () =>
          new Response(JSON.stringify({ away: [], home: [3] })),
        openCache: async () => {
          throw new Error('no disk')
        }
      })
      client.openFor('usr_3')
      expect(
        await client.setRostered(
          'g1',
          { side: 'home', userId: userIdOfGumbo(3), rostered: false },
          { background: true }
        )
      ).deep.equals({ away: [], home: [3] })
    })
  })

  describe('scoring that never waits (M5)', function () {
    const tagged = (atBatIndex: number, tag: string | null): GumboPlay =>
      ({
        ...(play(atBatIndex) as object),
        tagTargets: {
          version: 1,
          play: { id: `target_${atBatIndex}`, signature: 's', tag },
          events: []
        }
      }) as unknown as GumboPlay
    const tagOf = (document: Record<string, unknown> | undefined): unknown =>
      (
        JSON.parse(String(document?.body)) as {
          plays: Array<{ gumbo: { tagTargets: { play: { tag: unknown } } } }>
        }
      ).plays[0].gumbo.tagTargets.play.tag
    /** Waits for `ready`, letting the drain run between looks. */
    const until = async (ready: () => boolean): Promise<void> => {
      for (let tries = 0; !ready() && tries < 200; tries++)
        await new Promise(resolve => setTimeout(resolve, 2))
    }

    it('gives a send of the queue the deadline: a send that never answers is no signal, and waits', async function () {
      const p = phone(
        server({ '/games/g1/lineups': lineupsDoc('D0') }, async () => {
          return await new Promise<Answer>(() => undefined)
        }),
        undefined,
        {},
        20
      )
      await p.client.gameLineups('g1')
      // Sent at once, it never answers: past the deadline it is queued as
      // sent, and the queue waits for the signal.
      await p.client.saveLineups('g1', lineupSave('D0'))
      await p.client.drainOutbox()
      expect(p.client.offline).equals(true)
      expect(p.rows().map(row => [row.state, row.attempts])).deep.equals([
        ['pending', 0]
      ])
    })

    it('lands a save whose first send committed after the deadline, when its retry overlapped it', async function () {
      // As the server's Idempotency-Key does: a request with a key already
      // committed is answered as it was, and one whose key is still being
      // written waits for it. There is no in-progress refusal.
      const committed = new Map<string, Answer>()
      const writing = new Map<string, Promise<void>>()
      let digest = 'D0'
      const p = phone(
        async sent => {
          if (sent.method === 'GET') return { body: lineupsDoc(digest) }
          const key = sent.key!
          const running = writing.get(key)
          if (running != null) await running
          const held = committed.get(key)
          if (held != null) return held
          let done!: () => void
          writing.set(
            key,
            new Promise<void>(resolve => {
              done = resolve
            })
          )
          // Committing well past the phone's deadline.
          await new Promise(resolve => setTimeout(resolve, 80))
          digest = 'D1'
          committed.set(key, { body: lineupsDoc('D1') })
          done()
          return committed.get(key)!
        },
        undefined,
        {},
        20
      )
      await p.client.gameLineups('g1')
      await p.client.saveLineups('g1', lineupSave('D0'))
      await p.client.drainOutbox()
      expect(p.client.offline).equals(true)
      // Sent again while the first is still being written: it waits too,
      // past the deadline, and is no signal again, never a refusal.
      p.client.wakeOutbox(true)
      await p.client.drainOutbox()
      expect(p.rows().map(row => row.state)).deep.equals(['pending'])
      await new Promise(resolve => setTimeout(resolve, 100))
      p.client.wakeOutbox(true)
      await p.client.drainOutbox()
      expect(p.rows()).deep.equals([])
      const posts = p.posts()
      expect(posts.length).greaterThanOrEqual(3)
      expect(new Set(posts.map(call => call.key)).size).equals(1)
      const doc = p.document(lineupsKey('g1'))!
      expect([doc.pending, doc.server_digest]).deep.equals([0, 'D1'])
      expect((await p.client.outboxSummary()).count).equals(0)
    })

    it('queues a swap only when asked, and sends Game Settings’ to the server', async function () {
      expect(queuedCallOf('POST', '/games/g1/swap-sides', {})).equals(undefined)
      expect(
        queuedCallOf(
          'POST',
          '/games/g%201/swap-sides',
          {},
          undefined,
          false,
          undefined,
          'swap'
        )
      ).deep.equals({
        kind: 'swapSides',
        gameId: 'g 1',
        path: '/games/g%201/swap-sides',
        body: {}
      })
      expect(
        queuedCallOf(
          'PUT',
          '/games/g1/swap-sides',
          {},
          undefined,
          false,
          undefined,
          'swap'
        )
      ).equals(undefined)
      const p = phone(
        server({ '/games/g1': { id: 'g1' } }, () => ({
          body: {
            homeTeamId: 'tem_away',
            awayTeamId: 'tem_home',
            generation: 0,
            reset: { atBats: 0, innings: 0 }
          }
        }))
      )
      const answer = await p.client.swapGameSides('g1', {
        homeTeamId: 'tem_home',
        awayTeamId: 'tem_away'
      })
      expect(answer.homeTeamId).equals('tem_away')
      expect(p.posts().map(call => [call.path, call.key])).deep.equals([
        ['/games/g1/swap-sides', undefined]
      ])
      expect(p.rows()).deep.equals([])
      // A swap the phone queues needs the game on the phone.
      let refused: unknown
      try {
        await p.client.queueSwap('g9', 'swap')
      } catch (error) {
        refused = error
      }
      expect(refused).property('code').equals('unavailable')
    })

    /**
     * A game's server: its sides, lineups and plays as the writes the phone
     * sends change them, and every request in the order it came.
     */
    function gameServer(
      options: {
        /** The swap's answer names the new sides' lineups digest. */
        swapDigest?: boolean
        /** Another device saves the lineups once the swap has landed. */
        otherDevice?: boolean
      } = {}
    ): {
      handler: Handler
      online: { value: boolean }
      refuse: { swap?: Answer }
      order: () => string[]
    } {
      const online = { value: false }
      const refuse: { swap?: Answer } = {}
      const log: string[] = []
      let swapped = false
      let generation = 1
      let plays = [play(0)]
      let digest = 'D0'
      const events = (): unknown => ({
        plays: plays.map((gumbo, index) => ({
          id: `e${index}`,
          gameId: 'g1',
          gumbo
        })),
        currentPlay: null,
        playsDigest: `plays-${plays.length}`,
        lineupsDigest: digest,
        generation
      })
      const game = (): unknown => ({
        ...gameFixture,
        id: 'g1',
        homeTeamId: swapped ? 'tem_away' : 'tem_home',
        awayTeamId: swapped ? 'tem_home' : 'tem_away',
        homeTeamName: swapped ? 'Away' : 'Home',
        awayTeamName: swapped ? 'Home' : 'Away',
        generation
      })
      const lineups = (): unknown => ({
        away: side(swapped ? 'tem_home' : 'tem_away'),
        home: side(swapped ? 'tem_away' : 'tem_home'),
        digest,
        generation
      })
      const handler: Handler = sent => {
        if (sent.method !== 'GET' && !online.value) return 'offline'
        log.push(`${sent.method} ${sent.path}`)
        if (sent.method === 'GET') {
          // Saved from the other device between the swap and the next read.
          if (options.otherDevice === true && digest === 'S1') digest = 'X1'
          if (sent.path === '/games/g1') return { body: game() }
          if (sent.path === '/games/g1/lineups') return { body: lineups() }
          if (sent.path === '/games/g1/events') return { body: events() }
          return refusal(404, 'notFound', 'Not found')
        }
        if (sent.path === '/games/g1/swap-sides') {
          if (refuse.swap != null) return refuse.swap
          const body = sent.body as Record<string, unknown>
          if (
            body.playsDigest !== `plays-${plays.length}` ||
            body.generation !== generation
          )
            return refusal(
              409,
              'conflict',
              "This game's plays changed. Open it again."
            )
          const lost = plays.length
          swapped = true
          plays = []
          generation++
          digest = 'S1'
          return {
            body: {
              homeTeamId: 'tem_away',
              awayTeamId: 'tem_home',
              generation,
              reset: { atBats: lost, innings: 1 },
              ...(options.swapDigest === true ? { lineupsDigest: digest } : {})
            }
          }
        }
        const body = sent.body as {
          plays: GumboPlay[]
          lineupsBase?: string
          generation?: number
        }
        if (body.lineupsBase != null && body.lineupsBase !== digest)
          return refusal(409, 'conflict', 'Somebody else changed the lineups', {
            stale: true
          })
        plays = [...plays, ...body.plays]
        return { body: events() }
      }
      return { handler, online, refuse, order: () => log }
    }

    it('sends a swap after the plays queued ahead of it, with their digest and generation, and reads the game again before the next write', async function () {
      const g = gameServer()
      const p = phone(g.handler)
      await p.client.game('g1')
      await p.client.gameLineups('g1')
      await p.client.gameEvents('g1')
      // Offline: a pitch, then Reset and Swap, then a pitch on the new sides.
      await p.client.saveGameEvents('g1', {
        plays: [play(1)],
        remove: [],
        lineupsBase: 'D0',
        generation: 1
      })
      const { answer, swapped } = await p.client.queueSwap('g1', 'reset')
      // The swapped game and plays it wrote, for the screen to open on.
      expect([swapped?.game.homeTeamId, swapped?.game.awayTeamId]).deep.equals([
        'tem_away',
        'tem_home'
      ])
      expect(swapped?.events.plays).deep.equals([])
      expect(swapped?.events.generation).equals(2)
      expect(answer).deep.equals({
        homeTeamId: 'tem_away',
        awayTeamId: 'tem_home',
        generation: 2,
        reset: { atBats: 2, innings: 1 }
      })
      // The phone's copy is swapped and reset at once, held until it lands.
      const game = p.document(gameKey('g1'))!
      expect(JSON.parse(String(game.body))).deep.include({
        homeTeamId: 'tem_away',
        generation: 2
      })
      expect(game.pending).equals(1)
      expect(atBatsOf(p.document(eventsKey('g1')))).deep.equals([])
      const local = JSON.parse(String(p.document(lineupsKey('g1'))!.body))
        .digest as string
      expect(local).match(/^local-/)
      await p.client.saveGameEvents('g1', {
        plays: [play(0, 9)],
        remove: [],
        lineupsBase: local,
        generation: 2
      })
      expect(p.rows().map(row => row.path)).deep.equals([
        '/games/g1/events',
        '/games/g1/swap-sides',
        '/games/g1/events'
      ])
      await p.client.drainOutbox()
      g.online.value = true
      p.client.wakeOutbox(true)
      await p.client.drainOutbox()
      const order = g.order()
      const swapAt = order.indexOf('POST /games/g1/swap-sides')
      expect(
        order.slice(0, swapAt).filter(line => line.startsWith('POST'))
      ).deep.equals(['POST /games/g1/events'])
      // Read again after the swap, before the next play is sent.
      const after = order.slice(swapAt + 1)
      const nextPost = after.indexOf('POST /games/g1/events')
      expect(new Set(after.slice(0, nextPost))).deep.equals(
        new Set([
          'GET /games/g1',
          'GET /games/g1/lineups',
          'GET /games/g1/events'
        ])
      )
      const sentSwap = p
        .posts()
        .find(call => call.path === '/games/g1/swap-sides')!
      // The digest and generation the play ahead of it answered.
      expect(sentSwap.body).deep.equals({
        homeTeamId: 'tem_home',
        awayTeamId: 'tem_away',
        playsDigest: 'plays-2',
        generation: 1
      })
      const last = p.posts()[p.posts().length - 1]
      expect(last.body).deep.include({ lineupsBase: 'S1', generation: 2 })
      expect(p.rows()).deep.equals([])
      for (const key of [gameKey('g1'), lineupsKey('g1'), eventsKey('g1')])
        expect(p.document(key)!.pending, key).equals(0)
      expect(JSON.parse(String(p.document(gameKey('g1'))!.body))).deep.include({
        homeTeamId: 'tem_away'
      })
    })

    it('builds the write after a swap on the digest the swap answered, so another device’s lineups since park it', async function () {
      const g = gameServer({ swapDigest: true, otherDevice: true })
      const p = phone(g.handler)
      await p.client.game('g1')
      await p.client.gameLineups('g1')
      await p.client.gameEvents('g1')
      await p.client.queueSwap('g1', 'reset')
      const local = JSON.parse(String(p.document(lineupsKey('g1'))!.body))
        .digest as string
      expect(local).match(/^local-/)
      await p.client.saveGameEvents('g1', {
        plays: [play(0, 9)],
        remove: [],
        lineupsBase: local,
        generation: 2
      })
      await p.client.drainOutbox()
      g.online.value = true
      p.client.wakeOutbox(true)
      await p.client.drainOutbox()
      // Read again after the swap, the other device's digest is the server's;
      // the play still names the swap's, and is refused as stale.
      expect(g.order()).includes('GET /games/g1/lineups')
      const last = p.posts()[p.posts().length - 1]
      expect(last.path).equals('/games/g1/events')
      expect(last.body).deep.include({ lineupsBase: 'S1', generation: 2 })
      expect(
        p.rows().map(row => [row.path, row.state, row.message])
      ).deep.equals([
        ['/games/g1/events', 'parked', 'Somebody else changed the lineups']
      ])
      expect((await p.client.outboxSummary()).games.g1.state).equals('parked')
    })

    it('sends a reset the file cannot queue with its digest and generation, and never its effect', async function () {
      const g = gameServer()
      let broken = false
      const p = phone(g.handler, store => ({
        ...store,
        atomically: async work => {
          if (broken) throw new Error('database is locked')
          return await store.atomically(work)
        }
      }))
      await p.client.game('g1')
      await p.client.gameLineups('g1')
      await p.client.gameEvents('g1')
      g.online.value = true
      broken = true
      const { answer } = await p.client.queueSwap('g1', 'reset')
      expect(answer).deep.include({ homeTeamId: 'tem_away', generation: 2 })
      const sentSwap = p
        .posts()
        .find(call => call.path === '/games/g1/swap-sides')!
      expect(sentSwap.body).deep.equals({
        homeTeamId: 'tem_home',
        awayTeamId: 'tem_away',
        playsDigest: 'plays-1',
        generation: 1
      })
      expect(sentSwap.key).equals(undefined)
    })

    it('sends a reset with the digest and generation of documents an earlier build stored, with no server copy column', async function () {
      const g = gameServer()
      const p = phone(g.handler)
      g.online.value = true
      await p.client.game('g1')
      await p.client.gameLineups('g1')
      await p.client.gameEvents('g1')
      // Stored before the server_body column: the upgrade left it NULL.
      p.sql('UPDATE documents SET server_body = NULL')
      expect(p.document(eventsKey('g1'))!.server_body).equals(null)
      g.online.value = false
      await p.client.queueSwap('g1', 'reset')
      g.online.value = true
      p.client.wakeOutbox(true)
      await p.client.drainOutbox()
      const sentSwap = p
        .posts()
        .find(call => call.path === '/games/g1/swap-sides')!
      expect(sentSwap.body).deep.equals({
        homeTeamId: 'tem_home',
        awayTeamId: 'tem_away',
        playsDigest: 'plays-1',
        generation: 1
      })
      expect(p.rows()).deep.equals([])
    })

    it('sends a reset the file cannot queue with the digest and generation an earlier build stored', async function () {
      const g = gameServer()
      let broken = false
      const p = phone(g.handler, store => ({
        ...store,
        atomically: async work => {
          if (broken) throw new Error('database is locked')
          return await store.atomically(work)
        }
      }))
      g.online.value = true
      await p.client.game('g1')
      await p.client.gameLineups('g1')
      await p.client.gameEvents('g1')
      p.sql('UPDATE documents SET server_body = NULL')
      broken = true
      await p.client.queueSwap('g1', 'reset')
      const sentSwap = p
        .posts()
        .find(call => call.path === '/games/g1/swap-sides')!
      expect(sentSwap.body).deep.include({
        playsDigest: 'plays-1',
        generation: 1
      })
    })

    it('prepares a body it sends without the file as the queue would', function () {
      expect(
        preparedWithoutStore(
          {
            kind: 'swapSides',
            gameId: 'g1',
            path: '/games/g1/swap-sides',
            body: {}
          },
          { homeTeamId: 'h', awayTeamId: 'a', effect: 'swap' }
        )
      ).deep.equals({ homeTeamId: 'h', awayTeamId: 'a' })
      const sides = { homeTeamId: 'h', awayTeamId: 'a' }
      expect(
        preparedWithoutStore(
          {
            kind: 'swapSides',
            gameId: 'g1',
            path: '/games/g1/swap-sides',
            body: {}
          },
          sides
        )
      ).equals(sides)
      const events = queuedCallOf('POST', '/games/g1/events', { mode: 'live' })!
      expect(
        preparedWithoutStore(events, { plays: [], lineupsBase: 'local-1' })
      ).deep.equals({ plays: [] })
      const kept = { plays: [], lineupsBase: 'D0' }
      expect(preparedWithoutStore(events, kept)).equals(kept)
      const lineups = queuedCallOf('POST', '/games/g1/lineups', {})!
      expect(lineups.kind).equals('lineups')
      expect(
        preparedWithoutStore(lineups, { away: {}, base: 'local-2' })
      ).deep.equals({ away: {}, base: '' })
      expect(preparedWithoutStore(lineups, 'raw')).equals('raw')
      const rename = queuedCallOf('PUT', '/games/g1/guest-players/7', {})!
      const named = { name: 'x' }
      expect(preparedWithoutStore(rename, named)).equals(named)
    })

    it('holds the game on a refused swap: a dead row, the held game’s notice', async function () {
      const g = gameServer()
      g.refuse.swap = refusal(
        409,
        'conflict',
        "This game's teams changed. Open it again."
      )
      const p = phone(g.handler)
      await p.client.game('g1')
      await p.client.gameLineups('g1')
      await p.client.gameEvents('g1')
      await p.client.queueSwap('g1', 'swap')
      g.online.value = true
      await p.client.drainOutbox()
      p.client.wakeOutbox(true)
      await p.client.drainOutbox()
      expect(
        p.rows().map(row => [row.path, row.state, row.message])
      ).deep.equals([
        [
          '/games/g1/swap-sides',
          'dead',
          "This game's teams changed. Open it again."
        ]
      ])
      expect((await p.client.outboxSummary()).games.g1).deep.equals({
        state: 'dead',
        message: "This game's teams changed. Open it again."
      })
      // Use Server's Copy gives it up and reads the server's sides back.
      expect(await p.client.discardGame('g1')).equals(true)
      expect(JSON.parse(String(p.document(gameKey('g1'))!.body))).deep.include({
        homeTeamId: 'tem_home'
      })
    })

    describe('behind a post of plays sent at once and not yet answered', function () {
      /**
       * A phone online whose first post of plays is held until `letGo`, and
       * then answered `answer`, or as `g` answers it; every other request
       * goes to `g`.
       */
      async function heldPost(
        options: {
          /** Sent in the post besides its play. */
          scoring?: Record<string, unknown>
          /**
           * The game's accepted scoring the server's events answer names
           * once set, or `'refused'`: the events read fails.
           */
          serverScoring?: { value?: unknown }
          /** Stands between the client and its file. */
          wrap?: (store: DocumentStore) => DocumentStore
          /** Told when a request misses its deadline or a give-up cuts it off. */
          onDeadlineMissed?: () => void
        } = {}
      ): Promise<{
        g: ReturnType<typeof gameServer>
        p: ReturnType<typeof phone>
        taken: () => boolean
        saving: Promise<unknown>
        letGo: (answer?: Answer) => void
        release: () => void
      }> {
        const g = gameServer()
        g.online.value = true
        const scoring = options.serverScoring
        let letGo!: (answer?: Answer) => void
        const gate = new Promise<Answer | undefined>(resolve => {
          letGo = resolve
        })
        let held = false
        const p = phone(
          async sent => {
            if (
              sent.path === '/games/g1/events' &&
              sent.method === 'POST' &&
              !held
            ) {
              held = true
              return (await gate) ?? (await g.handler(sent))
            }
            if (
              sent.method === 'GET' &&
              sent.path === '/games/g1/events' &&
              scoring?.value !== undefined
            ) {
              if (scoring.value === 'refused')
                return refusal(503, 'unavailable', 'Try again')
              const answer = await g.handler(sent)
              if (answer === 'offline') return answer
              return {
                body: {
                  ...(answer.body as Record<string, unknown>),
                  scoringMutation: scoring.value
                }
              }
            }
            const target = /^\/games\/g1\/tags\/(.+)$/.exec(sent.path)?.[1]
            if (target != null) {
              g.order().push(`${sent.method} ${sent.path}`)
              const { tag } = sent.body as { tag: string }
              return { body: { targetId: target, tag, revision: '5' } }
            }
            return await g.handler(sent)
          },
          options.wrap,
          {},
          undefined,
          options.onDeadlineMissed
        )
        await p.client.game('g1')
        await p.client.gameLineups('g1')
        await p.client.gameEvents('g1')
        const handed = { taken: false }
        let release!: () => void
        const saving = p.client
          .saveGameEvents(
            'g1',
            {
              plays: [play(1)],
              remove: [],
              lineupsBase: 'D0',
              generation: 1,
              ...options.scoring
            },
            {
              taken: () => {
                handed.taken = true
              },
              release: new Promise<void>(resolve => {
                release = resolve
              })
            }
          )
          .then(
            answer => ({ answer }),
            (error: unknown) => ({ error })
          )
        for (let i = 0; i < 2000 && !handed.taken; i++)
          await new Promise(resolve => setTimeout(resolve, 1))
        return { g, p, taken: () => handed.taken, saving, letGo, release }
      }
      /** The writes the phone sent, in order, answered or not. */
      const writes = (p: ReturnType<typeof phone>): string[] =>
        p.sent
          .filter(sent => sent.method !== 'GET')
          .map(sent => `${sent.method} ${sent.path}`)
      const states = (p: ReturnType<typeof phone>): string[][] =>
        p.rows().map(row => [String(row.path), String(row.state)])
      const events = (
        p: ReturnType<typeof phone>
      ): Array<{ gumbo: GumboPlay }> =>
        (
          JSON.parse(String(p.document(eventsKey('g1'))!.body)) as {
            plays: Array<{ gumbo: GumboPlay }>
          }
        ).plays

      it("writes a post refused while a swap's transaction runs before its requeue ahead once, and queues it in its place (3.harness-review.5)", async function () {
        const hold: { waiting: boolean; release?: () => void } = {
          waiting: false
        }
        let holdNext = false
        const wrap = (store: DocumentStore): DocumentStore => ({
          ...store,
          atomically: async work => {
            if (holdNext) {
              holdNext = false
              await new Promise<void>(resolve => {
                hold.waiting = true
                hold.release = resolve
              })
            }
            return await store.atomically(work)
          }
        })
        const { p, saving, letGo } = await heldPost({ wrap })
        // The post fails; its requeue's transaction waits behind the swap's.
        holdNext = true
        letGo('offline')
        const held = (): boolean => hold.waiting
        for (let i = 0; i < 2000 && !held(); i++)
          await new Promise(resolve => setTimeout(resolve, 1))
        expect(held()).equals(true)
        const swapping = p.client.queueSwap('g1', 'swap')
        for (let i = 0; i < 20; i++)
          await new Promise(resolve => setTimeout(resolve, 1))
        hold.release!()
        await swapping
        expect(await saving).to.have.property('answer')
        // Queued in its place, its write on the documents once, and nothing
        // left of it as a direct send written ahead.
        expect(states(p)).deep.equals([
          ['/games/g1/events', 'pending'],
          ['/games/g1/swap-sides', 'pending']
        ])
        expect(events(p).map(row => row.gumbo.about.atBatIndex)).deep.equals([
          0, 1
        ])
        const outbox = (
          p.client as unknown as {
            outbox: { ahead: Map<unknown, unknown>; direct: Set<unknown> }
          }
        ).outbox
        expect(outbox.ahead.size).equals(0)
        expect(outbox.direct.size).equals(0)
      })

      describe("when another device's swap or reset is accepted first (#260)", function () {
        const STALE = refusal(
          409,
          'conflict',
          'Somebody else changed the lineups since this game was read',
          { stale: true }
        )
        /** A second save, queued behind the post still out. */
        async function queueBehind(p: ReturnType<typeof phone>): Promise<void> {
          await p.client.saveGameEvents('g1', {
            plays: [play(2)],
            remove: [],
            lineupsBase: 'D0',
            generation: 1
          })
          expect(states(p)).deep.equals([
            ['/games/g1/events', 'inflight'],
            ['/games/g1/events', 'pending']
          ])
        }

        it('waits for the post in flight, sends nothing queued behind it, and gives up and counts the queued save once the post is refused as stale', async function () {
          const { p, saving, letGo } = await heldPost()
          await queueBehind(p)
          const given = p.client.giveUpGame('g1')
          // Woken while it is given up, the queue sends nothing of the game.
          await p.client.drainOutbox()
          expect(writes(p)).deep.equals(['POST /games/g1/events'])
          letGo(STALE)
          expect(await given).deep.equals({ lost: 1, unsure: 0 })
          // The session takes the refusal of its own post.
          expect(await saving).to.have.property('error')
          expect(p.rows()).deep.equals([])
          p.client.wakeOutbox(true)
          await p.client.drainOutbox()
          expect(writes(p)).deep.equals(['POST /games/g1/events'])
        })

        it('waits for the post in flight, and gives up the queued save behind it once the post lands before the swap', async function () {
          const { p, saving, letGo } = await heldPost()
          await queueBehind(p)
          const given = p.client.giveUpGame('g1')
          letGo()
          expect(await given).deep.equals({ lost: 1, unsure: 0 })
          expect(await saving).to.have.property('answer')
          expect(p.rows()).deep.equals([])
          await p.client.drainOutbox()
          expect(writes(p)).deep.equals(['POST /games/g1/events'])
        })

        it('waits for a post the session let go while its request is still out, and counts it only when the server did not take it', async function () {
          for (const taken of [true, false]) {
            const { g, p, saving, letGo, release } = await heldPost()
            // The link stalls: the post's request is out, and nothing else
            // gets through.
            g.online.value = false
            // The session moved on: the post is the queue's, sent as it was.
            release()
            expect(await saving).to.have.property('answer')
            expect(states(p)).deep.equals([['/games/g1/events', 'pending']])
            await p.client.saveGameEvents('g1', {
              plays: [play(2)],
              remove: [],
              lineupsBase: 'D0',
              generation: 1
            })
            let settled = false
            const given = p.client.giveUpGame('g1').then(count => {
              settled = true
              return count
            })
            await p.client.drainOutbox()
            await new Promise(resolve => setTimeout(resolve, 20))
            // Nothing is dropped while its request is out.
            expect(settled, `taken ${String(taken)}`).equals(false)
            expect(p.rows()).length(2)
            const writesBefore = writes(p).length
            letGo(taken ? { body: { plays: [] } } : STALE)
            expect(await given, `taken ${String(taken)}`).deep.equals({
              lost: taken ? 1 : 2,
              unsure: 0
            })
            expect(p.rows()).deep.equals([])
            g.online.value = true
            p.client.wakeOutbox(true)
            await p.client.drainOutbox()
            expect(writes(p).filter(w => w.endsWith('/events'))).length(
              writesBefore
            )
          }
        })

        it("waits for the drain's send of the game, and drops what is queued behind it", async function () {
          const g = gameServer()
          let letGo!: () => void
          const gate = new Promise<void>(resolve => {
            letGo = resolve
          })
          let sends = 0
          const p = phone(async sent => {
            if (
              sent.path === '/games/g1/events' &&
              sent.method === 'POST' &&
              g.online.value
            ) {
              sends++
              if (sends === 1) {
                await gate
                return STALE
              }
            }
            return await g.handler(sent)
          })
          await p.client.game('g1')
          await p.client.gameLineups('g1')
          await p.client.gameEvents('g1')
          // No signal: both saves queue on the phone.
          for (const index of [1, 2])
            await p.client.saveGameEvents('g1', {
              plays: [play(index)],
              remove: [],
              lineupsBase: 'D0',
              generation: 1
            })
          expect(p.rows()).length(2)
          g.online.value = true
          p.client.wakeOutbox(true)
          const draining = p.client.drainOutbox()
          const sent = (): number => sends
          for (let i = 0; i < 2000 && sent() === 0; i++)
            await new Promise(resolve => setTimeout(resolve, 1))
          expect(states(p)[0]).deep.equals(['/games/g1/events', 'inflight'])
          const given = p.client.giveUpGame('g1')
          letGo()
          await draining
          // The first was parked by its refusal, and goes with the second.
          expect(await given).deep.equals({ lost: 2, unsure: 0 })
          expect(p.rows()).deep.equals([])
          p.client.wakeOutbox(true)
          await p.client.drainOutbox()
          expect(sends).equals(1)
        })

        /** `giveUp`'s deadline timer, still set. */
        const deadlineOf = (
          p: ReturnType<typeof phone>
        ): { run: () => void } | undefined =>
          p.timers.find(
            timer => timer.ms === REQUEST_DEADLINE_MS && timer.cleared !== true
          )
        /** Lets the queue's promises and the file's writes go on. */
        const turns = async (): Promise<void> => {
          for (let i = 0; i < 20; i++)
            await new Promise(resolve => setTimeout(resolve, 1))
        }
        /** Whether the post of plays `p` sent first went with an aborted signal. */
        const firstPostAborted = (p: ReturnType<typeof phone>): boolean =>
          p.signals[
            p.sent.findIndex(
              sent => sent.method === 'POST' && sent.path === '/games/g1/events'
            )
          ]?.aborted === true

        it('gives up a post the session let go whose request never settles once the request deadline passes, counts it, and lets its late answer land nothing', async function () {
          const { g, p, saving, letGo, release } = await heldPost()
          g.online.value = false
          release()
          expect(await saving).to.have.property('answer')
          await p.client.saveGameEvents('g1', {
            plays: [play(2)],
            remove: [],
            lineupsBase: 'D0',
            generation: 1
          })
          g.online.value = true
          let settled = false
          const given = p.client.giveUpGame('g1').then(count => {
            settled = true
            return count
          })
          await p.client.drainOutbox()
          await turns()
          expect(settled).equals(false)
          expect(p.rows()).length(2)
          // The request deadline passes from when it was given up.
          deadlineOf(p)!.run()
          // Cut off with no answer, and no scoring identity for the
          // server's copy to tell it by: it may have been kept.
          expect(await given).deep.equals({ lost: 1, unsure: 1 })
          expect(firstPostAborted(p)).equals(true)
          expect(p.rows()).deep.equals([])
          const writesBefore = writes(p)
          const documents = p.document(eventsKey('g1'))
          const told = p.summaries.length
          // The server takes it after all: its answer is nobody's.
          letGo({ body: { plays: [] } })
          await turns()
          p.client.wakeOutbox(true)
          await p.client.drainOutbox()
          expect(p.rows()).deep.equals([])
          expect(writes(p)).deep.equals(writesBefore)
          expect(p.document(eventsKey('g1'))).deep.equals(documents)
          expect(p.summaries).length(told)
        })

        it('tells the client a request missed its deadline when the give-up cuts off a send with no answer, and not when nothing is cut off', async function () {
          let missed = 0
          const { p, saving, letGo } = await heldPost({
            onDeadlineMissed: () => {
              missed++
            }
          })
          await queueBehind(p)
          const given = p.client.giveUpGame('g1')
          await p.client.drainOutbox()
          await turns()
          expect(missed).equals(0)
          deadlineOf(p)!.run()
          await given
          await saving.catch(() => undefined)
          expect(missed).equals(1)
          // A give-up with nothing out cuts nothing off: the cut-off send's
          // late answer lands first.
          letGo({ body: { plays: [] } })
          await turns()
          const again = p.client.giveUpGame('g1')
          deadlineOf(p)?.run()
          await again
          expect(missed).equals(1)
        })

        it('gives up a post in flight that never settles once the request deadline passes, answers the session from the phone, and lets its late answer land nothing', async function () {
          const { p, saving, letGo } = await heldPost()
          await queueBehind(p)
          const given = p.client.giveUpGame('g1')
          await p.client.drainOutbox()
          await turns()
          expect(deadlineOf(p)).not.equals(undefined)
          deadlineOf(p)!.run()
          // Queued as sent, as at its own deadline, and given up with the
          // save behind it: both counted, the one cut off as unsure.
          expect(await given).deep.equals({ lost: 1, unsure: 1 })
          expect(await saving).to.have.property('answer')
          expect(firstPostAborted(p)).equals(true)
          expect(p.rows()).deep.equals([])
          const writesBefore = writes(p)
          const documents = p.document(eventsKey('g1'))
          const told = p.summaries.length
          letGo()
          await turns()
          p.client.wakeOutbox(true)
          await p.client.drainOutbox()
          expect(p.rows()).deep.equals([])
          expect(writes(p)).deep.equals(writesBefore)
          expect(p.document(eventsKey('g1'))).deep.equals(documents)
          expect(p.summaries).length(told)
        })

        it("gives up the drain's send of the game that never settles once the request deadline passes, and lets its late answer land nothing", async function () {
          const g = gameServer()
          let letGo!: () => void
          const gate = new Promise<void>(resolve => {
            letGo = resolve
          })
          let sends = 0
          const p = phone(async sent => {
            if (
              sent.path === '/games/g1/events' &&
              sent.method === 'POST' &&
              g.online.value
            ) {
              sends++
              if (sends === 1) {
                await gate
                return { body: { plays: [] } }
              }
            }
            return await g.handler(sent)
          })
          await p.client.game('g1')
          await p.client.gameLineups('g1')
          await p.client.gameEvents('g1')
          for (const index of [1, 2])
            await p.client.saveGameEvents('g1', {
              plays: [play(index)],
              remove: [],
              lineupsBase: 'D0',
              generation: 1
            })
          g.online.value = true
          p.client.wakeOutbox(true)
          const draining = p.client.drainOutbox()
          const sent = (): number => sends
          for (let i = 0; i < 2000 && sent() === 0; i++)
            await new Promise(resolve => setTimeout(resolve, 1))
          // The drain's send, the last request out.
          const held = p.signals[p.sent.length - 1]
          const given = p.client.giveUpGame('g1')
          await turns()
          deadlineOf(p)!.run()
          expect(await given).deep.equals({ lost: 1, unsure: 1 })
          await draining
          expect(held?.aborted).equals(true)
          expect(p.rows()).deep.equals([])
          const documents = p.document(eventsKey('g1'))
          const told = p.summaries.length
          letGo()
          await turns()
          p.client.wakeOutbox(true)
          await p.client.drainOutbox()
          expect(sends).equals(1)
          expect(p.rows()).deep.equals([])
          expect(p.document(eventsKey('g1'))).deep.equals(documents)
          expect(p.summaries).length(told)
        })

        it("cuts off at the request deadline the drain's read of the server's copy after a superseded answer, and gives the save up (1.harness-review.2)", async function () {
          const g = gameServer()
          let answered = false
          let letGo!: () => void
          const gate = new Promise<void>(resolve => {
            letGo = resolve
          })
          // A read after the answer stalls until its signal aborts it.
          const stalled = async (signal?: AbortSignal): Promise<void> => {
            await new Promise<void>((resolve, reject) => {
              signal?.addEventListener('abort', () => {
                reject(new DOMException('Aborted', 'AbortError'))
              })
              gate.then(resolve, reject)
            })
          }
          const p: ReturnType<typeof phone> = phone(
            async sent => {
              if (
                sent.path === '/games/g1/events' &&
                sent.method === 'POST' &&
                g.online.value
              ) {
                answered = true
                return { body: { plays: [], superseded: true } }
              }
              if (answered && sent.method === 'GET')
                await stalled(p.signals[p.signals.length - 1])
              return await g.handler(sent)
            },
            undefined,
            {},
            // The reads after the give-up get no answer either.
            200
          )
          await p.client.game('g1')
          await p.client.gameLineups('g1')
          await p.client.gameEvents('g1')
          await p.client.saveGameEvents('g1', {
            plays: [play(1)],
            remove: [],
            lineupsBase: 'D0',
            generation: 1,
            deviceLineupRecovery: {
              baseline: { generation: 1, plays: [] },
              context: {}
            } as unknown as LineupRecovery
          })
          g.online.value = true
          p.client.wakeOutbox(true)
          const draining = p.client.drainOutbox()
          const isAnswered = (): boolean => answered
          for (let i = 0; i < 2000 && !isAnswered(); i++)
            await new Promise(resolve => setTimeout(resolve, 1))
          await turns()
          // The read of the server's copy, the last request out.
          const read = p.signals[p.sent.length - 1]
          expect(p.sent[p.sent.length - 1].method).equals('GET')
          const given = p.client.giveUpGame('g1')
          await turns()
          deadlineOf(p)!.run()
          // Not kept on the closed game by the read: it is cut off. The
          // server answered the save, superseded, so it is lost, not unsure
          // (2.harness-review.3).
          expect(await given).deep.equals({ lost: 1, unsure: 0 })
          expect(read?.aborted).equals(true)
          await draining
          expect(p.rows()).deep.equals([])
          letGo()
        })

        it('judges a send answered before the request deadline by the server, as before, and stops its deadline', async function () {
          const { p, saving, letGo } = await heldPost()
          await queueBehind(p)
          const given = p.client.giveUpGame('g1')
          await turns()
          expect(deadlineOf(p)).not.equals(undefined)
          letGo(STALE)
          expect(await given).deep.equals({ lost: 1, unsure: 0 })
          expect(await saving).to.have.property('error')
          expect(deadlineOf(p)).equals(undefined)
          expect(firstPostAborted(p)).equals(false)
        })

        describe("settles a post cut off at the request deadline by the server's copy read after (9.harness-review.2)", function () {
          const BASE = { at: 1, id: 'base', revision: 0, frontier: 0 }
          const OWN = { at: 2, id: 'own', revision: 0, frontier: 1 }
          const OTHER = { at: 3, id: 'other', revision: 0, frontier: 1 }
          for (const { server, given, why } of [
            {
              server: OWN,
              given: { lost: 0, unsure: 0 },
              why: 'does not count a post the server committed'
            },
            {
              server: BASE,
              given: { lost: 1, unsure: 0 },
              why: 'counts as lost a post the server never took: its scoring is still what the post was built on'
            },
            {
              server: OTHER,
              given: { lost: 0, unsure: 1 },
              why: 'counts as unsure a post the server may have taken before another scoring was accepted'
            },
            {
              server: 'refused',
              given: { lost: 0, unsure: 1 },
              why: 'counts as unsure a post whose server copy did not come back'
            }
          ])
            it(why, async function () {
              const serverScoring: { value?: unknown } = {}
              const { p, saving, letGo } = await heldPost({
                scoring: {
                  currentPlay: null,
                  scoringBase: BASE,
                  scoringMutation: OWN
                },
                serverScoring
              })
              const settling = p.client.giveUpGame('g1')
              await turns()
              serverScoring.value = server
              deadlineOf(p)!.run()
              expect(await settling).deep.equals(given)
              expect(await saving).to.have.property('answer')
              expect(firstPostAborted(p)).equals(true)
              expect(p.rows()).deep.equals([])
              letGo()
            })

          it('counts as lost a post of an earlier generation: the reset took its plays either way', async function () {
            const serverScoring: { value?: unknown } = {}
            const { p, letGo } = await heldPost({
              scoring: {
                generation: 0,
                currentPlay: null,
                scoringMutation: OWN
              },
              serverScoring
            })
            const given = p.client.giveUpGame('g1')
            await turns()
            serverScoring.value = null
            deadlineOf(p)!.run()
            expect(await given).deep.equals({ lost: 1, unsure: 0 })
            letGo()
          })
        })

        it('answers none given up for a game with nothing queued', async function () {
          const p = phone(() => 'offline')
          expect(await p.client.giveUpGame('g1')).deep.equals({
            lost: 0,
            unsure: 0
          })
        })
      })

      it("says the post is the phone's before the server answers, queues a tag behind it at once with the post written first, and lands the answer under the tag", async function () {
        const { g, p, taken, saving, letGo } = await heldPost()
        expect(taken(), 'taken while the server holds it').equals(true)
        expect(states(p)).deep.equals([['/games/g1/events', 'inflight']])
        const tagged = await p.client.saveEventTag('g1', 'target_0', 'nice')
        expect(tagged).deep.include({ targetId: 'target_0', tag: 'nice' })
        expect(states(p)).deep.equals([
          ['/games/g1/events', 'inflight'],
          ['/games/g1/tags/target_0', 'pending']
        ])
        // The post went onto the phone's plays before the tag did.
        expect(events(p).map(row => row.gumbo.about.atBatIndex)).deep.equals([
          0, 1
        ])
        // Nothing goes past the post still out.
        await p.client.drainOutbox()
        expect(writes(p)).deep.equals(['POST /games/g1/events'])
        letGo()
        expect(await saving).to.have.property('answer')
        await p.client.drainOutbox()
        expect(p.rows()).deep.equals([])
        expect(writes(p)).deep.equals([
          'POST /games/g1/events',
          'PUT /games/g1/tags/target_0'
        ])
        expect(g.order()).include('PUT /games/g1/tags/target_0')
        expect(events(p).map(row => row.gumbo.about.atBatIndex)).deep.equals([
          0, 1
        ])
      })

      it("holds a swap queued behind the post when the server refuses the post: the refusal is the session's, and the swap waits behind the refused post", async function () {
        const { g, p, saving, letGo } = await heldPost()
        await p.client.queueSwap('g1', 'reset')
        expect(states(p)).deep.equals([
          ['/games/g1/events', 'inflight'],
          ['/games/g1/swap-sides', 'pending']
        ])
        letGo(refusal(409, 'conflict', "Another scorer's change came first"))
        const settled = (await saving) as { error?: unknown }
        expect(settled.error).instanceOf(HttpError)
        expect((settled.error as HttpError).message).equals(
          "Another scorer's change came first"
        )
        await p.client.drainOutbox()
        expect(states(p)).deep.equals([
          ['/games/g1/events', 'dead'],
          ['/games/g1/swap-sides', 'pending']
        ])
        expect(g.order()).not.include('POST /games/g1/swap-sides')
        expect((await p.client.outboxSummary()).games.g1?.state).equals('dead')
      })

      it('parks the post with the swap behind it when the server finds its lineups stale, and answers the session from the phone', async function () {
        const { g, p, saving, letGo } = await heldPost()
        await p.client.queueSwap('g1', 'reset')
        letGo(
          refusal(409, 'conflict', 'Somebody else changed the lineups', {
            stale: true
          })
        )
        expect(await saving).to.have.property('answer')
        await p.client.drainOutbox()
        // Parked as a queued post would be: the game is held, swap and all.
        expect(states(p)).deep.equals([
          ['/games/g1/events', 'parked'],
          ['/games/g1/swap-sides', 'parked']
        ])
        expect(g.order()).not.include('POST /games/g1/swap-sides')
      })

      it('queues the post as sent when it is not answered, with the swap behind it, and sends both in order', async function () {
        const { p, saving, letGo } = await heldPost()
        await p.client.queueSwap('g1', 'reset')
        letGo({ status: 503, body: { code: 'unavailable', message: 'Down' } })
        // The phone's answer: the post as it would land.
        expect(await saving).to.have.property('answer')
        expect(states(p)).deep.equals([
          ['/games/g1/events', 'pending'],
          ['/games/g1/swap-sides', 'pending']
        ])
        p.clock.now += 60_000
        p.client.wakeOutbox(true)
        await p.client.drainOutbox()
        expect(p.rows()).deep.equals([])
        expect(writes(p)).deep.equals([
          'POST /games/g1/events',
          'POST /games/g1/events',
          'POST /games/g1/swap-sides'
        ])
      })

      for (const behind of [false, true])
        it(`queues the post as sent once the session lets it go${behind ? ', with a swap behind it' : ''}, answering from the phone, and sends it again under the same key`, async function () {
          const { p, saving, letGo, release } = await heldPost()
          if (behind) await p.client.queueSwap('g1', 'reset')
          release()
          expect(await saving).to.have.property('answer')
          expect(states(p)[0]).deep.equals(['/games/g1/events', 'pending'])
          // Let go, it is no sign of the network: it goes again at once.
          await p.client.drainOutbox()
          letGo()
          await p.client.drainOutbox()
          expect(p.rows()).deep.equals([])
          const posts = p.sent.filter(
            sent => sent.method === 'POST' && sent.path === '/games/g1/events'
          )
          expect(posts).length(2)
          expect(posts[1].key).equals(posts[0].key)
          expect(writes(p)).deep.equals([
            'POST /games/g1/events',
            'POST /games/g1/events',
            ...(behind ? ['POST /games/g1/swap-sides'] : [])
          ])
        })
    })

    /** The fixture's teams by side, and the same exchanged. */
    const FIXTURE_TEAMS = {
      away: { id: gameFixture.awayTeamId, name: gameFixture.awayTeamName },
      home: { id: gameFixture.homeTeamId, name: gameFixture.homeTeamName }
    }
    const SWAPPED_TEAMS = { away: FIXTURE_TEAMS.home, home: FIXTURE_TEAMS.away }
    const NINE = (from: number): number[] =>
      Array.from({ length: 9 }, (_, i) => from + i)

    /**
     * A game scored for real, as the server answers it (each record by side,
     * version 2): lineups saved with the Owls' (away, batting 1–9) confirmed
     * and the Hawks' (home, 10–18) unseen, a strikeout, then a ball.
     */
    async function recorded(): Promise<{
      plays: unknown[]
      currentPlay: unknown
    }> {
      const kept = memoryStore()
      const session = ScoringSession.start(
        kept,
        'g1',
        scoringSession(gameFixture)
      )
      expect(
        session.apply({
          type: 'lineup',
          kind: 'roster',
          setup: setupOf(session.state),
          confirmed: ['away'],
          unseen: ['home']
        }).problems
      ).deep.equals([])
      for (const call of ['C', 'C', 'C', 'B'] as const)
        expect(session.apply({ type: 'pitch', call }).problems).deep.equals([])
      await session.flush()
      const stored = kept.games.get('g1')!
      const wire = (play: unknown): unknown => playForWire(play, FIXTURE_TEAMS)
      return {
        plays: stored.plays.map(wire),
        currentPlay: wire(stored.currentPlay)
      }
    }

    /**
     * A phone that scored a pitch offline and queued `effect` behind it; the
     * link comes back for the pitch, and the swap is held by a 503.
     */
    async function pitchLandsSwapHeld(effect: 'swap' | 'reset'): Promise<{
      p: ReturnType<typeof phone>
      answered: { plays: unknown[]; currentPlay: unknown }
    }> {
      const answered = await recorded()
      let online = false
      const events = (body: {
        plays: unknown[]
        currentPlay: unknown
      }): Record<string, unknown> => ({
        plays: body.plays.map((gumbo, index) => ({
          id: `e${index}`,
          gameId: 'g1',
          gumbo
        })),
        currentPlay: body.currentPlay,
        playsDigest: `plays-${body.plays.length}`,
        lineupsDigest: 'D0',
        generation: 1
      })
      const handler: Handler = sent => {
        if (sent.method === 'GET') {
          if (sent.path === '/games/g1')
            return { body: { ...gameFixture, generation: 1 } }
          if (sent.path === '/games/g1/lineups')
            return {
              body: {
                away: side('away'),
                home: side('home'),
                digest: 'D0',
                generation: 1
              }
            }
          if (sent.path === '/games/g1/events')
            return { body: events({ plays: [], currentPlay: null }) }
          return refusal(404, 'notFound', 'Not found')
        }
        if (!online) return 'offline'
        if (sent.path === '/games/g1/swap-sides')
          return refusal(503, 'unavailable', 'Try again')
        return { body: events(answered) }
      }
      const p = phone(handler)
      await p.client.game('g1')
      await p.client.gameLineups('g1')
      await p.client.gameEvents('g1')
      await p.client.saveGameEvents('g1', {
        plays: [play(1)],
        remove: [],
        lineupsBase: 'D0',
        generation: 1
      })
      await p.client.queueSwap('g1', effect)
      online = true
      p.client.wakeOutbox(true)
      await p.client.drainOutbox()
      // The pitch landed; the swap is still queued over the server's answer.
      expect(p.rows().map(row => row.path)).deep.equals([
        '/games/g1/swap-sides'
      ])
      expect(JSON.parse(String(p.document(gameKey('g1'))!.body))).deep.include({
        homeTeamId: 'away',
        awayTeamId: 'home'
      })
      return { p, answered }
    }

    /** The stored events' plays and at-bat, by the swapped sides. */
    function storedBySide(p: ReturnType<typeof phone>): {
      plays: unknown[]
      currentPlay: unknown
    } {
      const held = p.document(eventsKey('g1'))!
      expect(held.pending).equals(1)
      const body = JSON.parse(String(held.body)) as {
        plays: Array<{ gumbo: unknown }>
        currentPlay: unknown
      }
      return {
        plays: body.plays.map(row => row.gumbo),
        currentPlay: body.currentPlay
      }
    }

    /** The scoring screen opened again from the phone's copy, by its sides. */
    async function reopened(
      p: ReturnType<typeof phone>
    ): Promise<ReturnType<typeof setupOf>> {
      const game = {
        ...gameFixture,
        homeTeamId: gameFixture.awayTeamId,
        awayTeamId: gameFixture.homeTeamId,
        homeTeamName: gameFixture.awayTeamName,
        awayTeamName: gameFixture.homeTeamName
      }
      const session = await ScoringSession.open(
        {
          load: async (gameId: string) => await p.client.gameEvents(gameId),
          save: async (gameId: string, change: SaveChange) =>
            await p.client.saveGameEvents(gameId, change)
        },
        'g1',
        {
          gamePk: 'g1',
          teams: SWAPPED_TEAMS,
          setup: setupOf(scoringSession(game))
        }
      )
      return setupOf(session.state)
    }

    it('re-applies a held swap over the plays that landed ahead of it with each team’s lineup on its new side', async function () {
      const { p, answered } = await pitchLandsSwapHeld('swap')
      const stored = storedBySide(p)
      expect(stored.plays.length).equals(answered.plays.length)
      for (const [i, gumbo] of stored.plays.entries()) {
        const before = recordOf(answered.plays[i], FIXTURE_TEAMS)!
        const after = recordOf(gumbo, SWAPPED_TEAMS)!
        expect(after.setupBefore.sides).deep.equals({
          away: before.setupBefore.sides.home,
          home: before.setupBefore.sides.away
        })
      }
      const first = recordOf(stored.plays[0], SWAPPED_TEAMS)!
      const [saved] = first.actions as Array<{
        type: string
        confirmed?: string[]
        unseen?: string[]
      }>
      expect(saved.type).equals('lineup')
      // The Owls confirmed theirs and are home now; the Hawks', unseen, away.
      expect(saved.confirmed).deep.equals(['home'])
      expect(saved.unseen).deep.equals(['away'])
      expect(
        recordOf(stored.currentPlay, SWAPPED_TEAMS)!.setupBefore.sides.away
          .battingOrder
      ).deep.equals(NINE(10))
      // Opened again from that copy, each team bats its own lineup.
      const setup = await reopened(p)
      expect(setup.sides.away.battingOrder).deep.equals(NINE(10))
      expect(setup.sides.home.battingOrder).deep.equals(NINE(1))
    })

    it('re-applies a held Reset and Swap over the plays that landed ahead of it, rewound to each team’s lineup on its new side', async function () {
      const { p } = await pitchLandsSwapHeld('reset')
      const stored = storedBySide(p)
      expect(stored.plays).deep.equals([])
      const pregame = recordOf(stored.currentPlay, SWAPPED_TEAMS)!
      expect(pregame.setupBefore.sides.away.battingOrder).deep.equals(NINE(10))
      expect(pregame.setupBefore.sides.home.battingOrder).deep.equals(NINE(1))
      const [saved] = pregame.actions as Array<{
        confirmed?: string[]
        unseen?: string[]
      }>
      expect(saved.confirmed).deep.equals(['home'])
      expect(saved.unseen).deep.equals(['away'])
      const setup = await reopened(p)
      expect(setup.sides.away.battingOrder).deep.equals(NINE(10))
      expect(setup.sides.home.battingOrder).deep.equals(NINE(1))
    })

    it('answers a tag from the phone, and sends it and its removal in order, the removal with no body', async function () {
      let online = false
      const p = phone(
        server(
          { '/games/g1/events': eventsDoc('g1', 'D0', [tagged(0, null)]) },
          sent =>
            online
              ? {
                  body: {
                    targetId: 'target_0',
                    tag: sent.method === 'DELETE' ? null : 'great catch',
                    revision: '7'
                  }
                }
              : 'offline'
        )
      )
      await p.client.gameEvents('g1')
      const put = await p.client.saveEventTag('g1', 'target_0', 'great catch')
      expect(put).deep.include({ targetId: 'target_0', tag: 'great catch' })
      expect(put.revision.length).greaterThan(1)
      expect(tagOf(p.document(eventsKey('g1')))).equals('great catch')
      const removed = await p.client.saveEventTag('g1', 'target_0', null)
      expect(removed).deep.include({ targetId: 'target_0', tag: null })
      // Each later than the last, so the screen keeps the newest.
      expect(removed.revision > put.revision).equals(true)
      expect(tagOf(p.document(eventsKey('g1')))).equals(null)
      expect(p.rows().map(row => [row.method, row.chain])).deep.equals([
        ['PUT', 'game:g1'],
        ['DELETE', 'game:g1']
      ])
      await p.client.drainOutbox()
      online = true
      p.client.wakeOutbox(true)
      await p.client.drainOutbox()
      const writes = p.sent.filter(call => call.key != null)
      expect(
        writes.map(call => [call.method, call.path, call.body]).slice(-2)
      ).deep.equals([
        ['PUT', '/games/g1/tags/target_0', { tag: 'great catch' }],
        ['DELETE', '/games/g1/tags/target_0', undefined]
      ])
      expect(p.rows()).deep.equals([])
      expect(p.document(eventsKey('g1'))!.pending).equals(0)
    })

    it('lists a tag it put on first among the stored recent tags, so the next editor offers it', async function () {
      const p = phone(
        server(
          {
            '/games/g1/events': eventsDoc('g1', 'D0', [tagged(0, null)]),
            // The server's copy, read before the tag lands, never has it.
            '/tags': {
              recent: ['diving stop', 'great catch'],
              popular: [{ tag: 'diving stop', count: 3 }]
            }
          },
          () => 'offline'
        )
      )
      await p.client.gameEvents('g1')
      await p.client.tagChoices()
      await p.client.saveEventTag('g1', 'target_0', '  Great   Catch ')
      // Taking a tag off lists nothing new.
      await p.client.saveEventTag('g1', 'target_0', null)
      const choices = await p.client.tagChoices({ storedFirst: true })
      expect(choices.recent).deep.equals(['great catch', 'diving stop'])
      expect(choices.popular).deep.equals([{ tag: 'diving stop', count: 3 }])
    })

    it('writes a tag queued behind a play onto that play’s answer once it lands', async function () {
      let online = false
      const p = phone(
        server(
          { '/games/g1/events': eventsDoc('g1', 'D0', [tagged(0, null)]) },
          sent => {
            if (!online) return 'offline'
            if (sent.path.includes('/tags/'))
              return {
                body: { targetId: 'target_0', tag: 'nice', revision: '8' }
              }
            return { body: eventsDoc('g1', 'D1', [tagged(0, null), play(1)]) }
          }
        )
      )
      await p.client.gameEvents('g1')
      await p.client.saveGameEvents('g1', { plays: [play(1)], remove: [] })
      await p.client.saveEventTag('g1', 'target_0', 'nice')
      await p.client.drainOutbox()
      online = true
      // The play lands first: the tag behind it is written over its answer.
      p.client.wakeOutbox(true)
      await until(() => p.rows().length < 2)
      expect(tagOf(p.document(eventsKey('g1')))).equals('nice')
      await p.client.drainOutbox()
      expect(p.rows()).deep.equals([])
      expect(tagOf(p.document(eventsKey('g1')))).equals('nice')
    })
  })
})
