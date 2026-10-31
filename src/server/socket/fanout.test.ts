import { expect } from 'chai'
import { Kysely, PostgresDialect } from 'kysely'
import { after, before, describe, it } from 'mocha'
import { Client, Pool } from 'pg'

import type { GameChange } from '../../common/gameSocket'
import { asPostEventsBody, type GumboPlay } from '../../common/gumboPlay'
import { makeId } from '../../common/ids'
import { userIdOfGumbo } from '../../common/userId'
import { migrations } from '../../migrate/migrations'
import { migrateUp } from '../../migrate/runner'
import { testDatabaseUrl } from '../../migrate/testDatabase'
import { mintUserId } from '../../test/historicalUserIds'
import { insertFixtureUsers } from '../../test/insertFixtureUsers'
import type { GameScope } from '../access'
import { type Database, makeDatabase } from '../db/database'
import { atBatOf } from '../events/atBatInProgress'
import { playsDigest, postGamePlays, readPlays } from '../events/postPlays'
import { readWalkUpSong } from '../routes/walkUpSongs'
import { GameFanout } from './fanout'
import { GAME_CHANGES_CHANNEL } from './gameChanges'

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

/** A subscriber that keeps what it is sent. */
function subscriber(sees = true): {
  sent: GameChange[]
  resynced: { count: number }
  send: (message: GameChange) => void
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

  const fanout = (
    options: Partial<ConstructorParameters<typeof GameFanout>[0]> = {}
  ): GameFanout => {
    const made = new GameFanout({
      db: db!,
      databaseUrl: scratchUrl,
      retryMs: 50,
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
    await notify({ game: today, kind: 'plays' })
    await notify({ game: today, kind: 'plays' })
    await notify({ game: today, kind: 'plays' })
    await until(() => heard.sent.length > 0, 'the plays')
    await wait(250)
    expect(heard.sent).lengthOf(1)
    // With the digest `GET /events` and a post's answer give the same plays.
    expect(heard.sent[0].data).deep.equals({
      plays: [],
      currentPlay: null,
      digest: playsDigest([], null)
    })
    // A later one, outside the window, is sent again.
    await notify({ game: today, kind: 'plays' })
    await until(() => heard.sent.length === 2, 'the second plays')
    await one.close()
  })

  it('sends the plays named from the accounts, with the digest of the stored rows', async function () {
    const named = makeId('game')
    await db!
      .insertInto('games')
      .values({
        id: named,
        home_team_id: team,
        away_team_id: rival,
        start_at: new Date()
      })
      .execute()
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
    await postGamePlays(
      db!,
      named,
      asPostEventsBody({
        source: { system: 'manual' },
        plays: [
          {
            about: { atBatIndex: 0, inning: 1, halfInning: 'top' },
            result: { eventType: 'single', awayScore: 0, homeScore: 0 },
            matchup: {
              batter: { id: first.userId, fullName: 'Stale Batter' },
              pitcher: { id: second.userId, fullName: 'Stale Pitcher' }
            }
          }
        ]
      })
    )
    const one = fanout()
    try {
      const heard = subscriber()
      one.watch(named, scopeOf(team, rival), heard)
      await one.deliver(JSON.stringify({ game: named, kind: 'plays' }))
      const data = heard.sent[0].data as {
        plays: Array<{ gumbo: GumboPlay }>
        digest: string
      }
      expect(data.plays[0].gumbo.matchup).deep.include({
        batter: { id: first.userId, fullName: 'Babe R' },
        pitcher: { id: second.userId, fullName: 'Cy Y' }
      })
      const rows = await readPlays(db!, named)
      // The stored row names nobody: the name it was posted with is gone.
      expect(JSON.stringify(rows[0].gumbo)).not.includes('Stale Batter')
      expect(data.digest).equals(playsDigest(rows, null))
    } finally {
      await one.close()
    }
  })

  it('sends a game before its first pitch with its pregame lineups as the at-bat', async function () {
    const pregame = {
      version: 3,
      setupBefore: { players: {}, teams: {}, tagOrder: [] },
      actions: []
    }
    await db!
      .updateTable('games')
      .set({ pregame })
      .where('id', '=', today)
      .execute()
    const one = fanout()
    try {
      const heard = subscriber()
      one.watch(today, scopeOf(team, rival), heard)
      await one.deliver(JSON.stringify({ game: today, kind: 'plays' }))
      const data = heard.sent[0].data as {
        currentPlay: { about: { atBatIndex: number; inning: number } }
        digest: string
      }
      expect(data.currentPlay.about).deep.include({ atBatIndex: 0, inning: 1 })
      // The digest is of what is stored, as `GET /events` gives it.
      const stored = await db!
        .selectFrom('games')
        .select(['currentPlay', 'pregame'])
        .where('id', '=', today)
        .executeTakeFirstOrThrow()
      expect(data.digest).equals(playsDigest([], atBatOf(stored, false)))
    } finally {
      await one.close()
      await db!
        .updateTable('games')
        .set({ pregame: null })
        .where('id', '=', today)
        .execute()
    }
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
      one.watch(today, scopeOf(team, rival), {
        send: message => {
          sent.push(message.kind)
        },
        maySee: async () => {
          asked.push(String(asked.length))
          if (asked.length === 1) await held
          return true
        },
        resync: () => undefined
      })
      const first = one.deliver(JSON.stringify({ game: today, kind: 'plays' }))
      await until(() => asked.length === 1, 'the first delivery')
      const second = one.deliver(JSON.stringify({ game: today, kind: 'game' }))
      await wait(50)
      // The second waits its turn: not read, not sent.
      expect(asked).deep.equals(['0'])
      expect(sent).deep.equals([])
      release()
      await Promise.all([first, second])
      expect(sent).deep.equals(['plays', 'game'])
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
      await one.deliver(JSON.stringify({ game: today, kind: 'plays' }))
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
    await one.deliver(JSON.stringify({ game: gone, kind: 'plays' }))
    expect(heard.sent).lengthOf(0)
    logs.length = 0
    await one.deliver('not json')
    await one.deliver(JSON.stringify({ game: gone, kind: 'weather' }))
    expect(logs).lengthOf(2)
    expect(logs[0]).match(/does not read/)
    one.notified(undefined)
    await one.close()
    // Closed, a notify is dropped.
    one.notified(JSON.stringify({ game: gone, kind: 'plays' }))
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

  it('reports a lost listener, and listens again', async function () {
    let lost = 0
    const one = fanout({
      onLost: () => {
        lost++
      }
    })
    await one.listening
    const heard = subscriber()
    one.watch(today, scopeOf(team, rival), heard)
    await adminPool!.query(
      `select pg_terminate_backend(pid) from pg_stat_activity
       where datname = $1 and query ilike 'listen %'`,
      [scratchName]
    )
    await until(() => lost === 1, 'the loss')
    expect(logs.some(line => line.includes('lost the game_changes'))).equals(
      true
    )
    // Listening again, it hears the next change.
    await until(() => {
      notify({ game: today, kind: 'game' }).catch(() => undefined)
      return heard.sent.length > 0
    }, 'a change after listening again')
    await one.close()
  })

  it('retries a listener that cannot connect, and stops when closed', async function () {
    let lost = 0
    const one = fanout({
      databaseUrl: adminUrl.replace(/\/[^/]*$/, '/teamstation_no_such_db'),
      onLost: () => {
        lost++
      }
    })
    await one.listening
    await until(() => lost >= 2, 'two failed attempts')
    await one.close()
    const counted = lost
    await wait(150)
    expect(lost).equals(counted)
  })

  it('reads no song for a player who has none', async function () {
    expect(
      await readWalkUpSong(db!, rival, userIdOfGumbo(first.userId))
    ).equals(null)
  })
})
