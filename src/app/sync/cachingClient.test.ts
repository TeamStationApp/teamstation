import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { expect } from 'chai'

import { asPage, asSeasonGame, TeamStationClient } from '../../common/api'
import { userIdOfGumbo } from '../../common/userId'
import { nodeSqliteExecutor } from '../../test/nodeSqliteExecutor'
import { pageOf } from '../../test/pageOf'
import { cacheFileName, type DocumentStore, openCacheStore } from './cacheStore'
import { CachingClient, PREFETCH_CONCURRENCY } from './cachingClient'
import {
  candidatesKey,
  candidatesTeamOf,
  documentKeyOf,
  fallbackKeyOf,
  fullRosterKey,
  GAMES_ALL,
  GAMES_PAST,
  GAMES_UPCOMING_PAGE,
  GAMES_VIDEOS_PAGE,
  networkOnly,
  rosterKey
} from './documentKeys'
import {
  groupScope,
  ME_SCOPE,
  scheduleReadOf,
  scheduleWindow,
  seasonScope,
  teamScope
} from './scheduleReads'

/** A game as the server sent it, unread: the rows' own bodies. */
const asRawGame = (raw: unknown): { id: string } => raw as { id: string }

/** A GET through the client's protected request, its answer unread. */
async function rawRead(client: CachingClient, path: string): Promise<unknown> {
  return await (
    client as unknown as {
      request: (m: string, p: string, c: typeof asRawGame) => Promise<unknown>
    }
  ).request('GET', path, asRawGame)
}

const team = (id: string, name: string): Record<string, unknown> => ({
  id,
  name,
  shortName: null,
  logoPath: null,
  logoUrl: null,
  record: null,
  kind: 'full',
  seasonCategory: 'inSeason'
})

const rosterEntry = (gumbo: number, fullName?: string): unknown => ({
  userId: userIdOfGumbo(gumbo),
  shortName: 'Mookie B',
  jersey: '50',
  positions: [],
  isPlayer: true,
  role: 'player',
  section: 'player',
  staffRoles: [],
  inheritedFrom: null,
  ...(fullName == null
    ? {}
    : {
        nameDetails: {
          firstName: 'Mookie',
          lastName: 'Betts',
          displayName: fullName
        }
      })
})

const upcomingGame = (id: string, home: string, away: string): unknown => ({
  id,
  homeTeamId: home,
  awayTeamId: away,
  homeTeamName: 'Hawks',
  awayTeamName: 'Owls',
  homeTeamExternal: false,
  awayTeamExternal: away === 'tem_external',
  seasonId: null,
  startAt: '2026-10-22T18:00:00Z',
  venue: null,
  status: 'scheduled',
  homeScore: null,
  awayScore: null,
  ingestStatus: 'none',
  videoCount: 0
})

interface Answer {
  status?: number
  body: unknown
  /** The revision header a server sent before reads took none. */
  olderRevision?: string
}

/**
 * The server, answering each path from `routes`. `offline` makes every
 * request fail to leave the device, as `fetch` does with no signal.
 */
function server(routes: Record<string, Answer | undefined>): {
  fetch: typeof fetch
  calls: string[]
  offline: boolean
  inFlight: number
  most: number
  gate?: Promise<void>
} {
  const state = {
    calls: [] as string[],
    offline: false,
    inFlight: 0,
    most: 0,
    gate: undefined as Promise<void> | undefined,
    fetch: (async (url: unknown) => {
      const path = String(url).replace('http://x/api/v1', '')
      state.calls.push(path)
      if (state.offline) throw new TypeError('Load failed')
      state.inFlight++
      state.most = Math.max(state.most, state.inFlight)
      try {
        await Promise.resolve()
        if (state.gate != null) await state.gate
        const answer = routes[path] ?? {
          status: 404,
          body: { error: 'notFound', message: 'Not found' }
        }
        return new Response(JSON.stringify(answer.body), {
          status: answer.status ?? 200,
          headers:
            answer.olderRevision == null
              ? {}
              : { 'x-teamstation-revision': answer.olderRevision }
        })
      } finally {
        state.inFlight--
      }
    }) as unknown as typeof fetch
  }
  return state
}

describe('CachingClient', function () {
  let dir: string
  let opened: string[]
  let stores: Map<string, ReturnType<typeof nodeSqliteExecutor>>

  beforeEach(function () {
    dir = mkdtempSync(join(tmpdir(), 'teamstation-client-'))
    opened = []
    stores = new Map()
  })
  afterEach(function () {
    rmSync(dir, { recursive: true, force: true })
  })

  const openCache = async (userId: string): Promise<DocumentStore> => {
    opened.push(userId)
    const executor = nodeSqliteExecutor(join(dir, cacheFileName(userId)))
    stores.set(userId, executor)
    return await openCacheStore(executor)
  }

  const clientOf = (fetch: typeof globalThis.fetch): CachingClient =>
    new CachingClient({ baseUrl: 'http://x/api/v1', fetch, openCache })

  it('keeps the people each search for a team found, newest first and each once, for Add Existing Player (U43)', async function () {
    const person = (name: string, cursor: string): unknown => ({
      userId: `usr_${name}`,
      gumboId: null,
      externalIds: [],
      shortName: `${name} B`,
      shortParts: { first: name, last: 'B' },
      avatarUrl: null,
      bats: null,
      throws: null,
      teams: [],
      tier: 'mine',
      cursor
    })
    const net = server({
      '/users?forTeam=tem_hawks&limit=30': {
        body: [person('Mookie', 'c1'), person('Mike', 'c2')]
      },
      '/users?forTeam=tem_hawks&q=aar&limit=30': {
        body: [person('Aaron', 'c3'), person('Mike', 'c4')]
      },
      '/users?forTeam=tem_owls&limit=30': { body: [] }
    })
    const client = clientOf(net.fetch)
    client.openFor('usr_1')
    await client.rosterCandidates({ teamId: 'tem_hawks', limit: 30 })
    await client.rosterCandidates({ teamId: 'tem_hawks', q: 'aar', limit: 30 })
    await client.rosterCandidates({ teamId: 'tem_owls', limit: 30 })
    const kept = await client.cached(
      candidatesKey('tem_hawks'),
      raw => raw as Array<{ userId: string; cursor: string }>
    )
    expect(kept?.map(row => [row.userId, row.cursor])).deep.equals([
      ['usr_Aaron', 'c3'],
      ['usr_Mike', 'c4'],
      ['usr_Mookie', 'c1']
    ])
    expect(await client.cached(candidatesKey('tem_owls'), raw => raw)).equals(
      undefined
    )
    expect(candidatesTeamOf('/users?forTeam=t%201&q=x')).equals('t 1')
    expect(candidatesTeamOf('/users?guardedBy=me')).equals(undefined)
    expect(candidatesTeamOf('/teams/t1/roster')).equals(undefined)
  })

  it('answers a GET that fails to leave the device from the store, the first time (Cache hit)', async function () {
    const net = server({
      '/teams': { body: [team('tem_hawks', 'Hawks')], olderRevision: '7' }
    })
    const online = clientOf(net.fetch)
    online.openFor('usr_1')
    expect((await online.teams()).map(row => row.name)).deep.equals(['Hawks'])
    const stored = stores
      .get('usr_1')!
      .db.prepare("SELECT revision FROM documents WHERE key = 'home.teams'")
      .get()
    // Whatever an older server said: nothing reads the column.
    expect(stored).property('revision', '0')

    // A new process: nothing has failed in it yet.
    stores.get('usr_1')!.db.close()
    net.offline = true
    const cold = clientOf(net.fetch)
    cold.openFor('usr_1')
    expect((await cold.teams()).map(row => row.name)).deep.equals(['Hawks'])
    expect(cold.offline).equals(true)
    expect(
      (await cold.cached('home.teams', raw => raw as unknown[]))?.length
    ).equals(1)
  })

  it('throws the offline error for a document never stored (Cache miss)', async function () {
    const net = server({})
    net.offline = true
    const client = clientOf(net.fetch)
    client.openFor('usr_1')
    let failure: unknown
    try {
      await client.game('g404')
    } catch (error) {
      failure = error
    }
    expect(failure).property('code', 'offline')
    expect(await client.cached('game.g404', raw => raw)).equals(undefined)
  })

  it('keeps a season’s games apart from the person’s whole list (Season query)', async function () {
    const all = [upcomingGame('g1', 'tem_hawks', 'tem_owls')]
    const net = server({
      '/events?season=sea_1': { body: [] },
      '/events': { body: all }
    })
    const client = clientOf(net.fetch)
    client.openFor('usr_1')
    await client.seasonGames('sea_1')
    await client.games({ when: 'all' })
    expect(await client.cached('games.all', raw => raw)).equals(undefined)
    net.offline = true
    expect(await client.seasonGames('sea_1')).deep.equals([])
    expect(await client.games({})).length(1)
    // A season never read has no list to answer.
    let failure: unknown
    try {
      await client.seasonGames('sea_2')
    } catch (error) {
      failure = error
    }
    expect(failure).property('code', 'offline')
  })

  it('answers a pending document as stored, even when the server answered (Pending document)', async function () {
    const net = server({
      '/games/g1/lineups': {
        body: { away: 'server', home: 'server', digest: 'd9' }
      }
    })
    const client = clientOf(net.fetch)
    client.openFor('usr_1')
    await client.cached('none', raw => raw)
    const db = stores.get('usr_1')!.db
    db.prepare(
      "INSERT INTO documents (key, body, revision, server_digest, pending) VALUES ('lineups.g1', ?, '4', 'd4', 1)"
    ).run(JSON.stringify({ mine: true }))
    const raw = (body: unknown): unknown => body
    // Through the protected request, as a cleaner-free read.
    const read = async (): Promise<unknown> =>
      await (
        client as unknown as {
          request: (m: string, p: string, c: typeof raw) => Promise<unknown>
        }
      ).request('GET', '/games/g1/lineups', raw)
    expect(await read()).deep.equals({ mine: true })
    expect(net.calls).includes('/games/g1/lineups')
    expect(
      db
        .prepare(
          "SELECT body, revision FROM documents WHERE key = 'lineups.g1'"
        )
        .get()
    ).deep.include({ body: '{"mine":true}' })
    // A refusal from the server is not an answer to show over it either.
    const refusing = server({
      '/games/g1/lineups': {
        status: 500,
        body: { error: 'internal', message: 'x' }
      }
    })
    const again = new CachingClient({
      baseUrl: 'http://x/api/v1',
      fetch: refusing.fetch,
      openCache: async () => await openCacheStore(stores.get('usr_1')!)
    })
    again.openFor('usr_1')
    expect(
      await (
        again as unknown as {
          request: (m: string, p: string, c: typeof raw) => Promise<unknown>
        }
      ).request('GET', '/games/g1/lineups', raw)
    ).deep.equals({ mine: true })
  })

  it('drops a stored document the server says is gone or not this person’s, and keeps a pending one', async function () {
    const routes: Record<string, Answer | undefined> = {
      '/teams': { body: [team('tem_hawks', 'Hawks')] },
      '/games/g1/lineups': {
        body: { away: 'server', home: 'server', digest: 'd9' }
      }
    }
    const net = server(routes)
    const client = clientOf(net.fetch)
    client.openFor('usr_1')
    await client.teams()
    expect(await client.cached('home.teams', raw => raw)).not.equals(undefined)
    const db = stores.get('usr_1')!.db
    db.prepare(
      "INSERT INTO documents (key, body, revision, server_digest, pending) VALUES ('lineups.g1', ?, '4', 'd4', 1)"
    ).run(JSON.stringify({ mine: true }))
    for (const [status, code] of [
      [404, 'notFound'],
      [403, 'forbidden']
    ] as const) {
      routes['/teams'] = { status, body: { code, message: 'Gone' } }
      routes['/games/g1/lineups'] = { status, body: { code, message: 'Gone' } }
      let thrown: unknown
      await client.teams().catch((error: unknown) => {
        thrown = error
      })
      expect(thrown, String(status)).property('code', code)
      expect(await client.cached('home.teams', raw => raw)).equals(undefined)
      // A queued write still holds its document, and it answers.
      expect(
        await client.cached('lineups.g1', raw => raw),
        String(status)
      ).deep.equals({ mine: true })
      await client.teams().catch(() => undefined)
    }
    // A server error is not the record gone: it stays.
    routes['/teams'] = { body: [team('tem_hawks', 'Hawks')] }
    await client.teams()
    routes['/teams'] = { status: 500, body: { code: 'internal', message: 'x' } }
    await client.teams().catch(() => undefined)
    expect(await client.cached('home.teams', raw => raw)).not.equals(undefined)
  })

  it('stores the server digest of lineups and plays', async function () {
    const net = server({
      '/games/g1/lineups': {
        body: {
          away: { teamId: 'tem_owls', teamName: 'Owls', lineups: [] },
          home: { teamId: 'tem_hawks', teamName: 'Hawks', lineups: [] },
          digest: 'dl1'
        }
      },
      '/games/g1/events': {
        body: {
          plays: [],
          currentPlay: null,
          lineupsDigest: 'dl1',
          playsDigest: 'p1'
        }
      }
    })
    const client = clientOf(net.fetch)
    client.openFor('usr_1')
    await client.gameEvents('g1')
    try {
      await client.gameLineups('g1')
    } catch {
      // The lineups' shape is the server's; the digest is what is checked.
    }
    const db = stores.get('usr_1')!.db
    const digests = db
      .prepare('SELECT key, server_digest FROM documents ORDER BY key')
      .all()
      .map(row => ({ ...row }))
    expect(digests).deep.include({ key: 'events.g1', server_digest: 'dl1' })
  })

  it('reads roles and the plain roster offline, the whole names only where stored (Roles and roster)', async function () {
    const roles = {
      teams: { tem_hawks: ['scorekeeper'], tem_owls: ['videographer'] }
    }
    const net = server({
      '/me/home': {
        body: {
          teams: [team('tem_hawks', 'Hawks'), team('tem_owls', 'Owls')].map(
            row => ({ ...row, direct: true, source: 'member' })
          ),
          seasons: [],
          leagues: []
        }
      },
      '/me/roles': { body: roles },
      '/events?when=upcoming': {
        body: [
          upcomingGame('g1', 'tem_hawks', 'tem_owls'),
          upcomingGame('g2', 'tem_hawks', 'tem_external')
        ]
      },
      '/teams/tem_hawks/roster': { body: [rosterEntry(101)] },
      '/teams/tem_hawks/roster?includeFullNames=true': {
        body: [rosterEntry(101, 'Mookie Betts')]
      },
      '/teams/tem_owls/roster': { body: [rosterEntry(202)] },
      '/teams/tem_owls/roster?includeFullNames=true': {
        status: 403,
        body: { error: 'forbidden', message: 'No' }
      },
      '/games/g1': { status: 500, body: { error: 'internal', message: 'x' } }
    })
    const client = clientOf(net.fetch)
    // Before a user id is known there is nothing to read ahead into.
    await client.prefetch()
    expect(net.calls).deep.equals([])
    client.openFor('usr_1')
    await client.home()
    net.most = 0
    await Promise.all([client.prefetch(), client.prefetch()])
    expect(net.most).within(1, PREFETCH_CONCURRENCY)

    const fetched = net.calls.slice(1)
    expect(fetched).includes('/teams/tem_hawks/roster?includeFullNames=true')
    expect(fetched).not.includes('/teams/tem_owls/roster?includeFullNames=true')
    expect(fetched).includes('/teams/tem_hawks/default-lineup')
    expect(fetched).not.includes('/teams/tem_external/roster')
    expect(fetched).includes('/games/g2/events')
    expect(new Set(fetched).size, 'each read once').equals(fetched.length)

    const stored = (
      stores
        .get('usr_1')!
        .db.prepare('SELECT key FROM documents')
        .all() as Array<{
        key: string
      }>
    ).map(row => row.key)
    expect(stored).includes(fullRosterKey('tem_hawks'))
    expect(stored).not.includes(fullRosterKey('tem_owls'))
    expect(stored, 'a failed read is skipped').not.includes('game.g1')
    expect(stored).includes('me.roles').and.not.includes('games.upcoming')
    expect(fetched, 'the scoring read stays').includes('/events?when=upcoming')

    net.offline = true
    expect(await client.myRoles()).deep.include({ teams: roles.teams })
    const owls = await client.roster('tem_owls', { includeFullNames: true })
    expect(owls.map(row => row.userId)).deep.equals([userIdOfGumbo(202)])
    expect(owls[0]?.nameDetails).equals(undefined)
    const hawks = await client.roster('tem_hawks', { includeFullNames: true })
    expect(hawks[0]?.nameDetails?.displayName).equals('Mookie Betts')
    // Offline, nothing is read ahead.
    const before = net.calls.length
    await client.prefetch()
    expect(net.calls.length).equals(before)
  })

  it('paints Schedule from a first page only the prefetch stored (Paged prefetch)', async function () {
    const games = [upcomingGame('g1', 'tem_hawks', 'tem_owls')]
    const net = server({
      '/events?when=upcoming': { body: games },
      '/events?paged=1&when=upcoming': {
        body: pageOf(games, {}, { counts: null })
      }
    })
    const client = clientOf(net.fetch)
    client.openFor('usr_1')
    await client.prefetch()
    expect(net.calls).includes('/events?paged=1&when=upcoming')
    const stored = await client.scheduleGames(
      ME_SCOPE,
      'upcoming',
      asSeasonGame
    )
    expect(stored.items.map(game => game.id)).deep.equals(['g1'])
    net.offline = true
    const page = await client.gamesPage({ when: 'upcoming' })
    expect(page.items.map(game => game.id)).deep.equals(['g1'])
  })

  it('answers each list’s stored first page offline, and fails a later page never stored as offline (First page)', async function () {
    const games = [upcomingGame('g1', 'tem_hawks', 'tem_owls')]
    const lists: Array<[string, Parameters<CachingClient['gamesPage']>[0]]> = [
      ['/events?paged=1&when=upcoming', { when: 'upcoming' }],
      ['/events?paged=1&when=past', { when: 'past' }],
      ['/events?paged=1', {}],
      ['/events?paged=1&hasVideo=1', { hasVideo: true }]
    ]
    const net = server(
      Object.fromEntries(lists.map(([path]) => [path, { body: pageOf(games) }]))
    )
    const client = clientOf(net.fetch)
    client.openFor('usr_1')
    for (const [, query] of lists) await client.gamesPage(query)
    net.offline = true
    for (const [, query] of lists)
      expect((await client.gamesPage(query)).items).length(1)
    // A first page never stored is no games, and no error.
    expect(
      await client.gamesPage({ when: 'upcoming', order: 'asc' })
    ).deep.equals({
      items: [],
      nextCursor: null,
      prevCursor: null,
      anchorId: null,
      counts: null
    })
    // A later page never stored is the offline error: the list's Could not
    // load more, and its Retry.
    let failed: unknown
    try {
      await client.gamesPage({ when: 'past', cursor: 'next:50' })
    } catch (error) {
      failed = error
    }
    expect(failed).property('code', 'offline')
  })

  it('reads ahead from the stored upcoming list when it will not load', async function () {
    const net = server({
      '/events?when=upcoming': {
        body: [upcomingGame('g3', 'tem_hawks', 'tem_owls')]
      }
    })
    const client = clientOf(net.fetch)
    client.openFor('usr_1')
    await client.games({ when: 'upcoming' })
    // A server restarting: not the list gone, which would drop it.
    const failing = server({
      '/events?when=upcoming': {
        status: 503,
        body: { code: 'unavailable', message: 'Restarting' }
      }
    })
    const other = new CachingClient({
      baseUrl: 'http://x/api/v1',
      fetch: failing.fetch,
      openCache: async () => await openCacheStore(stores.get('usr_1')!)
    })
    other.openFor('usr_1')
    await other.prefetch()
    expect(failing.calls).includes('/games/g3/lineups')
  })

  it('opens the file only for a known user, keeps it, and deletes it on sign-out', async function () {
    const net = server({ '/teams': { body: [] } })
    const client = clientOf(net.fetch)
    expect(client.cacheUser).equals(undefined)
    await client.teams()
    expect(opened, 'no file before a user id').deep.equals([])
    client.openFor('usr_1')
    client.openFor('usr_1')
    await client.teams()
    expect(opened).deep.equals(['usr_1'])
    client.openFor('usr_2')
    await client.teams()
    expect(opened).deep.equals(['usr_1', 'usr_2'])
    expect(client.cacheUser).equals('usr_2')
    await client.signedOut()
    expect(client.cacheUser).equals(undefined)
    const { existsSync } = await import('node:fs')
    expect(existsSync(join(dir, cacheFileName('usr_2')))).equals(false)
    expect(existsSync(join(dir, cacheFileName('usr_1')))).equals(true)
    await client.discard('usr_1')
    expect(existsSync(join(dir, cacheFileName('usr_1')))).equals(false)
    client.openFor('usr_3')
    await client.discard('usr_3')
    expect(client.cacheUser).equals(undefined)
  })

  it('misses, and answers from the server, when the file will not open or write', async function () {
    const net = server({ '/teams': { body: [team('tem_hawks', 'Hawks')] } })
    const broken = new CachingClient({
      baseUrl: 'http://x/api/v1',
      fetch: net.fetch,
      openCache: async () => {
        throw new Error('disk full')
      }
    })
    broken.openFor('usr_1')
    expect(await broken.teams()).length(1)
    expect(await broken.cached('home.teams', raw => raw)).equals(undefined)
    await broken.discard('usr_9')
    await broken.signedOut()

    const failing: DocumentStore = {
      read: async () => {
        throw new Error('locked')
      },
      atomically: async () => {
        throw new Error('locked')
      },
      store: async () => {
        throw new Error('locked')
      },
      storeServer: async () => {
        throw new Error('locked')
      },
      close: async () => {
        throw new Error('locked')
      },
      destroy: async () => {
        throw new Error('locked')
      }
    }
    const locked = new CachingClient({
      baseUrl: 'http://x/api/v1',
      fetch: net.fetch,
      openCache: async () => failing
    })
    locked.openFor('usr_1')
    expect(await locked.teams()).length(1)
    locked.openFor('usr_2')
    expect(await locked.teams()).length(1)
    net.offline = true
    let failure: unknown
    try {
      await locked.teams()
    } catch (error) {
      failure = error
    }
    expect(failure).property('code', 'offline')
    await locked.signedOut()
  })

  it('throws the offline error for a stored body this version cannot read', async function () {
    const net = server({ '/teams': { body: [{ not: 'a team' }] } })
    const client = clientOf(net.fetch)
    client.openFor('usr_1')
    await client.teams().catch(() => undefined)
    stores
      .get('usr_1')!
      .db.prepare(
        "INSERT INTO documents (key, body, revision) VALUES ('home.teams', '[{\"not\":1}]', '1')"
      )
      .run()
    expect(
      await client.cached('home.teams', raw => {
        if (!Array.isArray(raw) || raw.length !== 2) throw new TypeError('bad')
        return raw
      })
    ).equals(undefined)
    net.offline = true
    let failure: unknown
    try {
      await client.teams()
    } catch (error) {
      failure = error
    }
    expect(failure).property('code', 'offline')
  })

  it('keeps the chat age confirmation, and answers it offline', async function () {
    const confirmed = {
      confirmed: true,
      source: 'self',
      confirmedAt: '2027-04-12T12:00:00.000Z'
    }
    const net = server({
      '/me/account/chat-age': { body: confirmed }
    })
    const client = clientOf(net.fetch)
    client.openFor('usr_1')
    expect(await client.chatAge()).deep.equals(confirmed)
    net.offline = true
    expect(await client.chatAge()).deep.equals(confirmed)
  })

  it('answers a pending document the server sent back unreadable as the server answer', async function () {
    const net = server({ '/me/roles': { body: { teams: {} } } })
    const client = clientOf(net.fetch)
    client.openFor('usr_1')
    await client.cached('none', raw => raw)
    stores
      .get('usr_1')!
      .db.prepare(
        "INSERT INTO documents (key, body, revision, pending) VALUES ('me.roles', '\"no\"', '1', 1)"
      )
      .run()
    expect(await client.myRoles()).deep.include({ teams: {} })
  })

  it('keeps an unmapped read under its path, and leaves an empty answer as it was', async function () {
    const net = server({
      '/me/groups?role=admin': { body: [] },
      '/teams': { body: '' }
    })
    const client = clientOf(net.fetch)
    client.openFor('usr_1')
    expect(await client.ownGroups('admin')).deep.equals([])
    expect(await client.cached('home.groups', raw => raw)).equals(undefined)
    expect(
      await client.cached('/me/groups?role=admin', raw => raw)
    ).deep.equals([])
  })
  describe('the schedule set', function () {
    const game = (
      id: string,
      startAt: string | null,
      fields: Record<string, unknown> = {}
    ): Record<string, unknown> => ({
      ...(upcomingGame(id, 'tem_hawks', 'tem_owls') as Record<string, unknown>),
      startAt,
      ...fields
    })
    const ids = (page: { items: unknown[] }): string[] =>
      page.items.map(item => (item as { id: string }).id)
    const offline = (error: unknown): unknown => error
    const pages = (userId = 'usr_1'): Array<Record<string, unknown>> =>
      stores
        .get(userId)!
        .db.prepare(
          'SELECT scope, "window", cursor FROM schedule_pages ORDER BY scope, "window", cursor'
        )
        .all()
        .map(row => ({ ...row }))

    it('recognizes each schedule read, and leaves Home’s recent game and a lookup to the documents', function () {
      expect(scheduleReadOf('/events?paged=1&when=upcoming')).deep.equals({
        scope: 'me',
        window: 'upcoming',
        cursor: 'first',
        shape: 'SeasonGame',
        paged: true,
        cursorOnly: false
      })
      expect(scheduleReadOf('/events')).deep.include({
        scope: 'me',
        window: 'all',
        cursor: 'list',
        paged: false
      })
      expect(
        scheduleReadOf('/events?season=sea_1&paged=1&hasVideo=1&order=desc')
      ).deep.include({ scope: 'season:sea_1', window: 'all+videos+desc' })
      expect(
        scheduleReadOf('/teams/tem_1/games?paged=1&cursor=next%3A2')
      ).deep.include({
        scope: 'team:tem_1',
        cursor: 'next:2',
        shape: 'GameSummary',
        cursorOnly: true
      })
      // A public page is the group's, though it is a team's path.
      expect(
        scheduleReadOf('/teams/tem_1/games?public=1&paged=1')
      ).deep.include({ scope: 'group:tem_1', shape: 'PublicGame' })
      expect(
        scheduleReadOf('/seasons/sea_1/games?public=1&paged=1&when=past')
      ).deep.include({ scope: 'group:sea_1', window: 'past' })
      for (const path of [
        '/events?played=1&limit=1',
        '/events?externalId=x',
        '/events?when=recent',
        '/events?order=sideways',
        '/events?paged=1&hasVideo=true',
        '/events?season=a&season=b',
        '/events?season=',
        '/seasons/sea_1/games',
        '/teams/%E0%A4%A/games',
        '/teams/t/roster'
      ])
        expect(scheduleReadOf(path), path).equals(undefined)
      expect(scheduleWindow({ when: 'past', order: 'desc' })).equals(
        'past+desc'
      )
      expect(groupScope('x')).equals('group:x')
    })

    it('writes only the prefetch’s two upcoming pages, reads them when the list will not load, and paints Upcoming from the first page', async function () {
      const games = [game('g1', '2026-10-22T18:00:00Z')]
      const routes: Record<string, Answer | undefined> = {
        '/events?when=upcoming': { body: games },
        '/events?paged=1&when=upcoming': {
          body: pageOf([...games, game('g2', '2026-10-23T18:00:00Z')])
        }
      }
      const net = server(routes)
      const client = clientOf(net.fetch)
      client.openFor('usr_1')
      await client.prefetch()
      expect(pages()).deep.equals([
        { scope: 'me', window: 'upcoming', cursor: 'first' },
        { scope: 'me', window: 'upcoming', cursor: 'list' }
      ])
      expect(
        net.calls.filter(path => /^\/(events|teams\/[^/]+\/games)/.test(path))
      ).deep.equals(['/events?when=upcoming', '/events?paged=1&when=upcoming'])
      expect(
        ids(await client.scheduleGames(ME_SCOPE, 'upcoming', asSeasonGame))
      ).deep.equals(['g1', 'g2'])
      // The list will not load: the stored games choose what is read ahead.
      routes['/events?when=upcoming'] = {
        status: 503,
        body: { code: 'unavailable', message: 'Restarting' }
      }
      net.calls.length = 0
      await client.prefetch()
      expect(net.calls).includes('/games/g2/lineups')
    })

    it('keeps each window of a season apart, and offline Past paints only past games', async function () {
      const past = [game('p1', '2026-01-01T18:00:00Z')]
      const upcoming = [game('u1', '2026-12-01T18:00:00Z')]
      const net = server({
        '/events?season=sea_1&paged=1&when=past&order=desc': {
          body: pageOf(past)
        },
        '/events?season=sea_1&paged=1&when=upcoming&order=asc': {
          body: pageOf(upcoming)
        }
      })
      const client = clientOf(net.fetch)
      client.openFor('usr_1')
      await client.seasonGamesPage('sea_1', { when: 'past', order: 'desc' })
      await client.seasonGamesPage('sea_1', { when: 'upcoming', order: 'asc' })
      net.offline = true
      expect(
        ids(
          await client.seasonGamesPage('sea_1', { when: 'past', order: 'desc' })
        )
      ).deep.equals(['p1'])
      expect(
        ids(
          await client.scheduleGames(
            seasonScope('sea_1'),
            'past+desc',
            asSeasonGame
          )
        )
      ).deep.equals(['p1'])
      // A season's game is not the person's Upcoming.
      expect(
        ids(await client.scheduleGames(ME_SCOPE, 'upcoming', asSeasonGame))
      ).deep.equals([])
    })

    it('answers a stored later page offline for its cursor, with its counts, cursors and anchor', async function () {
      const rows = [1, 2, 3, 4, 5].map(n =>
        game(`g${n}`, `2026-10-0${n}T18:00:00Z`)
      )
      const counts = {
        total: 5,
        upcoming: 5,
        withVideo: 0,
        videos: 0,
        newestSeasonId: null
      }
      const first = pageOf(rows, { limit: 2 }, { counts, anchorId: 'g1' })
      const second = pageOf(rows, { cursor: 'next:2', limit: 2 })
      const net = server({
        '/events?paged=1&when=upcoming&limit=2': { body: first },
        '/events?paged=1&when=upcoming&cursor=next%3A2&limit=2': {
          body: second
        }
      })
      const client = clientOf(net.fetch)
      client.openFor('usr_1')
      await client.gamesPage({ when: 'upcoming', limit: 2 })
      await client.gamesPage({ when: 'upcoming', cursor: 'next:2', limit: 2 })
      net.offline = true
      const later = await client.gamesPage({
        when: 'upcoming',
        cursor: 'next:2',
        limit: 2
      })
      expect(later).deep.equals(asPage(asSeasonGame)(second))
      const opened = await client.gamesPage({ when: 'upcoming', limit: 2 })
      expect(ids(opened)).deep.equals(['g1', 'g2', 'g3', 'g4'])
      expect(opened.counts).deep.equals(counts)
      expect(opened.anchorId).equals('g1')
      expect(opened.nextCursor).equals('next:4')
      expect(opened.prevCursor).equals(null)
    })

    it('joins a team’s cursor-only later page to its first page, back and forth, and paints it offline after it', async function () {
      const rows = [1, 2, 3, 4, 5, 6].map(n =>
        game(`g${n}`, `2026-10-0${n}T18:00:00Z`)
      )
      const first = pageOf(rows, { limit: 2 }, { anchorIndex: 2 })
      expect(ids(first)).deep.equals(['g2', 'g3', 'g4'])
      const routes: Record<string, Answer | undefined> = {
        '/teams/tem_hawks/games?paged=1&order=asc&around=next': { body: first },
        '/teams/tem_hawks/games?paged=1&cursor=next%3A4': {
          body: pageOf(rows, { cursor: 'next:4', limit: 2 })
        },
        '/teams/tem_hawks/games?paged=1&cursor=prev%3A1': {
          body: pageOf(rows, { cursor: 'prev:1', limit: 2 })
        }
      }
      const net = server(routes)
      const client = clientOf(net.fetch)
      client.openFor('usr_1')
      await client.teamGamesPage('tem_hawks', { around: 'next', order: 'asc' })
      await client.teamGamesPage('tem_hawks', { cursor: 'next:4' })
      await client.teamGamesPage('tem_hawks', { cursor: 'prev:1' })
      expect(pages().filter(row => row.scope === 'team:tem_hawks')).deep.equals(
        [
          { scope: 'team:tem_hawks', window: 'all+asc', cursor: 'first' },
          { scope: 'team:tem_hawks', window: 'all+asc', cursor: 'next:4' },
          { scope: 'team:tem_hawks', window: 'all+asc', cursor: 'prev:1' }
        ]
      )
      net.offline = true
      const painted = await client.scheduleGames(
        teamScope('tem_hawks'),
        'all+asc',
        asRawGame
      )
      expect(ids(painted)).deep.equals(['g1', 'g2', 'g3', 'g4', 'g5', 'g6'])
      expect(painted.nextCursor).equals(null)
      expect(
        ids(await client.teamGamesPage('tem_hawks', { cursor: 'next:4' }))
      ).deep.equals(['g5', 'g6'])
      // The person's Upcoming is not the team's.
      expect(
        ids(
          await client.scheduleGames(
            teamScope('tem_hawks'),
            'upcoming',
            asRawGame
          )
        )
      ).deep.equals([])
    })

    it('keeps one row per game and shape: a team’s summary never replaces the person’s game', async function () {
      const net = server({
        '/events?paged=1&when=upcoming': {
          body: pageOf([game('g1', '2026-10-01T18:00:00Z')])
        },
        '/teams/tem_hawks/games?paged=1': {
          body: pageOf([{ id: 'g1', note: 'summary' }])
        },
        '/teams/tem_hawks/games?public=1&paged=1': {
          body: pageOf([{ id: 'g1', note: 'public' }])
        }
      })
      const client = clientOf(net.fetch)
      client.openFor('usr_1')
      await client.gamesPage({ when: 'upcoming' })
      await rawRead(client, '/teams/tem_hawks/games?paged=1')
      await rawRead(client, '/teams/tem_hawks/games?public=1&paged=1')
      const rows = stores
        .get('usr_1')!
        .db.prepare('SELECT shape, game_id FROM schedule_games ORDER BY shape')
        .all()
        .map(row => ({ ...row }))
      expect(rows).deep.equals([
        { shape: 'GameSummary', game_id: 'g1' },
        { shape: 'PublicGame', game_id: 'g1' },
        { shape: 'SeasonGame', game_id: 'g1' }
      ])
      const upcoming = await client.scheduleGames(
        ME_SCOPE,
        'upcoming',
        asRawGame
      )
      expect(upcoming.items[0]).not.property('note')
      expect(
        (await client.scheduleGames(groupScope('tem_hawks'), 'all', asRawGame))
          .items[0]
      ).property('note', 'public')
    })

    it('paints All, never read, from what Upcoming and Past stored, a game with no start last, and Videos from the games with one', async function () {
      const net = server({
        '/events?paged=1&when=upcoming': {
          body: pageOf([
            game('u1', '2026-12-01T18:00:00Z'),
            game('tbd', null),
            game('u2', '2026-12-05T18:00:00Z')
          ])
        },
        '/events?paged=1&when=past': {
          body: pageOf([
            game('p1', '2026-01-01T18:00:00Z', { videoCount: 2 }),
            game('p2', '2026-02-01T18:00:00Z')
          ])
        }
      })
      const client = clientOf(net.fetch)
      client.openFor('usr_1')
      expect(
        ids(await client.scheduleGames(ME_SCOPE, 'all', asSeasonGame))
      ).deep.equals([])
      await client.gamesPage({ when: 'upcoming' })
      await client.gamesPage({ when: 'past' })
      expect(
        ids(await client.scheduleGames(ME_SCOPE, 'all', asSeasonGame))
      ).deep.equals(['u2', 'u1', 'p2', 'p1', 'tbd'])
      net.offline = true
      expect(ids(await client.gamesPage({}))).deep.equals([
        'u2',
        'u1',
        'p2',
        'p1',
        'tbd'
      ])
      expect(ids(await client.gamesPage({ hasVideo: true }))).deep.equals([
        'p1'
      ])
      // A scope with nothing stored paints nothing.
      expect(
        ids(
          await client.scheduleGames(seasonScope('sea_9'), 'all', asSeasonGame)
        )
      ).deep.equals([])
    })

    it('replaces a page with its next answer: a dropped game leaves, a changed score is the row, and nothing else is read', async function () {
      const ten = Array.from({ length: 10 }, (_, n) =>
        game(`g${n}`, `2026-10-${String(n + 10)}T18:00:00Z`)
      )
      const routes: Record<string, Answer | undefined> = {
        '/events?paged=1&when=upcoming': { body: pageOf(ten) },
        '/events?paged=1': { body: pageOf(ten) },
        '/events?paged=1&when=past': { body: pageOf([]) }
      }
      const net = server(routes)
      const client = clientOf(net.fetch)
      client.openFor('usr_1')
      await client.gamesPage({ when: 'upcoming' })
      expect(net.calls).deep.equals(['/events?paged=1&when=upcoming'])
      // All, entered with those ten stored, paints them and still reads.
      expect(
        ids(await client.scheduleGames(ME_SCOPE, 'all', asSeasonGame))
      ).length(10)
      const scored = [
        { ...ten[0], homeScore: 3, awayScore: 1, status: 'final' },
        ...ten.slice(2)
      ]
      routes['/events?paged=1'] = { body: pageOf(scored) }
      await client.gamesPage({})
      expect(net.calls.at(-1)).equals('/events?paged=1')
      const all = await client.scheduleGames(ME_SCOPE, 'all', asSeasonGame)
      expect(ids(all)).not.includes('g1')
      expect(all.items[0]).deep.include({ homeScore: 3, status: 'final' })
      // The same row: Upcoming's page shows the new score too.
      expect(
        (await client.scheduleGames(ME_SCOPE, 'upcoming', asSeasonGame))
          .items[0]
      ).deep.include({ homeScore: 3 })
      await client.gamesPage({ when: 'past' })
      expect(net.calls.at(-1)).equals('/events?paged=1&when=past')
      expect(
        stores
          .get('usr_1')!
          .db.prepare(
            "SELECT COUNT(*) AS n FROM schedule_games WHERE game_id = 'g0'"
          )
          .get()
      ).property('n', 1)
    })

    it('answers a team opened offline, and a team never opened has no games', async function () {
      const net = server({
        '/teams/tem_hawks/games?paged=1&order=asc&around=next': {
          body: pageOf([{ id: 'g1' }])
        }
      })
      const client = clientOf(net.fetch)
      client.openFor('usr_1')
      const read = async (teamId: string): Promise<unknown> =>
        await rawRead(
          client,
          `/teams/${teamId}/games?paged=1&order=asc&around=next`
        )
      await read('tem_hawks')
      net.offline = true
      expect(await read('tem_hawks')).deep.include({ items: [{ id: 'g1' }] })
      expect(await read('tem_owls')).deep.include({ items: [] })
      expect(
        stores
          .get('usr_1')!
          .db.prepare(
            "SELECT COUNT(*) AS n FROM schedule_pages WHERE scope = 'team:tem_owls'"
          )
          .get()
      ).property('n', 0)
    })

    it('answers a whole list a server error refused with that error, not the store', async function () {
      const net = server({ '/events?when=past': { body: [game('p1', null)] } })
      const client = clientOf(net.fetch)
      client.openFor('usr_1')
      await client.games({ when: 'past' })
      const failing = server({
        '/events?when=past': {
          status: 500,
          body: { code: 'internal', message: 'x' }
        }
      })
      const other = new CachingClient({
        baseUrl: 'http://x/api/v1',
        fetch: failing.fetch,
        openCache: async () => await openCacheStore(stores.get('usr_1')!)
      })
      other.openFor('usr_1')
      let failure: unknown
      await other.games({ when: 'past' }).catch((error: unknown) => {
        failure = offline(error)
      })
      expect(failure).property('code', 'internal')
      net.offline = true
      expect(await client.games({ when: 'past' })).length(1)
    })

    it('upgrades the schedule lists an older build stored, once, and leaves the documents', async function () {
      const executor = nodeSqliteExecutor(join(dir, 'legacy.sqlite'))
      const legacy = await openCacheStore(executor)
      await legacy.store(GAMES_UPCOMING_PAGE, {
        body: JSON.stringify(
          pageOf([game('u1', '2026-12-01T18:00:00Z')], {}, { anchorId: 'u1' })
        ),
        revision: '0',
        serverDigest: null
      })
      await legacy.store(GAMES_VIDEOS_PAGE, {
        body: JSON.stringify(
          pageOf([game('p1', '2026-01-01T18:00:00Z', { videoCount: 1 })])
        ),
        revision: '0',
        serverDigest: null
      })
      await legacy.store(GAMES_PAST, {
        body: JSON.stringify([game('p1', '2026-01-01T18:00:00Z')]),
        revision: '0',
        serverDigest: null
      })
      await legacy.store(GAMES_ALL, {
        body: '"not a list"',
        revision: '0',
        serverDigest: null
      })
      // The tables did not exist when those were stored.
      executor.db.exec('DROP TABLE schedule_games; DROP TABLE schedule_pages')
      const net = server({})
      net.offline = true
      const client = new CachingClient({
        baseUrl: 'http://x/api/v1',
        fetch: net.fetch,
        openCache: async () => await openCacheStore(executor)
      })
      client.openFor('usr_1')
      const upcoming = await client.gamesPage({ when: 'upcoming' })
      expect(ids(upcoming)).deep.equals(['u1'])
      expect(upcoming.anchorId).equals('u1')
      expect(ids(await client.gamesPage({ hasVideo: true }))).deep.equals([
        'p1'
      ])
      expect(ids({ items: await client.games({ when: 'past' }) })).deep.equals([
        'p1'
      ])
      expect(await client.cached(GAMES_UPCOMING_PAGE, raw => raw)).not.equals(
        undefined
      )
      // Once: what the older build left is not read into the set again.
      await legacy.store(GAMES_UPCOMING_PAGE, {
        body: JSON.stringify(pageOf([game('u9', null)])),
        revision: '0',
        serverDigest: null
      })
      await openCacheStore(executor)
      expect(ids(await client.gamesPage({ when: 'upcoming' }))).deep.equals([
        'u1'
      ])
    })
  })

  describe('screen reads', function () {
    const read = rawRead

    it('answers Home, a team, a season, a league, a game and its plays offline once their screens read them', async function () {
      const home = { teams: [], seasons: [], leagues: [] }
      const routes: Record<string, Answer | undefined> = {
        '/me/home': { body: home },
        '/teams/tem_hawks': { body: { id: 'tem_hawks' } },
        '/seasons/sea_1/teams': { body: [] },
        '/leagues/lea_1': { body: { id: 'lea_1' } },
        '/games/g1/events': {
          body: { plays: [], lineupsDigest: 'l1', playsDigest: 'p1' }
        }
      }
      const net = server(routes)
      const client = clientOf(net.fetch)
      client.openFor('usr_1')
      await client.home()
      for (const path of Object.keys(routes).slice(1)) await read(client, path)
      const keys = (
        stores
          .get('usr_1')!
          .db.prepare('SELECT key FROM documents ORDER BY key')
          .all() as Array<{ key: string }>
      ).map(row => row.key)
      // A mapped read keeps its short key; the rest are their paths.
      expect(keys).deep.equals([
        '/leagues/lea_1',
        '/seasons/sea_1/teams',
        '/teams/tem_hawks',
        'events.g1',
        'home.lists'
      ])
      net.offline = true
      expect(await client.home()).deep.include({ teams: [] })
      for (const path of Object.keys(routes).slice(1))
        expect(await read(client, path), path).deep.equals(routes[path]!.body)
    })

    it('stores no stream, playback, clock, session or chat sync read, and keeps the chat list', async function () {
      const paths = [
        '/games/g1/live-streams',
        '/games/g1/stream-access',
        '/chat/devices',
        '/chat/conversations/c1/log?after=2',
        '/live',
        '/videos/v1/playback',
        '/time',
        '/auth/me'
      ]
      const net = server({
        ...Object.fromEntries(paths.map(path => [path, { body: { a: 1 } }])),
        '/chat/conversations': { body: [] }
      })
      const client = clientOf(net.fetch)
      client.openFor('usr_1')
      for (const path of paths) await read(client, path)
      await read(client, '/chat/conversations')
      const keys = (
        stores
          .get('usr_1')!
          .db.prepare('SELECT key FROM documents')
          .all() as Array<{ key: string }>
      ).map(row => row.key)
      expect(keys).deep.equals(['/chat/conversations'])
      net.offline = true
      for (const path of paths) {
        let failure: unknown
        await read(client, path).catch((error: unknown) => {
          failure = error
        })
        expect(failure, path).property('code', 'offline')
      }
    })

    it('reads roles from the network while a row is stored', async function () {
      const routes: Record<string, Answer | undefined> = {
        '/me/roles': { body: { teams: {} } }
      }
      const net = server(routes)
      const client = clientOf(net.fetch)
      client.openFor('usr_1')
      await client.myRoles()
      // A group was created: the next read is the server's.
      routes['/me/roles'] = { body: { teams: { tem_new: ['admin'] } } }
      expect(await client.myRoles()).deep.include({
        teams: { tem_new: ['admin'] }
      })
    })

    it('reads the server for the outbox while a queued write holds the row, and records its digest beside the phone’s body', async function () {
      const routes: Record<string, Answer | undefined> = {
        '/games/g1/lineups': {
          body: { away: 'server', home: 'server', digest: 'd9' }
        },
        '/games/g2/lineups': {
          body: { away: 'server', home: 'server', digest: 'd2' }
        },
        '/games/g3/lineups': {
          status: 404,
          body: { code: 'notFound', message: 'Gone' }
        },
        '/time': { body: { now: 1 } }
      }
      const net = server(routes)
      const client = clientOf(net.fetch)
      client.openFor('usr_1')
      await client.cached('none', raw => raw)
      const db = stores.get('usr_1')!.db
      db.prepare(
        "INSERT INTO documents (key, body, revision, server_digest, pending) VALUES ('lineups.g1', ?, '0', 'd4', 1)"
      ).run(JSON.stringify({ mine: true }))
      db.prepare(
        "INSERT INTO documents (key, body, revision, server_digest, pending) VALUES ('lineups.g3', '{}', '0', null, 0)"
      ).run()
      expect(await client.serverRead('/games/g1/lineups')).deep.include({
        digest: 'd9'
      })
      expect(net.calls).deep.equals(['/games/g1/lineups'])
      expect(
        db
          .prepare(
            "SELECT body, server_digest, server_body, pending FROM documents WHERE key = 'lineups.g1'"
          )
          .get()
      ).deep.include({
        body: '{"mine":true}',
        server_digest: 'd9',
        server_body: JSON.stringify(routes['/games/g1/lineups']!.body),
        pending: 1
      })
      // With no queued write, the server's body is the row.
      await client.serverRead('/games/g2/lineups')
      expect(await client.cached('lineups.g2', raw => raw)).deep.include({
        digest: 'd2'
      })
      // Gone on the server: the phone's copy goes too.
      let failure: unknown
      await client.serverRead('/games/g3/lineups').catch((error: unknown) => {
        failure = error
      })
      expect(failure).property('code', 'notFound')
      expect(await client.cached('lineups.g3', raw => raw)).equals(undefined)
      // A read the phone never keeps is only the server's answer.
      expect(await client.serverRead('/time')).deep.equals({ now: 1 })
      await client.signedOut()
      expect(await client.serverRead('/time')).deep.equals({ now: 1 })
    })

    it('still paints Home on a phone that only has the stored home lists', async function () {
      const net = server({
        '/me/home': {
          body: {
            teams: [
              { ...team('tem_hawks', 'Hawks'), direct: true, source: 'member' }
            ],
            seasons: [],
            leagues: []
          }
        }
      })
      const client = clientOf(net.fetch)
      client.openFor('usr_1')
      await client.home()
      stores.get('usr_1')!.db.close()
      net.offline = true
      const cold = clientOf(net.fetch)
      cold.openFor('usr_1')
      expect(
        (await cold.cached('home.lists', raw => raw as { teams: unknown[] }))
          ?.teams
      ).length(1)
      expect(
        (await cold.scheduleGames(ME_SCOPE, 'upcoming', asSeasonGame)).items
      ).deep.equals([])
    })
  })
})

describe('document keys', function () {
  it('names exactly the GETs the phone keeps', function () {
    expect(documentKeyOf('/me/home')).equals('home.lists')
    expect(documentKeyOf('/me/account/chat-age')).equals('me.chatAge')
    expect(documentKeyOf('/teams')).equals('home.teams')
    expect(documentKeyOf('/users?guardedBy=me')).equals('home.guarded')
    expect(documentKeyOf('/events?played=1&limit=1')).equals('home.recent')
    // Any other GET is its path; the schedule reads are routed before this.
    expect(documentKeyOf('/events?externalId=x')).equals('/events?externalId=x')
    expect(documentKeyOf('/teams/t')).equals('/teams/t')
    expect(documentKeyOf('/teams/tem%2F1/roster')).equals(rosterKey('tem/1'))
    expect(documentKeyOf('/teams/t/roster?includeFullNames=true')).equals(
      'roster.full.t'
    )
    expect(documentKeyOf('/teams/t/default-lineup')).equals('defaultLineup.t')
    expect(documentKeyOf('/games/g')).equals('game.g')
    expect(documentKeyOf('/games/g/events')).equals('events.g')
    expect(documentKeyOf('/games/%E0%A4%A/lineups')).equals(undefined)
    expect(documentKeyOf('/games/g/dj')).equals('/games/g/dj')
    for (const path of [
      '/auth/me',
      '/health',
      '/time',
      '/live',
      '/me/builds',
      '/me/api-keys',
      '/videos/v1/playback',
      '/videos/v1/wall-timeline?from=1',
      '/games/g/scoreboard-timeline',
      '/games/g/live-streams',
      '/games/g/stream-access',
      '/chat/devices',
      '/chat/me/keys',
      '/chat/conversations/c1/log?after=4',
      '/chat/conversations/c1/epochs?after=1'
    ]) {
      expect(networkOnly(path), path).equals(true)
      expect(documentKeyOf(path), path).equals(undefined)
    }
    expect(documentKeyOf('/chat/conversations')).equals('/chat/conversations')
    expect(documentKeyOf('/chat/conversations/c1/messages?after=3')).equals(
      '/chat/conversations/c1/messages?after=3'
    )
    expect(fallbackKeyOf('roster.full.t')).equals('roster.t')
    expect(fallbackKeyOf('roster.t')).equals(undefined)
  })
})

describe('the web client', function () {
  it('has no cached documents', async function () {
    const client = new TeamStationClient({ baseUrl: '/api/v1' })
    expect(await client.cached('home.teams', raw => raw)).equals(undefined)
    // The web stores no schedule: an empty page, which no screen paints.
    expect(
      await client.scheduleGames('me', 'upcoming', raw => raw)
    ).deep.equals({
      items: [],
      nextCursor: null,
      prevCursor: null,
      anchorId: null,
      counts: null
    })
  })
})
