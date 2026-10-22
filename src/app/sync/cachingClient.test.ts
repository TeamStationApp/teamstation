import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { expect } from 'chai'

import { type RevisionRead, TeamStationClient } from '../../common/api'
import { userIdOfGumbo } from '../../common/userId'
import { nodeSqliteExecutor } from '../../test/nodeSqliteExecutor'
import { cacheFileName, type DocumentStore, openCacheStore } from './cacheStore'
import { CachingClient, PREFETCH_CONCURRENCY } from './cachingClient'
import {
  documentKeyOf,
  fallbackKeyOf,
  fullRosterKey,
  gamesKey,
  rosterKey
} from './documentKeys'

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
  revision?: string
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
            answer.revision == null
              ? {}
              : { 'x-teamstation-revision': answer.revision }
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

  it('answers a GET that fails to leave the device from the store, the first time (Cache hit)', async function () {
    const net = server({
      '/teams': { body: [team('tem_hawks', 'Hawks')], revision: '7' }
    })
    const online = clientOf(net.fetch)
    online.openFor('usr_1')
    expect((await online.teams()).map(row => row.name)).deep.equals(['Hawks'])
    const stored = stores
      .get('usr_1')!
      .db.prepare("SELECT revision FROM documents WHERE key = 'home.teams'")
      .get()
    expect(stored).property('revision', '7')

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

  it('stores no season query as games.all, and a season read offline throws (Season query)', async function () {
    const all = [upcomingGame('g1', 'tem_hawks', 'tem_owls')]
    const net = server({
      '/events?season=sea_1': { body: [], revision: '2' },
      '/events': { body: all, revision: '2' }
    })
    const client = clientOf(net.fetch)
    client.openFor('usr_1')
    await client.seasonGames('sea_1')
    expect(await client.cached('games.all', raw => raw)).equals(undefined)
    await client.games({ when: 'all' })
    expect(await client.cached('games.all', raw => raw)).deep.equals(all)
    net.offline = true
    let failure: unknown
    try {
      await client.seasonGames('sea_1')
    } catch (error) {
      failure = error
    }
    expect(failure).property('code', 'offline')
    expect(await client.games({})).length(1)
  })

  it('answers a pending document as stored, even when the server answered (Pending document)', async function () {
    const net = server({
      '/games/g1/lineups': {
        body: { away: 'server', home: 'server', digest: 'd9' },
        revision: '9'
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
    ).deep.include({ body: '{"mine":true}', revision: '4' })
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
      '/teams': { body: [team('tem_hawks', 'Hawks')], revision: '3' },
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
    routes['/teams'] = { body: [team('tem_hawks', 'Hawks')], revision: '4' }
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
        },
        revision: '3'
      },
      '/games/g1/events': {
        body: {
          plays: [],
          currentPlay: null,
          lineupsDigest: 'dl1',
          playsDigest: 'p1'
        },
        revision: '3'
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
      '/teams': {
        body: [team('tem_hawks', 'Hawks'), team('tem_owls', 'Owls')],
        revision: '5'
      },
      '/me/roles': { body: roles, revision: '5' },
      '/events?when=upcoming': {
        body: [
          upcomingGame('g1', 'tem_hawks', 'tem_owls'),
          upcomingGame('g2', 'tem_hawks', 'tem_external')
        ],
        revision: '5'
      },
      '/teams/tem_hawks/roster': { body: [rosterEntry(101)], revision: '5' },
      '/teams/tem_hawks/roster?includeFullNames=true': {
        body: [rosterEntry(101, 'Mookie Betts')],
        revision: '5'
      },
      '/teams/tem_owls/roster': { body: [rosterEntry(202)], revision: '5' },
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
    await client.teams()
    const collector: RevisionRead[] = []
    client.collectRevisions(collector)
    net.most = 0
    await Promise.all([client.prefetch(), client.prefetch()])
    client.stopCollecting(collector)
    expect(collector, 'prefetch collects into no load').deep.equals([])
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
    expect(stored).includes('me.roles').and.includes('games.upcoming')

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

  it('reads ahead from the stored upcoming list when it will not load', async function () {
    const net = server({
      '/events?when=upcoming': {
        body: [upcomingGame('g3', 'tem_hawks', 'tem_owls')],
        revision: '1'
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
    const net = server({ '/teams': { body: [], revision: '1' } })
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

  it('answers a pending document the server sent back unreadable as the server answer', async function () {
    const net = server({ '/me/roles': { body: { teams: {} }, revision: '2' } })
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

  it('leaves a request it does not store, and an empty answer, as they were', async function () {
    const net = server({
      '/me/groups?role=admin': { body: [] },
      '/teams': { body: '' }
    })
    const client = clientOf(net.fetch)
    client.openFor('usr_1')
    expect(await client.ownGroups('admin')).deep.equals([])
    expect(await client.cached('home.groups', raw => raw)).equals(undefined)
  })
})

describe('document keys', function () {
  it('names exactly the GETs the phone keeps', function () {
    expect(documentKeyOf('/teams')).equals('home.teams')
    expect(documentKeyOf('/users?guardedBy=me')).equals('home.guarded')
    expect(documentKeyOf('/events?played=1&limit=1')).equals('home.recent')
    expect(documentKeyOf('/events?when=past')).equals('games.past')
    expect(documentKeyOf('/events?externalId=x')).equals(undefined)
    expect(documentKeyOf('/events?season=s')).equals(undefined)
    expect(documentKeyOf('/teams/tem%2F1/roster')).equals(rosterKey('tem/1'))
    expect(documentKeyOf('/teams/t/roster?includeFullNames=true')).equals(
      'roster.full.t'
    )
    expect(documentKeyOf('/teams/t/default-lineup')).equals('defaultLineup.t')
    expect(documentKeyOf('/games/g')).equals('game.g')
    expect(documentKeyOf('/games/g/events')).equals('events.g')
    expect(documentKeyOf('/games/%E0%A4%A/lineups')).equals(undefined)
    expect(documentKeyOf('/games/g/dj')).equals(undefined)
    expect(gamesKey('upcoming')).equals('games.upcoming')
    expect(gamesKey('past')).equals('games.past')
    expect(gamesKey('all')).equals('games.all')
    expect(fallbackKeyOf('roster.full.t')).equals('roster.t')
    expect(fallbackKeyOf('roster.t')).equals(undefined)
  })
})

describe('the web client', function () {
  it('has no cached documents', async function () {
    const client = new TeamStationClient({ baseUrl: '/api/v1' })
    expect(await client.cached('home.teams', raw => raw)).equals(undefined)
  })
})
