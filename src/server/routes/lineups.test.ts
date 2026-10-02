import type { AddressInfo } from 'node:net'

import { expect } from 'chai'
import express from 'express'
import type { Insertable, Kysely } from 'kysely'
import { after, before, describe, it } from 'mocha'
import { Pool } from 'pg'

import { asDjGame, asGameLineupsResponse } from '../../common/api'
import { asPostEventsBody } from '../../common/gumboPlay'
import { makeId } from '../../common/ids'
import { mintUserId } from '../../common/mintUserId'
import { newSetup } from '../../common/scoring/lineup'
import { asDefaultLineup } from '../../common/scoring/lineupHistory'
import { ScoringSession } from '../../common/scoring/session'
import { migrations } from '../../migrate/migrations'
import { migrateUp } from '../../migrate/runner'
import { testDatabaseUrl } from '../../migrate/testDatabase'
import { hashToken } from '../auth/tokens'
import { type Database, makeDatabase } from '../db/database'
import { postGamePlays } from '../events/postPlays'
import { jsonBody } from '../jsonBody'
import { withActor } from '../middleware/withAuth'
import { errorHandler } from '../middleware/withErrors'
import { lineupRoutes } from './lineups'

const adminUrl = testDatabaseUrl
const scratchName = `teamstation_lineups_route_${Date.now()}`
const scratchUrl = adminUrl.replace(/\/[^/]*$/, `/${scratchName}`)

const MEMBER = 'tok_lineups_member_000000000000000'
const STRANGER = 'tok_lineups_stranger_0000000000000'
const ADMIN = 'tok_lineups_admin_0000000000000000'
const SONGKEEPER = 'tok_lineups_songkeeper_00000000000'
const SCOREKEEPER = 'tok_lineups_scorekeeper_0000000000'

/** U11: the default lineup and a game's lineups, read back. */
describe('the lineup routes (U11)', function () {
  this.timeout(60000)

  let adminPool: Pool | undefined
  let db: Kysely<Database> | undefined
  let server: ReturnType<express.Express['listen']> | undefined
  let base = ''
  const taken = new Set<number>()
  const mint = (): { userId: number; legacyId: string } => {
    const minted = mintUserId(id => taken.has(id))
    taken.add(minted.userId)
    return minted
  }
  const member = mint()
  const stranger = mint()
  const admin = mint()
  const songkeeper = mint()
  const scorekeeper = mint()
  const players = Array.from({ length: 18 }, mint)
  /** The bare team's players, by the name each is given. */
  const bench = { Zed: mint(), Amy: mint(), Bob: mint(), Cal: mint() }
  const BENCH_JERSEYS = { Zed: '3', Amy: '12', Bob: null, Cal: '3' }
  const home = makeId('team')
  const away = makeId('team')
  const other = makeId('team')
  const bare = makeId('team')
  const scored = makeId('game')
  const imported = makeId('game')
  const hidden = makeId('game')
  const fresh = makeId('game')
  const benchGame = makeId('game')
  const TEAMS = {
    away: { id: away, name: 'Visitors' },
    home: { id: home, name: 'Hosts' }
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
    await db
      .insertInto('users')
      .values(
        [member, stranger, admin, songkeeper, scorekeeper, ...players].map(
          user => ({
            id: user.userId,
            legacyId: user.legacyId,
            display_name: `User ${user.userId}`,
            is_admin: user === admin,
            created_at: now,
            updated_at: now
          })
        )
      )
      .execute()
    await db
      .insertInto('users')
      .values(
        Object.entries(bench).map(([name, user]) => ({
          id: user.userId,
          legacyId: user.legacyId,
          display_name: name,
          created_at: now,
          updated_at: now
        }))
      )
      .execute()
    await db
      .insertInto('auth_sessions')
      .values(
        (
          [
            [member, MEMBER],
            [stranger, STRANGER],
            [admin, ADMIN],
            [songkeeper, SONGKEEPER],
            [scorekeeper, SCOREKEEPER]
          ] as const
        ).map(([user, token]) => ({
          id: `ses_${token}`,
          user_id: user.userId,
          token_hash: hashToken(token),
          created_at: now,
          expires_at: new Date(now.getTime() + 3_600_000)
        }))
      )
      .execute()
    await db
      .insertInto('teams')
      .values([
        { id: home, name: 'Hosts', kind: 'full' },
        { id: away, name: 'Visitors', kind: 'full' },
        { id: other, name: 'Others', kind: 'full' },
        { id: bare, name: 'Bench', kind: 'full' }
      ])
      .execute()
    await db
      .insertInto('games')
      .values([
        { id: scored, home_team_id: home, away_team_id: away, start_at: now },
        { id: imported, home_team_id: home, away_team_id: away, start_at: now },
        { id: hidden, home_team_id: other, away_team_id: away, start_at: now },
        { id: fresh, home_team_id: home, away_team_id: away, start_at: now },
        { id: benchGame, home_team_id: home, away_team_id: bare, start_at: now }
      ])
      .execute()
    await db
      .insertInto('memberships')
      .values([
        {
          id: makeId('membership'),
          user_id: member.userId,
          team_id: home,
          role: 'member'
        },
        {
          id: makeId('membership'),
          user_id: songkeeper.userId,
          team_id: away,
          role: 'member'
        },
        {
          id: makeId('membership'),
          user_id: scorekeeper.userId,
          team_id: away,
          role: 'member'
        },
        // The bench team's players, and one member who is not a player.
        ...Object.entries(bench).map(([name, user]) => ({
          id: makeId('membership'),
          user_id: user.userId,
          team_id: bare,
          role: 'member' as const,
          is_player: true,
          jersey: BENCH_JERSEYS[name as keyof typeof BENCH_JERSEYS]
        })),
        {
          id: makeId('membership'),
          user_id: member.userId,
          team_id: bare,
          role: 'member'
        }
      ])
      .execute()
    await db
      .insertInto('scope_roles')
      .values([
        {
          id: makeId('scopeRole'),
          user_id: songkeeper.userId,
          scope_type: 'team',
          scope_id: away,
          role: 'songkeeper'
        },
        {
          id: makeId('scopeRole'),
          user_id: scorekeeper.userId,
          scope_type: 'team',
          scope_id: away,
          role: 'scorekeeper'
        }
      ])
      .execute()
    // A1's song on the visitors, and another for him on the hosts, which
    // the visitors' list must not show; and Amy's on the bench team.
    const song = (
      teamId: string,
      userId: number,
      title: string
    ): Insertable<Database['walk_up_songs']> => ({
      team_id: teamId,
      user_id: userId,
      provider: 'localFile',
      provider_id: 'lf:0123456789abcdef',
      title,
      artist: 'Band',
      duration_ms: 180000,
      start_ms: 10000,
      end_ms: 25000,
      set_by: admin.userId
    })
    await db
      .insertInto('walk_up_songs')
      .values([
        song(away, players[0].userId, 'Away Song'),
        song(home, players[0].userId, 'Home Song'),
        song(bare, bench.Amy.userId, 'Amy Song')
      ])
      .execute()

    // The scored game: a pinch hitter for the second batter, after a pitch.
    const setup = newSetup(TEAMS, {
      away: players.slice(0, 9).map((user, i) => ({
        userId: user.userId,
        shortName: `A${i + 1}`,
        jersey: String(i + 1)
      })),
      home: players.slice(9).map((user, i) => ({
        userId: user.userId,
        shortName: `H${i + 1}`,
        jersey: String(i + 1)
      }))
    })
    const database = db
    const session = await ScoringSession.open(
      {
        load: async () => ({ plays: [], currentPlay: null }),
        save: async (gameId, change) => {
          const posted = await postGamePlays(
            database,
            gameId,
            asPostEventsBody({
              mode: 'live',
              source: { system: 'teamstation' },
              plays: change.plays,
              remove: change.remove,
              currentPlay: change.currentPlay
            })
          )
          return {
            plays: posted.plays.map(row => row.gumbo as never),
            currentPlay: posted.currentPlay as never
          }
        }
      },
      scored,
      { gamePk: scored, teams: TEAMS, setup }
    )
    for (const action of [
      { type: 'pitch', call: 'C' },
      { type: 'pitch', call: 'C' },
      { type: 'pitch', call: 'C' },
      { type: 'gameFlow', kind: 'closePlay' },
      {
        type: 'lineup',
        kind: 'addPlayer',
        side: 'away',
        name: 'Guest',
        jersey: '77'
      },
      {
        type: 'lineup',
        kind: 'substitute',
        side: 'away',
        player: 19,
        replaces: 2
      }
    ] as const)
      expect(session.apply(action).problems).deep.equals([])
    await session.flush()
    expect(session.problem).equals(null)

    // An imported game: a substitution and nothing TeamStation recorded.
    await postGamePlays(
      db,
      imported,
      asPostEventsBody({
        plays: [
          {
            about: { atBatIndex: 0, inning: 1, halfInning: 'top' },
            result: { eventType: 'single', awayScore: 0, homeScore: 0 },
            playEvents: [
              {
                isSubstitution: true,
                details: {
                  eventType: 'pitching_substitution',
                  description: 'Pitching Change: Hal replaces Hank.'
                },
                player: { fullName: 'Hal' },
                position: { abbreviation: 'P' }
              }
            ]
          }
        ]
      })
    )

    const app = express()
    app.use(jsonBody)
    app.use(withActor(db))
    app.use('/api/v1', lineupRoutes(db))
    app.use(errorHandler)
    server = app.listen(0, '127.0.0.1')
    await new Promise<void>(resolve => server?.once('listening', resolve))
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/v1`
  })

  after(async function () {
    server?.close()
    if (db != null) await db.destroy()
    if (adminPool != null) {
      await adminPool.query(`drop database if exists ${scratchName}`)
      await adminPool.end()
    }
  })

  async function get(
    path: string,
    token: string | null
  ): Promise<{ status: number; body: unknown }> {
    const response = await fetch(`${base}${path}`, {
      headers: token == null ? {} : { authorization: `Bearer ${token}` }
    })
    return { status: response.status, body: await response.json() }
  }

  it("reads a team's default lineup, or nulls for none", async function () {
    // The scored game has begun, so it gave both teams theirs.
    const kept = await get(`/teams/${home}/default-lineup`, MEMBER)
    expect(kept.status).equals(200)
    const lineup = asDefaultLineup(kept.body)
    expect(lineup.fromGameId).equals(scored)
    expect(lineup.lineup?.batters.map(person => person.name)).deep.equals([
      'H1',
      'H2',
      'H3',
      'H4',
      'H5',
      'H6',
      'H7',
      'H8',
      'H9'
    ])
    expect(lineup.setAt).a('string')
    expect(
      (await get(`/teams/${other}/default-lineup`, ADMIN)).body
    ).deep.equals({ lineup: null, fromGameId: null, setAt: null })
    // A default that no longer reads is none.
    await db!
      .updateTable('teams')
      .set({ default_lineup: { lineup: 'nonsense' } })
      .where('id', '=', other)
      .execute()
    expect(
      (await get(`/teams/${other}/default-lineup`, ADMIN)).body
    ).deep.equals({ lineup: null, fromGameId: null, setAt: null })
  })

  it('hides a default from somebody who cannot see the team', async function () {
    expect(
      (await get(`/teams/${home}/default-lineup`, STRANGER)).status
    ).equals(404)
    expect((await get(`/teams/nope/default-lineup`, ADMIN)).status).equals(404)
    expect((await get(`/teams/${home}/default-lineup`, null)).status).equals(
      401
    )
  })

  it("reads both sides' start, changes and current lineup of a game", async function () {
    const answer = await get(`/games/${scored}/lineups`, MEMBER)
    expect(answer.status).equals(200)
    const read = asGameLineupsResponse(answer.body)
    expect(read.away).deep.include({ teamId: away, teamName: 'Visitors' })
    expect(read.home).deep.include({ teamId: home, teamName: 'Hosts' })
    expect(read.away.start?.batters[1].name).equals('A2')
    expect(read.away.current?.batters[1]).deep.equals({
      userId: null,
      name: 'Guest',
      jersey: '77'
    })
    expect(
      read.away.changes.map(change => [
        change.atBatIndex,
        change.eventType,
        change.position,
        change.battingOrder,
        change.player.name,
        change.replaced?.name
      ])
    ).deep.equals([[1, 'offensive_substitution', 'PH', '201', 'Guest', 'A2']])
    expect(read.home.changes).deep.equals([])
    expect(read.home.current?.defense.P?.name).equals('H1')
  })

  it("reads an imported game's changes alone", async function () {
    const read = asGameLineupsResponse(
      (await get(`/games/${imported}/lineups`, ADMIN)).body
    )
    expect(read.home.start).equals(null)
    expect(read.home.current).equals(null)
    expect(read.home.changes.map(change => change.description)).deep.equals([
      'Pitching Change: Hal replaces Hank.'
    ])
  })

  it('is 404 for a game you cannot see, or that does not exist', async function () {
    expect((await get(`/games/${hidden}/lineups`, MEMBER)).status).equals(404)
    expect((await get(`/games/${scored}/lineups`, STRANGER)).status).equals(404)
    expect((await get(`/games/nope/lineups`, ADMIN)).status).equals(404)
  })

  describe('DJ Game (U27)', function () {
    it("lists the game's current lineup, pinch hitter and songs included", async function () {
      const answer = await get(`/games/${scored}/dj`, SONGKEEPER)
      expect(answer.status).equals(200)
      const dj = asDjGame(answer.body)
      expect(dj.away).deep.include({
        teamId: away,
        teamName: 'Visitors',
        source: 'lineup',
        canEditWalkUp: true
      })
      // The Guest batting for A2 is only in the at-bat in progress.
      expect(dj.away.batters.map(batter => batter.name)).deep.equals([
        'A1',
        'Guest',
        'A3',
        'A4',
        'A5',
        'A6',
        'A7',
        'A8',
        'A9'
      ])
      expect(dj.away.batters[1]).deep.equals({
        userId: null,
        name: 'Guest',
        walkUpSong: null
      })
      expect(dj.away.batters[0].walkUpSong).deep.include({
        title: 'Away Song',
        startMs: 10000,
        endMs: 25000
      })
      expect(dj.away.batters[2].walkUpSong).equals(null)
      // Another team's song for the same person never shows.
      expect(
        dj.home.batters.map(batter => batter.walkUpSong?.title ?? null)
      ).deep.equals(Array(9).fill(null))
      expect(dj.home).deep.include({ source: 'lineup', canEditWalkUp: false })
      expect(dj.atBat?.side).equals('away')
    })

    it("lists each team's default before the game has a record", async function () {
      const dj = asDjGame((await get(`/games/${fresh}/dj`, MEMBER)).body)
      expect(dj.home.source).equals('default')
      expect(dj.home.batters.map(batter => batter.name)).deep.equals([
        'H1',
        'H2',
        'H3',
        'H4',
        'H5',
        'H6',
        'H7',
        'H8',
        'H9'
      ])
      expect(dj.away.source).equals('default')
      expect(dj.atBat).equals(null)
      // The default is the lineup the visitors began with, before the Guest.
      expect(dj.away.batters[1].name).equals('A2')
      expect(dj.away.batters[0].walkUpSong?.title).equals('Away Song')
    })

    it('lists the players by jersey, then name, with no default either', async function () {
      const dj = asDjGame((await get(`/games/${benchGame}/dj`, ADMIN)).body)
      expect(dj.away.source).equals('roster')
      expect(dj.away.batters.map(batter => batter.name)).deep.equals([
        'Cal',
        'Zed',
        'Amy',
        'Bob'
      ])
      expect(
        dj.away.batters.map(batter => batter.walkUpSong?.title ?? null)
      ).deep.equals([null, null, 'Amy Song', null])
      expect(dj.away.canEditWalkUp).equals(true)
      expect(dj.home.canEditWalkUp).equals(true)
    })

    it('lets only a songkeeper of a side edit its songs', async function () {
      for (const token of [MEMBER, SCOREKEEPER]) {
        const dj = asDjGame((await get(`/games/${scored}/dj`, token)).body)
        expect(dj.away.canEditWalkUp, token).equals(false)
        expect(dj.home.canEditWalkUp, token).equals(false)
      }
    })

    it('is 404 for a game you cannot see, and 401 signed out', async function () {
      expect((await get(`/games/${hidden}/dj`, MEMBER)).status).equals(404)
      expect((await get(`/games/${scored}/dj`, STRANGER)).status).equals(404)
      expect((await get(`/games/nope/dj`, ADMIN)).status).equals(404)
      expect((await get(`/games/${scored}/dj`, null)).status).equals(401)
    })
  })
})
