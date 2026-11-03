import {
  type AddressInfo,
  connect as connectTo,
  createServer,
  type Socket
} from 'node:net'

import { expect } from 'chai'
import { Kysely, PostgresDialect } from 'kysely'
import { after, before, describe, it } from 'mocha'
import { Client, Pool } from 'pg'

import type { GameChange, PlayEditsData } from '../../common/gameSocket'
import { asPostEventsBody, type GumboPlay } from '../../common/gumboPlay'
import { makeId } from '../../common/ids'
import { userIdOfGumbo } from '../../common/userId'
import { migrations } from '../../migrate/migrations'
import { migrateUp } from '../../migrate/runner'
import { testDatabaseUrl } from '../../migrate/testDatabase'
import { mintUserId } from '../../test/historicalUserIds'
import { insertFixtureUsers } from '../../test/insertFixtureUsers'
import { silentValkey, untilAsked } from '../../test/silentValkey'
import type { GameScope } from '../access'
import { makeValkeyCache, type ValkeyCache } from '../cache/valkeyCache'
import { FEED_APPLICATION_NAME, PostgresFeed } from '../changeFeed/postgresFeed'
import { type Database, makeDatabase } from '../db/database'
import { playsDigest, postGamePlays, readPlays } from '../events/postPlays'
import { readWalkUpSong } from '../routes/walkUpSongs'
import { gameNamesDigest } from '../users/nameBook'
import { type FanoutSubscriber, GameFanout } from './fanout'
import { asGameChangePayload, GAME_CHANGES_CHANNEL } from './gameChanges'

const adminUrl = testDatabaseUrl
const scratchName = `teamstation_fanout_${Date.now()}_${process.pid}`
const scratchUrl = adminUrl.replace(/\/[^/]*$/, `/${scratchName}`)

const wait = async (ms: number): Promise<void> => {
  await new Promise(resolve => setTimeout(resolve, ms))
}

/** Waits until `ready` holds, or fails after two seconds. */
async function until(ready: () => boolean, what: string): Promise<void> {
  const deadline = Date.now() + 2000
  while (!ready()) {
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${what}`)
    await wait(10)
  }
}

/** A subscriber whose rights the test decides. */
interface Seeing {
  maySee: (game: GameScope) => Promise<boolean>
}

/** A subscriber that keeps what it is sent. */
function subscriber(sees = true): {
  sent: GameChange[]
  resynced: { count: number }
  send: (message: GameChange) => void
  token: string
  userId: string
  signedOut: () => void
  maySee: (game: GameScope) => Promise<boolean>
  resync: () => void
} {
  const sent: GameChange[] = []
  const resynced = { count: 0 }
  return {
    sent,
    resynced,
    resync: () => {
      resynced.count++
    },
    send: message => {
      sent.push(message)
    },
    token: 'token',
    userId: 'usr',
    signedOut: () => undefined,
    maySee: async () => sees
  }
}

/** U15: one `LISTEN` per worker, and what each hands its subscribers. */
describe('the game socket fan-out (U15)', function () {
  this.timeout(60000)

  let adminPool: Pool | undefined
  let db: Kysely<Database> | undefined
  let poker: Client | undefined
  const fanouts: GameFanout[] = []
  const feeds: PostgresFeed[] = []
  const logs: string[] = []
  const taken = new Set<number>()
  const mint = (): { userId: number; legacyId: string } => {
    const minted = mintUserId(id => taken.has(id))
    taken.add(minted.userId)
    return minted
  }
  const first = mint()
  const second = mint()
  const team = makeId('team')
  const rival = makeId('team')
  const other = makeId('team')
  const today = makeId('game')
  const later = makeId('game')
  const elsewhere = makeId('game')
  const scopeOf = (home: string, away: string): GameScope => ({
    homeTeamId: home,
    awayTeamId: away,
    seasonId: null
  })

  const feedOf = (retryMs: number): PostgresFeed => {
    const made = new PostgresFeed({
      databaseUrl: scratchUrl,
      retryMs,
      log: message => {
        logs.push(message)
      }
    })
    feeds.push(made)
    return made
  }

  const fanout = (
    options: Partial<ConstructorParameters<typeof GameFanout>[0]> = {}
  ): GameFanout => {
    const made = new GameFanout({
      db: db!,
      feed: feedOf(50),
      authorize: async (subscribers, game) =>
        await Promise.all(
          subscribers.map(
            async subscriber =>
              await (subscriber as unknown as Seeing).maySee(game)
          )
        ),
      log: message => {
        logs.push(message)
      },
      ...options
    })
    fanouts.push(made)
    return made
  }
  const notify = async (payload: unknown): Promise<void> => {
    await poker!.query('select pg_notify($1, $2)', [
      GAME_CHANGES_CHANNEL,
      JSON.stringify(payload)
    ])
  }

  before(async function () {
    adminPool = new Pool({ connectionString: adminUrl })
    try {
      await adminPool.query('select 1')
    } catch {
      await adminPool.end()
      adminPool = undefined
      this.skip()
      return
    }
    await adminPool.query(`create database ${scratchName}`)
    const pool = new Pool({ connectionString: scratchUrl })
    await migrateUp(pool, migrations)
    await pool.end()
    db = makeDatabase(scratchUrl)
    const now = new Date()
    await insertFixtureUsers(
      db,
      [first, second].map(user => ({
        id: user.userId,
        legacyId: user.legacyId,
        display_name: `User ${user.userId}`,
        created_at: now,
        updated_at: now
      }))
    )
    await db
      .insertInto('teams')
      .values([
        { id: team, name: 'Team', kind: 'full' },
        { id: rival, name: 'Rival', kind: 'full' },
        { id: other, name: 'Other', kind: 'full' }
      ])
      .execute()
    await db
      .insertInto('games')
      .values([
        {
          id: today,
          home_team_id: team,
          away_team_id: rival,
          start_at: now,
          status: 'inProgress',
          away_score: 3,
          home_score: 2
        },
        {
          id: later,
          home_team_id: rival,
          away_team_id: team,
          start_at: new Date(now.getTime() + 21 * 86_400_000)
        },
        {
          id: elsewhere,
          home_team_id: other,
          away_team_id: rival,
          start_at: now,
          status: 'final'
        }
      ])
      .execute()
    await db
      .insertInto('walk_up_songs')
      .values({
        team_id: team,
        user_id: userIdOfGumbo(first.userId),
        provider: 'appleMusic',
        provider_id: '1440857781',
        isrc: 'USFI86900049',
        title: 'Centerfield',
        artist: 'John Fogerty',
        album: 'Centerfield',
        artwork_url: null,
        duration_ms: 230000,
        start_ms: 10000,
        end_ms: 25000,
        set_by: userIdOfGumbo(first.userId)
      })
      .execute()
    poker = new Client({ connectionString: scratchUrl })
    await poker.connect()
  })

  after(async function () {
    for (const made of fanouts) await made.close()
    for (const made of feeds) await made.close()
    await poker?.end()
    if (db != null) await db.destroy()
    if (adminPool != null) {
      await adminPool.query(
        `drop database if exists ${scratchName} with (force)`
      )
      await adminPool.end()
    }
  })

  it('delivers a notify from a third connection through both workers', async function () {
    const one = fanout()
    const two = fanout()
    await Promise.all([one.listening, two.listening])
    const heardByOne = subscriber()
    const heardByTwo = subscriber()
    one.watch(today, scopeOf(team, rival), heardByOne)
    two.watch(today, scopeOf(team, rival), heardByTwo)
    await notify({ game: today, kind: 'game' })
    await until(
      () => heardByOne.sent.length === 1 && heardByTwo.sent.length === 1,
      'both workers'
    )
    for (const heard of [heardByOne, heardByTwo]) {
      expect(heard.sent[0]).to.include({
        type: 'change',
        gameId: today,
        kind: 'game'
      })
      // The teams and the generation too, so a screen opened on others, or
      // on the plays a reset deleted, reopens.
      expect(heard.sent[0].data).deep.equals({
        status: 'inProgress',
        awayScore: 3,
        homeScore: 2,
        homeTeamId: team,
        awayTeamId: rival,
        generation: 0,
        withdrawn: false
      })
      expect(new Date(heard.sent[0].at).getTime()).above(0)
    }
    one.unwatch(today, heardByOne)
    two.unwatch(today, heardByTwo)
    await one.close()
    await two.close()
  })

  it('sends identical notifies within 100 ms once, with the data at the end', async function () {
    const one = fanout()
    await one.listening
    const heard = subscriber()
    one.watch(today, scopeOf(team, rival), heard)
    const again = { game: today, kind: 'playEdits', generation: 0 }
    await notify(again)
    await notify(again)
    await notify(again)
    await until(() => heard.sent.length > 0, 'the plays')
    await wait(250)
    expect(heard.sent).lengthOf(1)
    // A writer that names no edits has the game read again.
    expect(heard.sent[0]).to.include({ kind: 'playEdits' })
    expect(heard.sent[0].data).deep.equals({
      generation: 0,
      fromDigest: null,
      digest: null,
      namesDigest: null,
      edits: null
    })
    // A later one, outside the window, is sent again.
    await notify(again)
    await until(() => heard.sent.length === 2, 'the second plays')
    await one.close()
  })

  it('reads an older worker’s plays notice as a read again', async function () {
    expect(asGameChangePayload({ game: today, kind: 'plays' })).deep.equals({
      game: today,
      kind: 'playEdits',
      generation: -1
    })
    const one = fanout()
    await one.listening
    const heard = subscriber()
    one.watch(today, scopeOf(team, rival), heard)
    await notify({ game: today, kind: 'plays' })
    await until(() => heard.sent.length > 0, 'the plays')
    expect(heard.sent[0]).to.include({ kind: 'playEdits' })
    // Under the game's own generation.
    expect(heard.sent[0].data).deep.equals({
      generation: 0,
      fromDigest: null,
      digest: null,
      namesDigest: null,
      edits: null
    })
    await one.close()
  })

  it('sends each of a live post’s edits within 100 ms, in order, even one that repeats an earlier one', async function () {
    const frames = new Map(
      [
        ['d0', 'd1'],
        ['d1', 'd0']
      ].map(([fromDigest, digest]) => [
        `playEdits:${today}:0:${fromDigest}:${digest}`,
        JSON.stringify({
          generation: 0,
          fromDigest,
          digest,
          edits: [],
          currentPlay: null
        })
      ])
    )
    const cache: ValkeyCache = {
      get: async key => frames.get(key) ?? null,
      set: async () => undefined,
      close: async () => undefined
    }
    const one = fanout({ cache })
    await one.listening
    const heard = subscriber()
    one.watch(today, scopeOf(team, rival), heard)
    const step = (fromDigest: string, digest: string): unknown => ({
      game: today,
      kind: 'playEdits',
      generation: 0,
      fromDigest,
      digest,
      indexes: [5],
      removed: []
    })
    // A put, the remove that undoes it, and the same put again: the third is
    // the first's twin, still waiting, and is sent all the same.
    await notify(step('d0', 'd1'))
    await notify(step('d1', 'd0'))
    await notify(step('d0', 'd1'))
    await until(() => heard.sent.length === 3, 'three edits')
    await wait(150)
    expect(
      heard.sent.map(message => (message.data as PlayEditsData).digest)
    ).deep.equals(['d1', 'd0', 'd1'])
    await one.close()
  })

  describe('a live post’s edits', function () {
    /** A Valkey of the test's own, which counts what it is asked. */
    const memoryCache = (): ValkeyCache & {
      held: Map<string, string>
      gets: string[]
    } => {
      const held = new Map<string, string>()
      const gets: string[] = []
      return {
        held,
        gets,
        get: async key => {
          gets.push(key)
          return held.get(key) ?? null
        },
        set: async (key, value) => {
          held.set(key, value)
        },
        close: async () => undefined
      }
    }
    /** A database whose statements, `begin` and `commit` among them, are kept. */
    const logged = (): { db: Kysely<Database>; statements: string[] } => {
      const statements: string[] = []
      return {
        statements,
        db: new Kysely<Database>({
          dialect: new PostgresDialect({
            pool: new Pool({ connectionString: scratchUrl })
          }),
          log: event => {
            if (event.level === 'query') statements.push(event.query.sql)
          }
        })
      }
    }
    const play = (
      index: number,
      batter: { userId: number },
      pitcher: { userId: number }
    ): Record<string, unknown> => ({
      about: { atBatIndex: index, inning: 1, halfInning: 'top' },
      result: { eventType: 'single', awayScore: 0, homeScore: 0 },
      matchup: {
        batter: { id: batter.userId, fullName: 'Stale Batter' },
        pitcher: { id: pitcher.userId, fullName: 'Stale Pitcher' }
      }
    })
    /** What `game_changes` carries for `game` while `act` runs. */
    const hearing = async (
      game: string,
      act: () => Promise<unknown>
    ): Promise<Array<Record<string, unknown>>> => {
      const listener = new Client({ connectionString: scratchUrl })
      await listener.connect()
      const heard: Array<Record<string, unknown>> = []
      listener.on('notification', message => {
        const payload = JSON.parse(message.payload ?? 'null') as Record<
          string,
          unknown
        > | null
        if (payload?.game === game) heard.push(payload)
      })
      try {
        await listener.query(`listen ${GAME_CHANGES_CHANNEL}`)
        await act()
        await listener.query('select 1')
        await wait(50)
        return heard
      } finally {
        await listener.end()
      }
    }
    const playNotices = (
      heard: Array<Record<string, unknown>>
    ): Array<Record<string, unknown>> =>
      heard.filter(payload => payload.kind === 'playEdits')
    /** The digest a post's answer says it left. */
    const digestOf = (answer: unknown): string =>
      (answer as { playsDigest: string }).playsDigest
    /** A new game between the test's teams, its first play posted. */
    const posted = async (): Promise<string> => {
      const id = makeId('game')
      await db!
        .insertInto('games')
        .values({
          id,
          home_team_id: team,
          away_team_id: rival,
          start_at: new Date()
        })
        .execute()
      await postGamePlays(
        db!,
        id,
        asPostEventsBody({
          mode: 'live',
          source: { system: 'manual' },
          plays: [play(0, first, second)]
        })
      )
      return id
    }
    /** Posts one more play live, and gives what was announced of it. */
    const postAnother = async (
      id: string,
      options: Parameters<typeof postGamePlays>[5] = {},
      body: Record<string, unknown> = { plays: [play(1, second, first)] }
    ): Promise<{
      notice: Record<string, unknown>
      answer: unknown
    }> => {
      let answer: unknown
      const heard = await hearing(id, async () => {
        answer = await postGamePlays(
          db!,
          id,
          asPostEventsBody({
            mode: 'live',
            source: { system: 'manual' },
            ...body
          }),
          undefined,
          undefined,
          options
        )
      })
      const notices = playNotices(heard)
      expect(notices).lengthOf(1)
      return { notice: notices[0], answer }
    }

    before(async function () {
      for (const [user, given, family] of [
        [first, 'Babe', 'Ruth'],
        [second, 'Cy', 'Young']
      ] as const)
        await db!
          .updateTable('users')
          .set({
            display_name: `${given} ${family}`,
            first_name: given,
            last_name: family
          })
          .where('id', '=', userIdOfGumbo(user.userId))
          .execute()
    })

    it('are announced once, with the digests, the indexes and the removes', async function () {
      const id = await posted()
      const before = await readPlays(db!, id)
      const { notice } = await postAnother(
        id,
        { answer: 'edits' },
        { plays: [play(1, second, first)], remove: [0] }
      )
      const after = await readPlays(db!, id)
      expect(notice).deep.equals({
        game: id,
        kind: 'playEdits',
        generation: 0,
        fromDigest: playsDigest(before, null),
        digest: playsDigest(after, null),
        // The book every viewer's read of the game is named from.
        namesDigest: await gameNamesDigest(db!, id),
        indexes: [1],
        removed: [0]
      })
    })

    it('are announced as a read again when they name more than 200 plays', async function () {
      const id = await posted()
      const many = Array.from({ length: 201 }, (_, index) =>
        play(index + 1, second, first)
      )
      const cache = memoryCache()
      const { notice, answer } = await postAnother(
        id,
        { answer: 'edits', cache },
        { plays: many }
      )
      // With the digest it left, which its sender holds.
      expect(notice).deep.equals({
        game: id,
        kind: 'playEdits',
        generation: 0,
        digest: digestOf(answer),
        namesDigest: await gameNamesDigest(db!, id)
      })
      // Nobody will ask for a frame of them.
      expect(cache.held.size).equals(0)
    })

    it('are announced as a read again when they bring in somebody outside the game’s plays, at-bat and event_players', async function () {
      const id = await posted()
      const newcomer = mint()
      await insertFixtureUsers(db!, [
        {
          id: newcomer.userId,
          legacyId: newcomer.legacyId,
          display_name: 'Babe Adams',
          created_at: new Date(),
          updated_at: new Date()
        }
      ])
      const cache = memoryCache()
      // Babe Ruth's short name can grow once another Babe is in the book,
      // on plays this post did not write.
      const { notice, answer } = await postAnother(
        id,
        { answer: 'edits', cache },
        { plays: [play(1, newcomer, first)] }
      )
      expect(notice).deep.equals({
        game: id,
        kind: 'playEdits',
        generation: 0,
        digest: digestOf(answer),
        namesDigest: await gameNamesDigest(db!, id)
      })
      expect(cache.held.size).equals(0)
      // The same people again are edits.
      const again = await postAnother(
        id,
        { answer: 'edits', cache },
        { plays: [play(2, newcomer, second)] }
      )
      expect(again.notice.indexes).deep.equals([2])
    })

    it('are announced as a read again when they take away the only play naming somebody, and as edits when the people stay', async function () {
      const id = await posted()
      const leaving = mint()
      await insertFixtureUsers(db!, [
        {
          id: leaving.userId,
          legacyId: leaving.legacyId,
          display_name: 'Babe Adams',
          created_at: new Date(),
          updated_at: new Date()
        }
      ])
      await postAnother(
        id,
        { answer: 'edits' },
        { plays: [play(1, leaving, first)] }
      )
      await postAnother(
        id,
        { answer: 'edits' },
        { plays: [play(2, second, first)] }
      )
      const cache = memoryCache()
      // Undone, the only play naming the other Babe leaves the book, and
      // its event_players with it: Babe Ruth's short name can shrink on
      // plays this post did not write.
      const { notice, answer } = await postAnother(
        id,
        { answer: 'edits', cache },
        { plays: [], remove: [1] }
      )
      expect(notice).deep.equals({
        game: id,
        kind: 'playEdits',
        generation: 0,
        digest: digestOf(answer),
        namesDigest: await gameNamesDigest(db!, id)
      })
      expect(cache.held.size).equals(0)
      // A play whose people the game names elsewhere is an edit to undo.
      const again = await postAnother(
        id,
        { answer: 'edits', cache },
        { plays: [], remove: [2] }
      )
      expect(again.notice).deep.include({ indexes: [], removed: [2] })
      expect(cache.held.size).equals(1)
    })

    it('are announced as edits when they bring in a player the game’s event_players already hold', async function () {
      const id = await posted()
      const rostered = mint()
      await insertFixtureUsers(db!, [
        {
          id: rostered.userId,
          legacyId: rostered.legacyId,
          display_name: 'Babe Adams',
          created_at: new Date(),
          updated_at: new Date()
        }
      ])
      // Imported as a fielder of the first play, which names him nowhere:
      // the book already tells him and Babe Ruth apart.
      const [event] = await readPlays(db!, id)
      await db!
        .insertInto('event_players')
        .values({
          id: makeId('eventPlayer'),
          event_id: event.id,
          gumbo_id: rostered.userId,
          team_id: rival,
          role: 'fielder',
          position: null
        })
        .execute()
      const cache = memoryCache()
      // His first time at the plate, as the at-bat in progress.
      const { notice } = await postAnother(
        id,
        { answer: 'edits', cache },
        {
          plays: [],
          currentPlay: {
            ...play(1, rostered, first),
            about: {
              atBatIndex: 1,
              inning: 1,
              halfInning: 'top',
              isComplete: false
            }
          }
        }
      )
      expect(notice).deep.include({ game: id, kind: 'playEdits', indexes: [] })
      expect(notice.fromDigest).to.be.a('string')
      const [frame] = [...cache.held.values()].map(
        value => JSON.parse(value) as PlayEditsData
      )
      expect(frame.edits).deep.equals([])
      expect(frame.currentPlay).to.have.nested.property(
        'matchup.batter.id',
        rostered.userId
      )
    })

    it('are announced as a read again by a replace post, and by a live post that leaves only the pregame lineups', async function () {
      const replaced = makeId('game')
      const pregame = makeId('game')
      await db!
        .insertInto('games')
        .values(
          [replaced, pregame].map(id => ({
            id,
            home_team_id: team,
            away_team_id: rival,
            start_at: new Date()
          }))
        )
        .execute()
      let answer: unknown
      const heard = await hearing(replaced, async () => {
        answer = await postGamePlays(
          db!,
          replaced,
          asPostEventsBody({
            source: { system: 'manual' },
            plays: [play(0, first, second)]
          })
        )
      })
      expect(playNotices(heard)).deep.equals([
        {
          game: replaced,
          kind: 'playEdits',
          generation: 0,
          digest: digestOf(answer),
          namesDigest: await gameNamesDigest(db!, replaced)
        }
      ])
      await db!
        .updateTable('games')
        .set({
          pregame: {
            version: 3,
            setupBefore: { players: {}, teams: {}, tagOrder: [] },
            actions: []
          }
        })
        .where('id', '=', pregame)
        .execute()
      // A post that removes nothing that is there leaves the lineups alone:
      // the at-bat a reader is answered is their fold.
      const lineups = await hearing(pregame, async () => {
        answer = await postGamePlays(
          db!,
          pregame,
          asPostEventsBody({
            mode: 'live',
            source: { system: 'manual' },
            plays: [],
            remove: [3]
          }),
          undefined,
          undefined,
          { answer: 'edits' }
        )
      })
      expect(playNotices(lineups)).deep.equals([
        {
          game: pregame,
          kind: 'playEdits',
          generation: 0,
          digest: digestOf(answer),
          namesDigest: await gameNamesDigest(db!, pregame)
        }
      ])
    })

    for (const answer of ['edits', 'all'] as const)
      it(`leave in Valkey the frame delivery would read (answer ${answer})`, async function () {
        const id = await posted()
        const cache = memoryCache()
        const { notice } = await postAnother(id, { answer, cache })
        expect(cache.held.size).equals(1)
        const [[key, value]] = [...cache.held]
        expect(key).equals(
          `playEdits:${id}:0:${String(notice.fromDigest)}:${String(notice.digest)}:${String(notice.namesDigest)}`
        )
        const frame = JSON.parse(value) as PlayEditsData
        expect(frame.edits).lengthOf(1)
        expect(frame.namesDigest).equals(await gameNamesDigest(db!, id))
        // Named from the accounts, as every viewer reads them.
        expect(
          (frame.edits![0] as { play: { gumbo: GumboPlay } }).play.gumbo.matchup
        ).deep.include({
          batter: { id: second.userId, fullName: 'Cy Y' },
          pitcher: { id: first.userId, fullName: 'Babe R' }
        })
        // A worker with no frame to hand reads and names the same.
        const reading = fanout()
        try {
          const heard = subscriber()
          reading.watch(id, scopeOf(team, rival), heard)
          await reading.deliver(JSON.stringify(notice))
          expect(heard.sent[0]).to.include({ kind: 'playEdits' })
          expect(heard.sent[0].data).deep.equals(frame)
        } finally {
          await reading.close()
        }
      })

    it('reach 200 sockets on two workers with one Valkey read each and no read of the plays', async function () {
      const id = await posted()
      const cache = memoryCache()
      const { notice } = await postAnother(id, { answer: 'edits', cache })
      const frame = JSON.parse([...cache.held.values()][0]) as PlayEditsData
      const { db: loggedDb, statements } = logged()
      const workers = [
        fanout({ db: loggedDb, cache }),
        fanout({ db: loggedDb, cache })
      ]
      try {
        const sockets = workers.map(worker =>
          Array.from({ length: 100 }, () => {
            const heard = subscriber()
            worker.watch(id, scopeOf(team, rival), heard)
            return heard
          })
        )
        cache.gets.length = 0
        await Promise.all(
          workers.map(async worker => {
            await worker.deliver(JSON.stringify(notice))
          })
        )
        for (const heard of sockets.flat())
          expect(heard.sent.map(message => message.data)).deep.equals([frame])
        expect(cache.gets).lengthOf(2)
        expect(
          statements.filter(sql => sql.includes('from "events"'))
        ).deep.equals([])
      } finally {
        for (const worker of workers) await worker.close()
        await loggedDb.destroy()
      }
    })

    it('are read once the transaction is done when Valkey has lost the frame', async function () {
      const id = await posted()
      const cache = memoryCache()
      const { notice } = await postAnother(id, { answer: 'edits', cache })
      const frame = JSON.parse([...cache.held.values()][0]) as PlayEditsData
      cache.held.clear()
      const { db: loggedDb, statements } = logged()
      const worker = fanout({ db: loggedDb, cache })
      try {
        const heard = subscriber()
        worker.watch(id, scopeOf(team, rival), heard)
        await worker.deliver(JSON.stringify(notice))
        expect(heard.sent.map(message => message.data)).deep.equals([frame])
        const committed = statements.indexOf('commit')
        const read = statements.findIndex(sql => sql.includes('from "events"'))
        expect(committed).above(-1)
        expect(read).above(committed)
      } finally {
        await worker.close()
        await loggedDb.destroy()
      }
    })

    it('send a read again when the plays have moved on, or the game was reset', async function () {
      const id = await posted()
      const cache = memoryCache()
      const { notice } = await postAnother(id, { answer: 'edits', cache })
      const worker = fanout({ cache })
      const again = {
        generation: 0,
        fromDigest: null,
        digest: null,
        namesDigest: null,
        edits: null
      }
      try {
        const heard = subscriber()
        worker.watch(id, scopeOf(team, rival), heard)
        // Not in Valkey, and the plays are no longer the ones it left.
        await worker.deliver(
          JSON.stringify({ ...notice, digest: 'somebody else' })
        )
        // With the digest the post left, which its own sender holds.
        expect(heard.sent[0].data).deep.equals({
          ...again,
          digest: 'somebody else',
          namesDigest: notice.namesDigest
        })
        // A post's re-read form passes on the digests it names.
        await worker.deliver(
          JSON.stringify({
            game: id,
            kind: 'playEdits',
            generation: 0,
            digest: 'left at',
            namesDigest: 'named from'
          })
        )
        expect(heard.sent[1].data).deep.equals({
          ...again,
          digest: 'left at',
          namesDigest: 'named from'
        })
        // The frame is there, but the game was reset since: the digest is
        // of another generation, and none goes with it.
        await db!
          .updateTable('games')
          .set({ play_generation: 1 })
          .where('id', '=', id)
          .execute()
        await worker.deliver(JSON.stringify(notice))
        expect(heard.sent[2].data).deep.equals({ ...again, generation: 1 })
      } finally {
        await worker.close()
      }
    })

    it('read a frame that does not read as lost', async function () {
      const id = await posted()
      const cache = memoryCache()
      const { notice } = await postAnother(id, { answer: 'edits', cache })
      const frame = JSON.parse([...cache.held.values()][0]) as PlayEditsData
      for (const key of cache.held.keys()) cache.held.set(key, '{')
      const worker = fanout({ cache })
      try {
        const heard = subscriber()
        worker.watch(id, scopeOf(team, rival), heard)
        await worker.deliver(JSON.stringify(notice))
        expect(heard.sent[0].data).deep.equals(frame)
      } finally {
        await worker.close()
      }
    })

    it('are posted and delivered in good time when Valkey stops answering', async function () {
      const valkey = await silentValkey()
      const silent = makeValkeyCache({
        redis: { url: valkey.url, prefix: 'fanout' },
        databaseUrl: scratchUrl,
        log: message => {
          logs.push(message)
        }
      })
      const worker = fanout({ cache: silent })
      try {
        await untilAsked(silent, valkey)
        valkey.silence()
        const id = await posted()
        let startedAt = Date.now()
        // The post gives up on its frame, and still names its edits.
        const { notice } = await postAnother(id, {
          answer: 'edits',
          cache: silent
        })
        expect(Date.now() - startedAt).below(1000)
        expect(notice.indexes).deep.equals([1])
        const heard = subscriber()
        worker.watch(id, scopeOf(team, rival), heard)
        startedAt = Date.now()
        // The delivery gives up on the frame and reads the plays itself.
        await worker.deliver(JSON.stringify(notice))
        expect(Date.now() - startedAt).below(1000)
        const data = heard.sent[0].data as PlayEditsData
        expect(data.digest).equals(notice.digest)
        expect(data.edits).lengthOf(1)
      } finally {
        await worker.close()
        await silent.close()
        await valkey.close()
      }
    })

  })

  it("sends a game's notices in the order their data was read, one delivery at a time", async function () {
    const one = fanout()
    try {
      // The first delivery is held inside its transaction, as a long fold
      // would hold it, while a second notice for the game is delivered.
      let release: () => void = () => undefined
      const held = new Promise<void>(resolve => {
        release = resolve
      })
      const asked: string[] = []
      const sent: string[] = []
      const holding: FanoutSubscriber & Seeing = {
        send: message => {
          sent.push(message.kind)
        },
        token: 'token',
        userId: 'usr',
        signedOut: () => undefined,
        maySee: async () => {
          asked.push(String(asked.length))
          if (asked.length === 1) await held
          return true
        },
        resync: () => undefined
      }
      one.watch(today, scopeOf(team, rival), holding)
      const first = one.deliver(
        JSON.stringify({ game: today, kind: 'playEdits', generation: 0 })
      )
      await until(() => asked.length === 1, 'the first delivery')
      const second = one.deliver(JSON.stringify({ game: today, kind: 'game' }))
      await wait(50)
      // The second waits its turn: not read, not sent.
      expect(asked).deep.equals(['0'])
      expect(sent).deep.equals([])
      release()
      await Promise.all([first, second])
      expect(sent).deep.equals(['playEdits', 'game'])
    } finally {
      await one.close()
    }
  })

  describe('with no connection to be had in time', function () {
    const poolTimeout = 'timeout exceeded when trying to connect'
    /** A database whose one connection is taken, so a checkout times out. */
    const starved = async (): Promise<{
      db: Kysely<Database>
      free: () => Promise<void>
    }> => {
      const pool = new Pool({
        connectionString: scratchUrl,
        max: 1,
        connectionTimeoutMillis: 50
      })
      const held = await pool.connect()
      const starvedDb = new Kysely<Database>({
        dialect: new PostgresDialect({ pool })
      })
      return {
        db: starvedDb,
        free: async () => {
          held.release()
          await starvedDb.destroy()
        }
      }
    }

    it('resyncs the game’s subscribers, and only that game’s', async function () {
      const { db: starvedDb, free } = await starved()
      const one = fanout({ db: starvedDb })
      await one.listening
      const onToday = subscriber()
      const onLater = subscriber()
      one.watch(today, scopeOf(team, rival), onToday)
      one.watch(later, scopeOf(rival, team), onLater)
      await one.deliver(
        JSON.stringify({ game: today, kind: 'playEdits', generation: 0 })
      )
      expect(onToday.sent).deep.equals([])
      expect(onToday.resynced.count).equals(1)
      expect(onLater.resynced.count).equals(0)
      expect(logs.some(line => line.startsWith(`resyncing ${today}`))).equals(
        true
      )
      await one.close()
      await free()
    })

    it('resyncs every game of the team, whose song it could not read', async function () {
      const one = fanout({
        readSong: async () => {
          throw new Error(poolTimeout)
        }
      })
      await one.listening
      const onToday = subscriber()
      const onElsewhere = subscriber()
      one.watch(today, scopeOf(team, rival), onToday)
      one.watch(elsewhere, scopeOf(other, rival), onElsewhere)
      await one.deliver(
        JSON.stringify({
          team,
          userId: userIdOfGumbo(first.userId),
          kind: 'walkUpSong'
        })
      )
      expect(onToday.resynced.count).equals(1)
      expect(onElsewhere.resynced.count).equals(0)
      await one.close()
    })

    it('carries on with the team’s other games', async function () {
      let reads = 0
      // A method of the real database, on the real database.
      const flaky = new Proxy(db!, {
        get(target, name) {
          if (name === 'transaction' && reads++ === 0)
            throw new Error(poolTimeout)
          const value = Reflect.get(target, name, target) as unknown
          return typeof value === 'function' ? value.bind(target) : value
        }
      })
      const two = fanout({ db: flaky })
      const onToday = subscriber()
      const onLater = subscriber()
      two.watch(today, scopeOf(team, rival), onToday)
      two.watch(later, scopeOf(rival, team), onLater)
      await two.listening
      await two.deliver(
        JSON.stringify({
          team,
          userId: userIdOfGumbo(first.userId),
          kind: 'walkUpSong'
        })
      )
      expect(onToday.resynced.count).equals(1)
      expect(onToday.sent).deep.equals([])
      expect(onLater.resynced.count).equals(0)
      expect(onLater.sent).to.have.length(1)
      await two.close()
    })

    it('resyncs a game whose delivery loses the pooler, and one after it has gone', async function () {
      // Stands between the fanout and the database, as a pooler does.
      const target = new URL(scratchUrl)
      const sockets = new Set<Socket>()
      const pooler = createServer(near => {
        const far = connectTo(Number(target.port), target.hostname)
        for (const socket of [near, far]) {
          sockets.add(socket)
          socket.on('error', () => undefined)
        }
        near.pipe(far).pipe(near)
      })
      await new Promise<void>(resolve => {
        pooler.listen(0, '127.0.0.1', resolve)
      })
      const proxied = new URL(scratchUrl)
      proxied.hostname = '127.0.0.1'
      proxied.port = String((pooler.address() as AddressInfo).port)
      const pool = new Pool({ connectionString: proxied.toString() })
      pool.on('connect', client => {
        client.on('error', () => undefined)
      })
      pool.on('error', () => undefined)
      const proxiedDb = new Kysely<Database>({
        dialect: new PostgresDialect({ pool })
      })
      const one = fanout({
        db: proxiedDb,
        authorize: async subscribers => {
          // The pooler dies with the game's transaction open and in hand.
          for (const socket of sockets) socket.destroy()
          pooler.close()
          await new Promise(resolve => setTimeout(resolve, 50))
          return subscribers.map(() => true)
        }
      })
      await one.listening
      const onToday = subscriber()
      one.watch(today, scopeOf(team, rival), onToday)
      await one.deliver(JSON.stringify({ game: today, kind: 'game' }))
      expect(onToday.resynced.count).equals(1)
      expect(onToday.sent).deep.equals([])
      // Nothing listens now, so the next one cannot even connect.
      await one.deliver(JSON.stringify({ game: today, kind: 'game' }))
      expect(onToday.resynced.count).equals(2)
      await one.close()
      await proxiedDb.destroy()
    })

    it('still throws any other failure, resyncing nobody', async function () {
      const one = fanout({
        readSong: async () => {
          throw new Error('something else')
        }
      })
      await one.listening
      const onToday = subscriber()
      one.watch(today, scopeOf(team, rival), onToday)
      let failure: unknown
      await one
        .deliver(
          JSON.stringify({
            team,
            userId: userIdOfGumbo(first.userId),
            kind: 'walkUpSong'
          })
        )
        .catch((error: unknown) => {
          failure = error
        })
      expect(String(failure)).contains('something else')
      expect(onToday.resynced.count).equals(0)
      await one.close()
    })
  })

  it('sends two players’ songs, to every game of the team, whenever it is', async function () {
    const one = fanout()
    await one.listening
    const onToday = subscriber()
    const onLater = subscriber()
    const onElsewhere = subscriber()
    one.watch(today, scopeOf(team, rival), onToday)
    one.watch(later, scopeOf(rival, team), onLater)
    one.watch(elsewhere, scopeOf(other, rival), onElsewhere)
    await notify({
      team,
      kind: 'walkUpSong',
      userId: userIdOfGumbo(first.userId)
    })
    await notify({
      team,
      kind: 'walkUpSong',
      userId: userIdOfGumbo(second.userId)
    })
    await until(
      () => onToday.sent.length === 2 && onLater.sent.length === 2,
      'both songs on both games'
    )
    await wait(150)
    expect(onElsewhere.sent).lengthOf(0)
    const songs = onToday.sent.map(message => message.data)
    expect(songs).to.deep.include({
      teamId: team,
      userId: userIdOfGumbo(second.userId),
      song: null
    })
    expect(songs).to.deep.include({
      teamId: team,
      userId: userIdOfGumbo(first.userId),
      song: {
        provider: 'appleMusic',
        providerId: '1440857781',
        isrc: 'USFI86900049',
        title: 'Centerfield',
        artist: 'John Fogerty',
        album: 'Centerfield',
        artworkUrl: null,
        durationMs: 230000,
        startMs: 10000,
        endMs: 25000
      }
    })
    expect(onLater.sent.map(message => message.gameId)).deep.equals([
      later,
      later
    ])
    expect(onLater.sent.every(message => message.kind === 'walkUpSong')).equals(
      true
    )
    await one.close()
  })

  it('sends the lineups as the lineups route answers them', async function () {
    const one = fanout()
    const heard = subscriber()
    one.watch(today, scopeOf(team, rival), heard)
    await one.deliver(JSON.stringify({ game: today, kind: 'lineups' }))
    expect(heard.sent).lengthOf(1)
    const data = heard.sent[0].data as {
      home: { teamId: string; teamName: string; start: unknown }
      away: { teamId: string; teamName: string }
    }
    expect(data.home).to.include({
      teamId: team,
      teamName: 'Team',
      start: null
    })
    expect(data.away).to.include({ teamId: rival, teamName: 'Rival' })
    // U22: with the digest the game keeps, or, before any live post has
    // kept one, the one a post would.
    const digest = (heard.sent[0].data as { digest: string }).digest
    expect(digest).match(/^[0-9a-f]{64}$/)
    await db!
      .updateTable('games')
      .set({ lineups_digest: 'kept' })
      .where('id', '=', today)
      .execute()
    try {
      await one.deliver(JSON.stringify({ game: today, kind: 'lineups' }))
      expect((heard.sent[1].data as { digest: string }).digest).equals('kept')
    } finally {
      await db!
        .updateTable('games')
        .set({ lineups_digest: null })
        .where('id', '=', today)
        .execute()
    }
    await one.close()
  })

  it('skips a subscriber who may no longer see the game, and games nobody here watches', async function () {
    const one = fanout()
    const sees = subscriber()
    const blind = subscriber(false)
    one.watch(today, scopeOf(team, rival), sees)
    one.watch(today, scopeOf(team, rival), blind)
    one.watch(today, scopeOf(team, rival), blind)
    expect(one.games()).deep.equals([today])
    await one.deliver(JSON.stringify({ game: today, kind: 'game' }))
    expect(sees.sent).lengthOf(1)
    expect(blind.sent).lengthOf(0)
    // Nobody watches it here, so it is not read at all.
    await one.deliver(JSON.stringify({ game: elsewhere, kind: 'game' }))
    await one.deliver(
      JSON.stringify({
        team: other,
        kind: 'walkUpSong',
        userId: userIdOfGumbo(1)
      })
    )
    expect(sees.sent).lengthOf(1)
    one.unwatch(today, sees)
    one.unwatch(today, blind)
    one.unwatch(later, blind)
    expect(one.games()).deep.equals([])
    await one.close()
  })

  it('sends nothing for a game that has gone, and logs what does not read', async function () {
    const gone = makeId('game')
    await db!
      .insertInto('games')
      .values({
        id: gone,
        home_team_id: team,
        away_team_id: rival,
        start_at: new Date()
      })
      .execute()
    const one = fanout()
    const heard = subscriber()
    one.watch(gone, scopeOf(team, rival), heard)
    await db!.deleteFrom('games').where('id', '=', gone).execute()
    await one.deliver(
      JSON.stringify({ game: gone, kind: 'playEdits', generation: 0 })
    )
    expect(heard.sent).lengthOf(0)
    logs.length = 0
    await one.deliver('not json')
    await one.deliver(JSON.stringify({ game: gone, kind: 'weather' }))
    // A play notice with no generation.
    await one.deliver(JSON.stringify({ game: gone, kind: 'playEdits' }))
    expect(logs).lengthOf(3)
    expect(logs[0]).match(/does not read/)
    // Heard twice in one window, it is read once each time it is heard, and
    // merged, so logged once.
    logs.length = 0
    one.notified('not json')
    one.notified('not json')
    await wait(150)
    expect(logs).deep.equals(['ignoring a notify that does not read: not json'])
    one.notified(undefined)
    await one.close()
    // Closed, a notify is dropped.
    one.notified(JSON.stringify({ game: gone, kind: 'game' }))
  })

  it('logs a send that fails', async function () {
    const one = fanout({
      readSong: async () => {
        throw new Error('no songs today')
      },
      coalesceMs: 1
    })
    one.watch(today, scopeOf(team, rival), subscriber())
    logs.length = 0
    one.notified(
      JSON.stringify({ team, kind: 'walkUpSong', userId: userIdOfGumbo(1) })
    )
    await until(() => logs.length > 0, 'the log')
    expect(logs[0]).match(/no songs today/)
    await one.close()
  })

  it('resyncs once the feed has returned, not while it is away, and hears the next change', async function () {
    let resyncs = 0
    const before = logs.length
    const one = fanout({
      feed: feedOf(300),
      onResync: () => {
        resyncs++
      }
    })
    await one.listening
    expect(resyncs).equals(0)
    const heard = subscriber()
    one.watch(today, scopeOf(team, rival), heard)
    await adminPool!.query(
      `select pg_terminate_backend(pid) from pg_stat_activity
       where datname = $1 and application_name = $2`,
      [scratchName, FEED_APPLICATION_NAME]
    )
    await until(
      () => logs.slice(before).some(line => line.includes('lost the feed')),
      'the loss'
    )
    expect(resyncs).equals(0)
    await until(() => resyncs === 1, 'the return')
    await until(() => {
      notify({ game: today, kind: 'game' }).catch(() => undefined)
      return heard.sent.length > 0
    }, 'a change after the return')
    expect(resyncs).equals(1)
    await one.close()
  })

  it('reads no song for a player who has none', async function () {
    expect(
      await readWalkUpSong(db!, rival, userIdOfGumbo(first.userId))
    ).equals(null)
  })
})
