import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { expect } from 'chai'
import { after, before, describe, it } from 'mocha'

import {
  asGameLineupsResponse,
  asRosterEntry,
  type SaveLineupsBody
} from '../../common/api'
import type { GumboPlay } from '../../common/gumboPlay'
import { makeId } from '../../common/ids'
import { userIdOfGumbo } from '../../common/userId'
import { startingContext } from '../../server/routes/lineups'
import { readSyncClock } from '../../server/socket/syncRevision'
import { type GroupFixture, groupFixture } from '../../test/groupFixtures'
import { nodeSqliteExecutor } from '../../test/nodeSqliteExecutor'
import { seedSettingsCleanup3 } from '../../test/settingsCleanup3Fixture'
import { cacheFileName, openCacheStore } from './cacheStore'
import { CachingClient } from './cachingClient'

/**
 * The phone's outbox against the real server: a `CachingClient` on
 * `node:sqlite`, sending to the HTTP harness through a transport the test
 * holds, drops, or lets through.
 */

const livePlay = (atBatIndex: number): GumboPlay =>
  ({
    about: { atBatIndex, inning: 1, halfInning: 'top', isScoringPlay: false },
    count: { outs: 1 },
    result: {
      eventType: 'single',
      awayScore: 0,
      homeScore: 0,
      description: 'Single'
    },
    playEvents: [{ isPitch: true }]
  }) as unknown as GumboPlay

const newPlayer = (
  firstName: string
): Parameters<CachingClient['createRosterPlayer']>[1] => ({
  firstName,
  lastName: 'Betts',
  jersey: '50',
  positions: ['RF'],
  bats: 'right',
  throws: 'right'
})

/** How the phone's requests fare on their way. */
interface Transport {
  /** Nothing leaves the phone. */
  held: boolean
  /** The next request reaches the server, and its answer is lost. */
  dropNext: boolean
  /** Every POST sent, with its key. */
  posts: Array<{ path: string; key: string | undefined; status: number }>
}

function phoneOn(
  f: GroupFixture,
  dir: string,
  user = 101
): { client: CachingClient; transport: Transport } {
  const transport: Transport = { held: false, dropNext: false, posts: [] }
  const fetchThrough = (async (url: string, init: RequestInit) => {
    if (transport.held) throw new TypeError('Load failed')
    const response = await fetch(url, init)
    if (init.method === 'POST')
      transport.posts.push({
        path: url.replace(`${f.h.origin}/api/v1`, ''),
        key: (init.headers as Record<string, string>)['idempotency-key'],
        status: response.status
      })
    if (transport.dropNext) {
      transport.dropNext = false
      await response.text()
      throw new TypeError('The network connection was lost.')
    }
    return response
  }) as unknown as typeof fetch
  const client = new CachingClient({
    baseUrl: `${f.h.origin}/api/v1`,
    token: f.h.tokens.get(user),
    fetch: fetchThrough,
    openCache: async userId =>
      await openCacheStore(
        nodeSqliteExecutor(join(dir, cacheFileName(userId)))
      ),
    outbox: {
      setTimer: () => 0,
      clearTimer: () => undefined
    }
  })
  client.openFor(userIdOfGumbo(user))
  return { client, transport }
}

/** The home side's lineup as the game opens on it, its order turned round. */
async function homeLineup(
  f: GroupFixture,
  gameId: string
): Promise<SaveLineupsBody> {
  const context = await startingContext(
    f.h.db,
    gameId,
    { home_team_id: f.teamA, away_team_id: f.teamB },
    () => true
  )
  const setup = context.setup
  const side = setup.sides.home
  const index = (id: number): number => side.players.indexOf(id)
  const read = asGameLineupsResponse(
    await (
      await f.h.request('GET', `/games/${gameId}/lineups`, undefined, 101)
    ).json()
  )
  return {
    side: 'home',
    base: read.digest,
    players: side.players.map(id => ({
      gumboId: setup.players[id].id,
      fullName: setup.players[id].fullName,
      jersey: setup.players[id].jersey
    })),
    battingOrder: side.battingOrder.map(index).reverse(),
    defense: Object.fromEntries(
      Object.entries(side.defense)
        .filter(([, id]) => id != null)
        .map(([position, id]) => [position, index(id!)])
    )
  }
}

async function playCount(f: GroupFixture, gameId: string): Promise<number> {
  const row = await f.h.db
    .selectFrom('events')
    .select(eb => eb.fn.countAll<string>().as('count'))
    .where('gameId', '=', gameId)
    .executeTakeFirstOrThrow()
  return Number(row.count)
}

async function playersNamed(
  f: GroupFixture,
  teamId: string,
  firstName: string
): Promise<string[]> {
  return (
    await f.h.db
      .selectFrom('memberships')
      .innerJoin('users', 'users.id', 'memberships.user_id')
      .select('users.id')
      .where('memberships.team_id', '=', teamId)
      .where('users.first_name', '=', firstName)
      .execute()
  ).map(row => row.id)
}

describe('the outbox against the server', function () {
  this.timeout(60000)
  let f: GroupFixture
  let dir: string

  before(async () => {
    f = await groupFixture()
    await seedSettingsCleanup3(f)
    dir = mkdtempSync(join(tmpdir(), 'teamstation-outbox-server-'))
  })
  after(async () => {
    rmSync(dir, { recursive: true, force: true })
    await f?.h.close()
  })

  it('sends a write again when its answer was lost, and the server keeps one of each (Lost response)', async function () {
    const { client, transport } = phoneOn(f, dir)
    const gameId = makeId('game')
    await f.h.db
      .insertInto('games')
      .values({
        id: gameId,
        home_team_id: f.teamA,
        away_team_id: f.teamB,
        season_id: f.seasonA,
        start_at: new Date(Date.now() + 3_600_000)
      })
      .execute()
    const lineupGame = 'gam_settings3_scheduled'
    await client.gameEvents(gameId)
    await client.gameLineups(lineupGame)
    await client.roster(f.teamA)

    // A live play: the server commits it, the phone never hears.
    transport.dropNext = true
    const queued = await client.saveGameEvents(gameId, {
      plays: [livePlay(0)],
      remove: []
    })
    expect(queued.playsDigest).match(/^local-/)
    expect(await playCount(f, gameId)).equals(1)
    // A roster player, the same.
    transport.dropNext = true
    const local = await client.createRosterPlayer(
      f.teamA,
      newPlayer('Vladimir')
    )
    expect(await playersNamed(f, f.teamA, 'Vladimir')).length(1)
    // And a lineup.
    const lineup = await homeLineup(f, lineupGame)
    const clock = Number(await readSyncClock(f.h.db))
    transport.dropNext = true
    await client.saveLineups(lineupGame, lineup)
    const saved = Number(await readSyncClock(f.h.db))
    expect(saved).greaterThan(clock)
    expect((await client.outboxSummary()).count).equals(3)

    client.wakeOutbox(true)
    await client.drainOutbox()
    expect((await client.outboxSummary()).count).equals(0)
    // Each was sent twice with one key, and answered the second time from
    // what the server stored.
    const keys = new Map<string, number>()
    for (const post of transport.posts)
      keys.set(post.key!, (keys.get(post.key!) ?? 0) + 1)
    expect([...keys.values()]).deep.equals([2, 2, 2])
    expect(await playCount(f, gameId)).equals(1)
    const made = await playersNamed(f, f.teamA, 'Vladimir')
    expect(made).length(1)
    expect(Number(await readSyncClock(f.h.db))).equals(saved)
    // The phone's copies are the server's now.
    const roster = await client.roster(f.teamA)
    const entry = roster.find(row => row.userId === made[0])!
    expect(entry.gumboId).not.equals(local.gumboId)
    expect(roster.some(row => row.gumboId === local.gumboId)).equals(false)
    expect((await client.gameEvents(gameId)).playsDigest).not.match(/^local-/)
  })
})

describe('S8: a stale game parks, and the other chain still lands', function () {
  this.timeout(60000)
  let f: GroupFixture
  let dir: string
  let started = 0
  const note = (line: string): void => {
    console.log(`      ${String(Date.now() - started).padStart(5)}ms ${line}`)
  }

  before(async () => {
    f = await groupFixture()
    await seedSettingsCleanup3(f)
    dir = mkdtempSync(join(tmpdir(), 'teamstation-outbox-park-'))
    started = Date.now()
  })
  after(async () => {
    rmSync(dir, { recursive: true, force: true })
    await f?.h.close()
  })

  it('parks the scoring row, lands the roster create, and leaves the other client’s lineup', async function () {
    const gameId = 'gam_settings3_scheduled'
    const { client, transport } = phoneOn(f, dir)
    const read = await client.gameEvents(gameId)
    await client.gameLineups(gameId)
    await client.roster(f.teamA)
    note(
      `phone read the game: lineupsDigest ${read.lineupsDigest!.slice(0, 12)}…`
    )

    transport.held = true
    note('transport held: nothing leaves the phone')
    await client.saveGameEvents(gameId, {
      plays: [livePlay(0)],
      remove: [],
      lineupsBase: read.lineupsDigest
    })
    const local = await client.createRosterPlayer(f.teamA, newPlayer('Jazz'))
    const queued = await client.outboxSummary()
    note(
      `outbox holds ${queued.count}: game:<gameId> scoring row, team:<teamId> roster create`
    )
    expect(queued.count).equals(2)

    const theirs = await f.h.request(
      'POST',
      `/games/${gameId}/lineups`,
      await homeLineup(f, gameId),
      101
    )
    expect(theirs.status).equals(200)
    const saved = asGameLineupsResponse(await theirs.json()).digest
    note(`second client saved the lineup: digest ${saved.slice(0, 12)}…`)

    transport.held = false
    note('transport released, outbox drains')
    client.wakeOutbox(true)
    await client.drainOutbox()
    for (const post of transport.posts)
      note(
        `  → POST ${post.path.replace(gameId, ':gameId').replace(f.teamA, ':teamId')} ← ${post.status}`
      )

    const summary = await client.outboxSummary()
    note(`outbox: ${JSON.stringify(summary).replace(gameId, ':gameId')}`)
    expect(summary.count).equals(1)
    expect(summary.games[gameId]).deep.equals({
      state: 'parked',
      message: 'Somebody else changed the lineups since this game was read'
    })
    expect(summary.teams).deep.equals({})

    const made = await playersNamed(f, f.teamA, 'Jazz')
    note(`server roster has the new player: ${made.length === 1}`)
    expect(made).length(1)
    const listed = asRosterEntry(
      (await client.roster(f.teamA)).find(row => row.userId === made[0])
    )
    expect(listed.gumboId).not.equals(local.gumboId)

    const plays = await playCount(f, gameId)
    note(`server plays for the game: ${plays}`)
    expect(plays).equals(0)
    const now = asGameLineupsResponse(
      await (
        await f.h.request('GET', `/games/${gameId}/lineups`, undefined, 102)
      ).json()
    )
    note(
      `server lineups digest is the second client's: ${now.digest === saved}`
    )
    expect(now.digest).equals(saved)
    // The phone keeps the game as it scored it.
    const kept = await client.gameEvents(gameId)
    note(`phone still shows its play: ${kept.plays.length === 1}`)
    expect(kept.plays).length(1)
  })
})
