import type { AddressInfo } from 'node:net'

import { expect } from 'chai'
import express from 'express'
import type { Insertable, Kysely } from 'kysely'
import { after, before, beforeEach, describe, it } from 'mocha'
import { Client, Pool } from 'pg'

import {
  asDjGame,
  asGameLineupsResponse,
  type SaveLineupsBody
} from '../../common/api'
import { storedGuests } from '../../common/guests'
import {
  asPostEventsBody,
  type CurrentPlay,
  type GumboPlay
} from '../../common/gumboPlay'
import { makeId } from '../../common/ids'
import type { ScoringAction } from '../../common/scoring/actions'
import { newSetup } from '../../common/scoring/lineup'
import {
  asDefaultLineup,
  confirmedSides,
  type Lineup,
  type LineupPerson
} from '../../common/scoring/lineupHistory'
import { ScoringSession } from '../../common/scoring/session'
import {
  shownWithDefault,
  withVisibleDefaults
} from '../../common/scoring/startingSetup'
import {
  type GameSetup,
  type GameState,
  POSITIONS,
  setupOf,
  type Side
} from '../../common/scoring/state'
import { teamsOfRow } from '../../common/teamLists'
import { userIdOfGumbo } from '../../common/userId'
import { migrations } from '../../migrate/migrations'
import { migrateUp } from '../../migrate/runner'
import { testDatabaseUrl } from '../../migrate/testDatabase'
import { mintUserId } from '../../test/historicalUserIds'
import { insertFixtureUsers } from '../../test/insertFixtureUsers'
import { hashToken } from '../auth/tokens'
import { type Database, makeDatabase } from '../db/database'
import { atBatInProgress } from '../events/atBatInProgress'
import { postGamePlays, readPlays, RESET_SINCE_READ } from '../events/postPlays'
import { createGuestPlayer } from '../games/guestPlayers'
import { jsonBody } from '../jsonBody'
import { withAudit } from '../middleware/withAudit'
import { withActor } from '../middleware/withAuth'
import { errorHandler } from '../middleware/withErrors'
import { resolveScoringGame } from '../scoring/openRow'
import { GAME_CHANGES_CHANNEL } from '../socket/gameChanges'
import { lineupRoutes, startingContext } from './lineups'

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
  const written: string[] = []
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
  let guestId: number
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

  const displayOf = (user: { userId: number }): string => {
    const at = players.indexOf(user as (typeof players)[number])
    if (at < 0) return `User ${user.userId}`
    return at < 9 ? `A${at + 1}` : `H${at - 8}`
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
      [member, stranger, admin, songkeeper, scorekeeper, ...players].map(
        user => ({
          id: user.userId,
          legacyId: user.legacyId,
          // A player under the name the game's setup gives him, as reads
          // name him from his account.
          display_name: displayOf(user),
          is_admin: user === admin,
          created_at: now,
          updated_at: now
        })
      )
    )
    await insertFixtureUsers(
      db,
      Object.entries(bench).map(([name, user]) => ({
        id: user.userId,
        legacyId: user.legacyId,
        display_name: name,
        created_at: now,
        updated_at: now
      }))
    )
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
          user_id: userIdOfGumbo(user.userId),
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
          user_id: userIdOfGumbo(member.userId),
          team_id: home,
          role: 'member'
        },
        {
          id: makeId('membership'),
          user_id: userIdOfGumbo(songkeeper.userId),
          team_id: away,
          role: 'member'
        },
        {
          id: makeId('membership'),
          user_id: userIdOfGumbo(scorekeeper.userId),
          team_id: away,
          role: 'member'
        },
        // The bench team's players, and one member who is not a player.
        ...Object.entries(bench).map(([name, user]) => ({
          id: makeId('membership'),
          user_id: userIdOfGumbo(user.userId),
          team_id: bare,
          role: 'member' as const,
          is_player: true,
          jersey: BENCH_JERSEYS[name as keyof typeof BENCH_JERSEYS]
        })),
        {
          id: makeId('membership'),
          user_id: userIdOfGumbo(member.userId),
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
          user_id: userIdOfGumbo(songkeeper.userId),
          scope_type: 'team',
          scope_id: away,
          role: 'songkeeper'
        },
        {
          id: makeId('scopeRole'),
          user_id: userIdOfGumbo(scorekeeper.userId),
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
      user_id: userIdOfGumbo(userId),
      provider: 'localFile',
      provider_id: 'lf:0123456789abcdef',
      title,
      artist: 'Band',
      duration_ms: 180000,
      start_ms: 10000,
      end_ms: 25000,
      set_by: userIdOfGumbo(admin.userId)
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
        userId: userIdOfGumbo(user.userId),
        gumboId: user.userId,
        shortName: `A${i + 1}`,
        jersey: String(i + 1)
      })),
      home: players.slice(9).map((user, i) => ({
        userId: userIdOfGumbo(user.userId),
        gumboId: user.userId,
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
    guestId = (
      await createGuestPlayer(
        db,
        { userId: userIdOfGumbo(admin.userId), isAdmin: true, scopes: [] },
        scored,
        'away',
        {
          firstName: 'Guest',
          lastName: '',
          jersey: '77',
          positions: [],
          bats: null,
          throws: null
        }
      )
    ).gumboId!
    for (const action of [
      { type: 'pitch', call: 'C' },
      { type: 'pitch', call: 'C' },
      { type: 'pitch', call: 'C' },
      { type: 'gameFlow', kind: 'closePlay' },
      {
        type: 'lineup',
        kind: 'addPlayer',
        player: guestId,
        side: 'away',
        name: 'Guest',
        jersey: '77'
      },
      {
        type: 'lineup',
        kind: 'substitute',
        side: 'away',
        player: guestId,
        replaces: players[1].userId
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
    app.use(withAudit(db))
    app.use(
      '/api/v1',
      lineupRoutes(db, {
        onGameWritten: gameId => {
          written.push(gameId)
        }
      })
    )
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

  it('creates game guests through the validated route and refuses invalid sides and unauthorized callers', async function () {
    const post = async (
      token: string | null,
      side: string
    ): Promise<Response> =>
      await fetch(`${base}/games/${fresh}/guest-players`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          ...(token == null ? {} : { authorization: `Bearer ${token}` })
        },
        body: JSON.stringify({
          side,
          firstName: 'Babe',
          lastName: 'Ruth',
          jersey: '00',
          positions: [],
          bats: 'left',
          throws: null
        })
      })
    expect((await post(null, 'away')).status).equals(401)
    expect((await post(STRANGER, 'away')).status).equals(403)
    expect((await post(ADMIN, 'other')).status).equals(400)
    const created = await post(ADMIN, 'away')
    expect(created.status).equals(201)
    const body = (await created.json()) as { userId: string; gumboId: number }
    const game = await db!
      .selectFrom('games')
      .select(['guests', 'home_team_id', 'away_team_id'])
      .where('id', '=', fresh)
      .executeTakeFirstOrThrow()
    expect(storedGuests(game.guests, teamsOfRow(game))).deep.equals({
      away: [body.gumboId],
      home: []
    })

    // The guest's name is corrected on his account, through its own route.
    const put = async (
      token: string | null,
      userId: string,
      name: unknown
    ): Promise<Response> =>
      await fetch(`${base}/games/${fresh}/guest-players/${userId}`, {
        method: 'PUT',
        headers: {
          'content-type': 'application/json',
          ...(token == null ? {} : { authorization: `Bearer ${token}` })
        },
        body: JSON.stringify(name)
      })
    const corrected = { firstName: 'George', lastName: 'Ruth' }
    expect((await put(null, body.userId, corrected)).status).equals(401)
    expect((await put(STRANGER, body.userId, corrected)).status).equals(403)
    expect((await put(ADMIN, 'nobody', corrected)).status).equals(400)
    expect(
      (await put(ADMIN, body.userId, { firstName: '', lastName: '' })).status
    ).equals(400)
    expect(
      (await put(ADMIN, userIdOfGumbo(987654321), corrected)).status
    ).equals(404)
    const renamed = await put(ADMIN, body.userId, corrected)
    expect(renamed.status).equals(200)
    expect(await renamed.json()).deep.include({
      userId: body.userId,
      gumboId: body.gumboId,
      shortName: 'George Ruth',
      nameDetails: {
        firstName: 'George',
        lastName: 'Ruth',
        displayName: 'George Ruth'
      },
      jersey: '00'
    })
    expect(
      await db!
        .selectFrom('users')
        .select(['first_name', 'last_name', 'display_name'])
        .where('id', '=', body.userId)
        .executeTakeFirstOrThrow()
    ).deep.equals({
      first_name: 'George',
      last_name: 'Ruth',
      display_name: 'George Ruth'
    })
    // The same name again writes nothing: no account, audit row or notice.
    const audits = async (): Promise<number> =>
      (
        await db!
          .selectFrom('audit_log')
          .select('id')
          .where(
            'path',
            '=',
            `/api/v1/games/${fresh}/guest-players/${body.userId}`
          )
          .where('method', '=', 'PUT')
          .execute()
      ).length
    const settled = async (count: number): Promise<void> => {
      for (let tries = 0; tries < 50 && (await audits()) < count; tries++)
        await new Promise(resolve => setTimeout(resolve, 20))
    }
    await settled(1)
    expect(await audits()).equals(1)
    expect(written.filter(id => id === fresh)).has.length(1)
    const stamp = async (): Promise<unknown> =>
      (
        await db!
          .selectFrom('users')
          .select('updated_at')
          .where('id', '=', body.userId)
          .executeTakeFirstOrThrow()
      ).updated_at
    const was = await stamp()
    const again = await put(ADMIN, body.userId, {
      firstName: ' George ',
      lastName: 'Ruth'
    })
    expect(again.status).equals(200)
    expect(await again.json()).deep.include({ shortName: 'George Ruth' })
    await new Promise(resolve => setTimeout(resolve, 100))
    expect(await audits()).equals(1)
    expect(written.filter(id => id === fresh)).has.length(1)
    expect(await stamp()).deep.equals(was)
  })

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

  it('keeps the default it took by ids alone, and answers it named', async function () {
    // The first pitch of the scored game gave the hosts this default.
    const row = await db!
      .selectFrom('teams')
      .select('default_lineup')
      .where('id', '=', home)
      .executeTakeFirstOrThrow()
    const stored = row.default_lineup as {
      lineup: {
        batters: Array<Record<string, unknown>>
        defense: Record<string, Record<string, unknown> | null>
      }
    }
    expect(
      stored.lineup.batters.map(person => Object.keys(person).sort())
    ).deep.equals(Array(9).fill(['gumboId', 'jersey']))
    expect(JSON.stringify(stored)).not.includes('"name"')
    const answered = asDefaultLineup(
      (await get(`/teams/${home}/default-lineup`, MEMBER)).body
    )
    expect(answered.lineup?.batters[0]).deep.equals({
      gumboId: players[9].userId,
      name: 'H1',
      jersey: '1'
    })
    expect(
      Object.values(answered.lineup?.defense ?? {}).every(
        person => person?.name !== ''
      )
    ).equals(true)
  })

  it('answers a placeholder in a default by the name typed for him', async function () {
    const was = await db!
      .selectFrom('teams')
      .select('default_lineup')
      .where('id', '=', other)
      .executeTakeFirstOrThrow()
    const typed = { gumboId: null, name: 'Typed Fielder', jersey: '8' }
    await db!
      .updateTable('teams')
      .set({
        default_lineup: {
          lineup: {
            batters: [typed, { gumboId: players[0].userId, jersey: '1' }],
            defense: Object.fromEntries(
              POSITIONS.map(position => [
                position,
                position === 'C' ? typed : null
              ])
            )
          },
          fromGameId: null,
          setAt: '2026-04-01T18:00:00.000Z'
        }
      })
      .where('id', '=', other)
      .execute()
    try {
      const answered = asDefaultLineup(
        (await get(`/teams/${other}/default-lineup`, ADMIN)).body
      )
      expect(answered.lineup?.batters).deep.equals([
        typed,
        { gumboId: players[0].userId, name: 'A1', jersey: '1' }
      ])
      expect(answered.lineup?.defense.C).deep.equals(typed)
      const dj = asDjGame((await get(`/games/${hidden}/dj`, ADMIN)).body)
      expect(dj.home.source).equals('default')
      expect(
        dj.home.batters.map(({ userId, name }) => ({ userId, name }))
      ).deep.equals([
        { userId: null, name: 'Typed Fielder' },
        { userId: userIdOfGumbo(players[0].userId), name: 'A1' }
      ])
    } finally {
      await db!
        .updateTable('teams')
        .set({ default_lineup: was.default_lineup as never })
        .where('id', '=', other)
        .execute()
    }
  })

  it("reads both sides' start, changes and current lineup of a game", async function () {
    const answer = await get(`/games/${scored}/lineups`, MEMBER)
    expect(answer.status).equals(200)
    const read = asGameLineupsResponse(answer.body)
    expect(read.away).deep.include({ teamId: away, teamName: 'Visitors' })
    expect(read.home).deep.include({ teamId: home, teamName: 'Hosts' })
    expect(read.away.start?.batters[1].name).equals('A2')
    expect(read.away.current?.batters[1]).deep.equals({
      gumboId: guestId,
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
        userId: (
          await db!
            .selectFrom('gumbo_ids')
            .select('user_id')
            .where('gumbo_id', '=', guestId)
            .executeTakeFirstOrThrow()
        ).user_id,
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

    it('names no batter for a begun game with no at-bat stored, its pregame lineups kept', async function () {
      const row = await db!
        .selectFrom('games')
        .select(['currentPlay', 'pregame'])
        .where('id', '=', scored)
        .executeTakeFirstOrThrow()
      const play = row.currentPlay as {
        about: Record<string, unknown>
        teamStation: unknown
      }
      // As a replace post leaves a game TeamStation set up: plays, no at-bat.
      const id = makeId('event')
      await db!
        .insertInto('events')
        .values({
          id,
          gameId: scored,
          gumbo: { ...play, about: { ...play.about, isComplete: true } },
          startTime: null,
          endTime: null,
          createdAt: new Date(),
          updatedAt: new Date()
        })
        .execute()
      await db!
        .updateTable('games')
        .set({ currentPlay: null, pregame: play.teamStation as never })
        .where('id', '=', scored)
        .execute()
      try {
        const dj = asDjGame((await get(`/games/${scored}/dj`, ADMIN)).body)
        expect(dj.atBat).equals(null)
      } finally {
        await db!.deleteFrom('events').where('id', '=', id).execute()
        await db!
          .updateTable('games')
          .set({
            currentPlay: row.currentPlay as never,
            pregame: row.pregame as never
          })
          .where('id', '=', scored)
          .execute()
      }
    })

    it("lists each team's default before the game has a record", async function () {
      const dj = asDjGame((await get(`/games/${fresh}/dj`, ADMIN)).body)
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

    it('names the default from the accounts, so a rename changes the default and its DJ rows', async function () {
      const storedOf = async (): Promise<unknown> =>
        (
          await db!
            .selectFrom('teams')
            .select('default_lineup')
            .where('id', '=', home)
            .executeTakeFirstOrThrow()
        ).default_lineup
      const stored = await storedOf()
      const renamed = userIdOfGumbo(players[9].userId)
      await db!
        .updateTable('users')
        .set({
          first_name: 'Shohei',
          last_name: 'Ohtani',
          display_name: 'Shohei Ohtani'
        })
        .where('id', '=', renamed)
        .execute()
      try {
        const answered = asDefaultLineup(
          (await get(`/teams/${home}/default-lineup`, MEMBER)).body
        )
        expect(answered.lineup?.batters.map(person => person.name)).deep.equals(
          ['Shohei O', 'H2', 'H3', 'H4', 'H5', 'H6', 'H7', 'H8', 'H9']
        )
        const dj = asDjGame((await get(`/games/${fresh}/dj`, ADMIN)).body)
        expect(dj.home.source).equals('default')
        expect(dj.home.batters[0]).deep.include({
          userId: renamed,
          name: 'Shohei O'
        })
        // Nothing stored changed.
        expect(await storedOf()).deep.equals(stored)
      } finally {
        await db!
          .updateTable('users')
          .set({ first_name: null, last_name: null, display_name: 'H1' })
          .where('id', '=', renamed)
          .execute()
      }
      const dj = asDjGame((await get(`/games/${fresh}/dj`, ADMIN)).body)
      expect(dj.home.batters[0].name).equals('H1')
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

    it('lets only a songkeeper or scorekeeper of a side edit its songs', async function () {
      // The visitors' scorekeeper keeps their songs, and not the hosts'.
      const scorer = asDjGame(
        (await get(`/games/${scored}/dj`, SCOREKEEPER)).body
      )
      expect(scorer.away.canEditWalkUp).equals(true)
      expect(scorer.home.canEditWalkUp).equals(false)
      const member = asDjGame((await get(`/games/${scored}/dj`, MEMBER)).body)
      expect(member.away.canEditWalkUp).equals(false)
      expect(member.home.canEditWalkUp).equals(false)
    })

    it('is 404 for a game you cannot see, and 401 signed out', async function () {
      expect((await get(`/games/${hidden}/dj`, MEMBER)).status).equals(404)
      expect((await get(`/games/${scored}/dj`, STRANGER)).status).equals(404)
      expect((await get(`/games/nope/dj`, ADMIN)).status).equals(404)
      expect((await get(`/games/${scored}/dj`, null)).status).equals(401)
    })
  })
})

const COACH = 'tok_lineups_post_coach_00000000000'
const ASSISTANT = 'tok_lineups_post_assistant_0000000'
const AWAY_COACH = 'tok_lineups_post_away_coach_000000'
const TEAM_ADMIN = 'tok_lineups_post_team_admin_000000'
const SCORER = 'tok_lineups_post_scorer_0000000000'
const FAN = 'tok_lineups_post_member_0000000000'

/**
 * U8: a head coach saves his side's lineup, replayed over the stored game
 * and written as a scorer's save is.
 */
describe("saving a side's lineup (U8)", function () {
  this.timeout(120000)

  const scratch = `teamstation_lineups_post_${Date.now()}`
  const url = adminUrl.replace(/\/[^/]*$/, `/${scratch}`)
  let adminPool: Pool | undefined
  let db: Kysely<Database> | undefined
  let listener: Client | undefined
  let server: ReturnType<express.Express['listen']> | undefined
  let base = ''
  const taken = new Set<number>()
  const mint = (): { userId: number; legacyId: string } => {
    const minted = mintUserId(id => taken.has(id))
    taken.add(minted.userId)
    return minted
  }
  const coach = mint()
  const assistant = mint()
  const awayCoach = mint()
  const teamAdmin = mint()
  const scorer = mint()
  const fan = mint()
  const homePlayers = Array.from({ length: 10 }, mint)
  const awayPlayers = Array.from({ length: 9 }, mint)
  const home = makeId('team')
  const away = makeId('team')
  const games = {
    fresh: makeId('game'),
    unheld: makeId('game'),
    live: makeId('game'),
    locals: makeId('game'),
    runner: makeId('game'),
    pending: makeId('game'),
    final: makeId('game'),
    race: makeId('game'),
    busy: makeId('game'),
    stale: makeId('game'),
    blind: makeId('game'),
    seen: makeId('game'),
    between: makeId('game'),
    kept: makeId('game'),
    revised: makeId('game'),
    set: makeId('game'),
    accept: makeId('game'),
    keeper: makeId('game'),
    shown: makeId('game'),
    availability: makeId('game'),
    generation: makeId('game')
  }
  const TEAMS = {
    away: { id: away, name: 'Visitors' },
    home: { id: home, name: 'Hosts' }
  }
  const SURNAMES = [
    'Judge',
    'Soto',
    'Betts',
    'Ohtani',
    'Freeman',
    'Trout',
    'Machado',
    'Lindor',
    'Alonso',
    'Harper'
  ]
  const roster = (
    users: Array<{ userId: number }>,
    prefix: string
  ): Array<{
    userId: string
    gumboId: number
    shortName: string
    jersey: string
  }> =>
    users.map((user, i) => ({
      userId: userIdOfGumbo(user.userId),
      gumboId: user.userId,
      shortName: `${prefix}${SURNAMES[i]}`,
      jersey: String(i + 1)
    }))
  // Nine of the hosts' ten bat; the tenth is on the bench.
  const setup = (): GameSetup => {
    const made = newSetup(TEAMS, {
      away: roster(awayPlayers, 'A'),
      home: roster(homePlayers, 'H')
    })
    made.sides.home.battingOrder = made.sides.home.battingOrder.slice(0, 9)
    return made
  }
  const written: string[] = []
  const heard: string[] = []
  let beforeSave: ((gameId: string) => Promise<void>) | undefined
  let afterSave: ((gameId: string) => Promise<void>) | undefined

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
    await adminPool.query(`create database ${scratch}`)
    const pool = new Pool({ connectionString: url })
    await migrateUp(pool, migrations)
    await pool.end()
    db = makeDatabase(url)
    const now = new Date()
    const players = [...homePlayers, ...awayPlayers]
    await insertFixtureUsers(
      db,
      [coach, assistant, awayCoach, teamAdmin, scorer, fan, ...players].map(
        user => ({
          id: user.userId,
          legacyId: user.legacyId,
          display_name: `User ${user.userId}`,
          created_at: now,
          updated_at: now
        })
      )
    )
    await db
      .insertInto('auth_sessions')
      .values(
        (
          [
            [coach, COACH],
            [assistant, ASSISTANT],
            [awayCoach, AWAY_COACH],
            [teamAdmin, TEAM_ADMIN],
            [scorer, SCORER],
            [fan, FAN]
          ] as const
        ).map(([user, token]) => ({
          id: `ses_${token}`,
          user_id: userIdOfGumbo(user.userId),
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
        { id: away, name: 'Visitors', kind: 'full' }
      ])
      .execute()
    await db
      .insertInto('games')
      .values(
        Object.values(games).map(id => ({
          id,
          home_team_id: home,
          away_team_id: away,
          start_at: now
        }))
      )
      .execute()
    const membership = (
      user: { userId: number },
      teamId: string,
      role: 'member' | 'manager' = 'member',
      jersey: string | null = null
    ): Insertable<Database['memberships']> => ({
      id: makeId('membership'),
      user_id: userIdOfGumbo(user.userId),
      team_id: teamId,
      role,
      is_player: jersey != null,
      jersey
    })
    await db
      .insertInto('memberships')
      .values([
        membership(coach, home),
        membership(assistant, home),
        membership(fan, home),
        membership(teamAdmin, home, 'manager'),
        membership(awayCoach, away),
        membership(scorer, away),
        ...homePlayers.map((user, i) =>
          membership(user, home, 'member', String(i + 1))
        ),
        ...awayPlayers.map((user, i) =>
          membership(user, away, 'member', String(i + 1))
        )
      ])
      .execute()
    const flag = (
      user: { userId: number },
      teamId: string,
      role: 'coach' | 'assistant' | 'scorekeeper'
    ): Insertable<Database['scope_roles']> => ({
      id: makeId('scopeRole'),
      user_id: userIdOfGumbo(user.userId),
      scope_type: 'team',
      scope_id: teamId,
      role
    })
    await db
      .insertInto('scope_roles')
      .values([
        flag(coach, home, 'coach'),
        flag(assistant, home, 'assistant'),
        flag(awayCoach, away, 'coach'),
        flag(scorer, away, 'scorekeeper')
      ])
      .execute()

    // Each game but the fresh and the final one is under way: a ball to the
    // first batter. The pending one has a ball in play waiting for its result.
    for (const gameId of [
      games.live,
      games.locals,
      games.runner,
      games.pending,
      games.race,
      games.busy,
      games.stale,
      games.between
    ])
      await score(gameId, [{ type: 'pitch', call: 'B' }])
    const guest = await createGuestPlayer(
      db,
      { userId: userIdOfGumbo(coach.userId), isAdmin: false, scopes: [] },
      games.locals,
      'home',
      {
        firstName: 'Guest',
        lastName: '',
        jersey: '77',
        positions: [],
        bats: null,
        throws: null
      }
    )
    await score(games.locals, [
      {
        type: 'lineup',
        kind: 'addPlayer',
        player: guest.gumboId!,
        side: 'home',
        name: 'Guest',
        jersey: '77'
      }
    ])
    await score(games.runner, [
      { type: 'pitch', call: 'B' },
      { type: 'pitch', call: 'B' },
      { type: 'pitch', call: 'B' }
    ])
    await score(games.pending, [{ type: 'ballInPlay', contact: 'swing' }])
    await db
      .updateTable('games')
      .set({ status: 'final' })
      .where('id', '=', games.final)
      .execute()

    listener = new Client({ connectionString: url })
    await listener.connect()
    listener.on('notification', message => {
      if (message.payload != null) heard.push(message.payload)
    })
    await listener.query(`listen ${GAME_CHANGES_CHANNEL}`)

    const app = express()
    app.use(jsonBody)
    app.use(withActor(db))
    app.use(
      '/api/v1',
      lineupRoutes(db, {
        onGameWritten: gameId => {
          written.push(gameId)
        },
        beforeSave: async gameId => {
          await beforeSave?.(gameId)
        },
        afterSave: async gameId => {
          await afterSave?.(gameId)
        }
      })
    )
    app.use(errorHandler)
    server = app.listen(0, '127.0.0.1')
    await new Promise<void>(resolve => server?.once('listening', resolve))
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/v1`
  })

  after(async function () {
    server?.close()
    await listener?.end()
    if (db != null) await db.destroy()
    if (adminPool != null) {
      await adminPool.query(`drop database if exists ${scratch}`)
      await adminPool.end()
    }
  })

  beforeEach(function () {
    beforeSave = undefined
    afterSave = undefined
  })

  /** A scorer's session on the game, saving as the scoring screen does. */
  async function scoring(gameId: string): Promise<ScoringSession> {
    const database = db!
    return await ScoringSession.open(
      {
        // Read as `GET /events` reads it: named from the accounts.
        load: async () =>
          await resolveScoringGame(database, {
            plays: (await readPlays(database, gameId)).map(
              row => row.gumbo as GumboPlay
            ),
            currentPlay: (
              await database
                .selectFrom('games')
                .select(atBatInProgress().as('currentPlay'))
                .where('id', '=', gameId)
                .executeTakeFirstOrThrow()
            ).currentPlay as CurrentPlay | null
          }),
        save: async (id, change) => {
          const posted = await postGamePlays(
            database,
            id,
            asPostEventsBody({
              mode: 'live',
              source: { system: 'teamstation' },
              plays: change.plays,
              remove: change.remove,
              currentPlay: change.currentPlay
            })
          )
          return {
            plays: posted.plays.map(row => row.gumbo as GumboPlay),
            currentPlay: posted.currentPlay as CurrentPlay | null
          }
        }
      },
      gameId,
      { gamePk: gameId, teams: TEAMS, setup: setup() },
      { requireCurrentSetup: true }
    )
  }

  /** Scores `actions` into the game, as a scorer would. */
  async function score(
    gameId: string,
    actions: ScoringAction[]
  ): Promise<GameState> {
    const session = await scoring(gameId)
    for (const action of actions)
      expect(
        session.apply(action).problems,
        JSON.stringify(action)
      ).deep.equals([])
    await session.flush()
    expect(session.problem).equals(null)
    return session.state
  }

  /** One side's lineup as the game holds it, as a save names it. */
  function bodyOf(state: GameState, side: Side): SaveLineupsBody {
    const team = state.liveData.boxscore.teams[side]
    const players = team.players.map(id => {
      const player = state.gameData.players[id]
      return {
        gumboId: player.id,
        fullName: player.fullName,
        jersey: player.jersey
      }
    })
    const index = (id: number): number => team.players.indexOf(id)
    const defense: SaveLineupsBody['defense'] = {}
    for (const position of POSITIONS) {
      const id = team.defense[position]
      if (id != null) defense[position] = index(id)
    }
    return {
      side,
      base: '',
      players,
      battingOrder: team.battingOrder.map(index),
      defense
    }
  }

  async function ask(
    method: 'GET' | 'POST' | 'PUT',
    path: string,
    token: string,
    body?: unknown
  ): Promise<{ status: number; body: Record<string, unknown> }> {
    const response = await fetch(`${base}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${token}`,
        ...(body === undefined ? {} : { 'content-type': 'application/json' })
      },
      body: body === undefined ? undefined : JSON.stringify(body)
    })
    return {
      status: response.status,
      body: (await response.json()) as Record<string, unknown>
    }
  }

  const save = async (
    gameId: string,
    token: string,
    body: unknown
  ): ReturnType<typeof ask> =>
    await ask('POST', `/games/${gameId}/lineups`, token, body)

  async function gameRow(gameId: string): Promise<{
    status: string
    currentPlay: unknown
    pregame: unknown
    lineups_digest: string | null
    updated_at: Date
  }> {
    return await db!
      .selectFrom('games')
      .select([
        'status',
        'currentPlay',
        'pregame',
        'lineups_digest',
        'updated_at'
      ])
      .where('id', '=', gameId)
      .executeTakeFirstOrThrow()
  }

  /** The `lineups` notifies heard for a game, once they have arrived. */
  async function lineupNotifies(gameId: string): Promise<number> {
    await listener!.query('select 1')
    await new Promise(resolve => setTimeout(resolve, 200))
    return heard.filter(
      payload => payload === JSON.stringify({ game: gameId, kind: 'lineups' })
    ).length
  }

  const batters = (side: { current: unknown }): Array<number | null> =>
    (
      side.current as { batters: Array<{ gumboId: number | null }> }
    ).batters.map(person => person.gumboId)

  it('saves a head coach’s side before the first pitch, leaving the game scheduled', async function () {
    // The hosts start from their roster: the first nine of ten bat.
    const players = homePlayers.map((user, i) => ({
      gumboId: user.userId,
      fullName: `H${SURNAMES[i]}`,
      jersey: String(i + 1)
    }))
    const body: SaveLineupsBody = {
      side: 'home',
      base: '',
      players,
      battingOrder: [9, 8, 7, 6, 5, 4, 3, 2, 1],
      defense: {
        P: 9,
        C: 8,
        '1B': 7,
        '2B': 6,
        '3B': 5,
        SS: 4,
        LF: 3,
        CF: 2,
        RF: 1
      }
    }
    const answer = await save(games.fresh, COACH, body)
    expect(answer.status, JSON.stringify(answer.body)).equals(200)
    const read = asGameLineupsResponse(answer.body)
    expect(batters(read.home)).deep.equals(
      body.battingOrder.map(index => homePlayers[index].userId)
    )
    expect(read.home.current?.defense.P?.gumboId).equals(homePlayers[9].userId)
    const row = await gameRow(games.fresh)
    expect(row.status).equals('scheduled')
    // Before the first pitch the save is the pregame record, with no Gumbo.
    expect(row.currentPlay).equals(null)
    expect(row.pregame).not.equals(null)
    expect(read.digest).equals(row.lineups_digest)
    // The answer is what reading the lineups now says, digest and all.
    const again = await ask('GET', `/games/${games.fresh}/lineups`, FAN)
    expect(again.status).equals(200)
    expect(again.body).deep.equals(answer.body)
    expect(written).deep.equals([games.fresh])
    expect(await lineupNotifies(games.fresh)).equals(1)
  })

  it('takes a head coach’s side as the game opens on it, unchanged, so the game holds it', async function () {
    // The lineups the route opens a game with no record on, saved as they
    // stand: the coach accepts them.
    // As the hosts' coach, who may see his own team alone.
    const context = await startingContext(
      db!,
      games.unheld,
      { home_team_id: home, away_team_id: away },
      teamId => teamId === home
    )
    const opened = await ScoringSession.open(
      {
        load: async () => ({ plays: [], currentPlay: null }),
        save: async () => {
          throw new Error('Not saved here')
        }
      },
      games.unheld,
      context,
      { requireCurrentSetup: true }
    )
    const before = await ask('GET', `/games/${games.unheld}/lineups`, FAN)
    expect(asGameLineupsResponse(before.body).home.current).equals(null)
    const answer = await save(games.unheld, COACH, bodyOf(opened.state, 'home'))
    expect(answer.status, JSON.stringify(answer.body)).equals(200)
    const read = asGameLineupsResponse(answer.body)
    expect(read.home.current).not.equals(null)
    expect(batters(read.home)).deep.equals(
      opened.state.liveData.boxscore.teams.home.battingOrder.map(
        id => opened.state.gameData.players[id].id
      )
    )
    const row = await gameRow(games.unheld)
    expect(row.status).equals('scheduled')
    // Before the first pitch the save is the pregame record, with no Gumbo.
    expect(row.currentPlay).equals(null)
    expect(row.pregame).not.equals(null)
    expect(written).includes(games.unheld)
    // Held now: the same save again changes nothing.
    const writes = written.length
    expect(
      (await save(games.unheld, COACH, bodyOf(opened.state, 'home'))).status
    ).equals(200)
    expect(written).lengthOf(writes)
  })

  it('arranges the other side from its default only for somebody who may see that team', async function () {
    // The visitors keep a default lineup: their roster the other way round.
    const roster = await startingContext(
      db!,
      games.blind,
      { home_team_id: home, away_team_id: away },
      () => false
    )
    const order = roster.setup.sides.away.battingOrder.map(
      id => roster.setup.players[id].id
    )
    const person = (userId: number | null): LineupPerson => ({
      gumboId: userId,
      name: `User ${userId}`,
      jersey: ''
    })
    const reversed: Lineup = {
      batters: [...order].reverse().map(person),
      defense: Object.fromEntries(
        POSITIONS.map(position => [position, null])
      ) as Lineup['defense']
    }
    await db!
      .updateTable('teams')
      .set({
        default_lineup: {
          lineup: reversed,
          fromGameId: games.live,
          setAt: new Date().toISOString()
        }
      })
      .where('id', '=', away)
      .execute()
    try {
      const awayBatters = async (gameId: string): Promise<unknown> =>
        batters(
          asGameLineupsResponse(
            (await ask('GET', `/games/${gameId}/lineups`, FAN)).body
          ).away
        )
      const opened = await ScoringSession.open(
        {
          load: async () => ({ plays: [], currentPlay: null }),
          save: async () => {
            throw new Error('Not saved here')
          }
        },
        games.blind,
        roster,
        { requireCurrentSetup: true }
      )
      const hosts = bodyOf(opened.state, 'home')
      hosts.battingOrder.reverse()
      // The hosts' coach may not see the visitors: his save leaves them in
      // roster order, as his own screen showed them, never their default.
      const blind = await save(games.blind, COACH, hosts)
      expect(blind.status, JSON.stringify(blind.body)).equals(200)
      expect(await awayBatters(games.blind)).deep.equals(order)
      // The visitors' scorekeeper may: his save arranges them as their default.
      const seen = await save(games.seen, SCORER, hosts)
      expect(seen.status, JSON.stringify(seen.body)).equals(200)
      expect(await awayBatters(games.seen)).deep.equals([...order].reverse())
    } finally {
      await db!
        .updateTable('teams')
        .set({ default_lineup: null })
        .where('id', '=', away)
        .execute()
    }
  })

  it('keeps an unseen side’s default when the first pitch takes the lineups', async function () {
    // Both teams keep a default that is not roster order. The hosts' coach
    // can see his own and saves them back in roster order. He cannot see
    // the visitors, so his save leaves them in roster order on the game.
    const roster = await startingContext(
      db!,
      games.kept,
      { home_team_id: home, away_team_id: away },
      () => false
    )
    const orderOf = (side: Side): Array<number | null> =>
      roster.setup.sides[side].battingOrder.map(
        id => roster.setup.players[id].id
      )
    const personOf = (id: number): LineupPerson => {
      const player = roster.setup.players[id]
      return {
        gumboId: player.id,
        name: player.fullName,
        jersey: player.jersey
      }
    }
    const reversed = (side: Side): Lineup => {
      const team = roster.setup.sides[side]
      return {
        batters: [...team.battingOrder].reverse().map(personOf),
        defense: Object.fromEntries(
          POSITIONS.map(position => {
            const id = team.defense[position]
            return [position, id == null ? null : personOf(id)]
          })
        ) as Lineup['defense']
      }
    }
    const storedAt = new Date().toISOString()
    await db!
      .updateTable('teams')
      .set({
        default_lineup: {
          lineup: reversed('away'),
          fromGameId: games.live,
          setAt: storedAt
        }
      })
      .where('id', '=', away)
      .execute()
    await db!
      .updateTable('teams')
      .set({
        default_lineup: {
          lineup: reversed('home'),
          fromGameId: games.live,
          setAt: storedAt
        }
      })
      .where('id', '=', home)
      .execute()
    const teamDefault = async (
      teamId: string
    ): Promise<{
      lineup: { batters: Array<{ gumboId: number | null }> }
      fromGameId: string
      setAt: string
    } | null> => {
      const row = await db!
        .selectFrom('teams')
        .select('default_lineup')
        .where('id', '=', teamId)
        .executeTakeFirstOrThrow()
      return row.default_lineup as never
    }
    try {
      const opened = await ScoringSession.open(
        {
          load: async () => ({ plays: [], currentPlay: null }),
          save: async () => {
            throw new Error('Not saved here')
          }
        },
        games.kept,
        await startingContext(
          db!,
          games.kept,
          { home_team_id: home, away_team_id: away },
          teamId => teamId === home
        ),
        { requireCurrentSetup: true }
      )
      const hosts = bodyOf(opened.state, 'home')
      hosts.battingOrder.reverse()
      const saved = await save(games.kept, COACH, hosts)
      expect(saved.status, JSON.stringify(saved.body)).equals(200)
      const visitors = await teamDefault(away)
      expect(visitors?.lineup.batters.map(item => item.gumboId)).deep.equals(
        [...orderOf('away')].reverse()
      )
      await score(games.kept, [{ type: 'pitch', call: 'B' }])
      expect(await teamDefault(away)).deep.equals(visitors)
      const taken = await teamDefault(home)
      expect(taken?.fromGameId).equals(games.kept)
      expect(taken?.lineup.batters.map(item => item.gumboId)).deep.equals(
        orderOf('home')
      )
      const begun = await db!
        .selectFrom('games')
        .select('lineup_started_at')
        .where('id', '=', games.kept)
        .executeTakeFirstOrThrow()
      expect(begun.lineup_started_at).instanceOf(Date)
    } finally {
      await db!
        .updateTable('teams')
        .set({ default_lineup: null })
        .where('id', 'in', [away, home])
        .execute()
    }
  })

  it('keeps an unseen side’s default when its coach later changes that order', async function () {
    // The visitors' default is not roster order. The hosts' coach saves
    // before the game, leaving the visitors in roster order. Their coach,
    // who can see them, changes that order and saves. The first pitch still
    // leaves their default as it stands.
    const roster = await startingContext(
      db!,
      games.revised,
      { home_team_id: home, away_team_id: away },
      () => false
    )
    const orderOf = (side: Side): Array<number | null> =>
      roster.setup.sides[side].battingOrder.map(
        id => roster.setup.players[id].id
      )
    const personOf = (id: number): LineupPerson => {
      const player = roster.setup.players[id]
      return {
        gumboId: player.id,
        name: player.fullName,
        jersey: player.jersey
      }
    }
    const reversed = (side: Side): Lineup => {
      const team = roster.setup.sides[side]
      return {
        batters: [...team.battingOrder].reverse().map(personOf),
        defense: Object.fromEntries(
          POSITIONS.map(position => {
            const id = team.defense[position]
            return [position, id == null ? null : personOf(id)]
          })
        ) as Lineup['defense']
      }
    }
    const storedAt = new Date().toISOString()
    await db!
      .updateTable('teams')
      .set({
        default_lineup: {
          lineup: reversed('away'),
          fromGameId: games.live,
          setAt: storedAt
        }
      })
      .where('id', '=', away)
      .execute()
    await db!
      .updateTable('teams')
      .set({
        default_lineup: {
          lineup: reversed('home'),
          fromGameId: games.live,
          setAt: storedAt
        }
      })
      .where('id', '=', home)
      .execute()
    const teamDefault = async (
      teamId: string
    ): Promise<{
      lineup: { batters: Array<{ gumboId: number | null }> }
      fromGameId: string
      setAt: string
    } | null> => {
      const row = await db!
        .selectFrom('teams')
        .select('default_lineup')
        .where('id', '=', teamId)
        .executeTakeFirstOrThrow()
      return row.default_lineup as never
    }
    try {
      const opened = await ScoringSession.open(
        {
          load: async () => ({ plays: [], currentPlay: null }),
          save: async () => {
            throw new Error('Not saved here')
          }
        },
        games.revised,
        await startingContext(
          db!,
          games.revised,
          { home_team_id: home, away_team_id: away },
          teamId => teamId === home
        ),
        { requireCurrentSetup: true }
      )
      const hosts = bodyOf(opened.state, 'home')
      hosts.battingOrder.reverse()
      const saved = await save(games.revised, COACH, hosts)
      expect(saved.status, JSON.stringify(saved.body)).equals(200)
      const visitors = await teamDefault(away)
      const hostsLineup = batters(asGameLineupsResponse(saved.body).home)
      const replayed = await scoring(games.revised)
      const body = bodyOf(replayed.state, 'away')
      const [first, second, ...rest] = body.battingOrder
      body.battingOrder = [second, first, ...rest]
      const changed = await save(games.revised, AWAY_COACH, body)
      expect(changed.status, JSON.stringify(changed.body)).equals(200)
      // His save changes the visitors only. The hosts' lineup stays.
      expect(batters(asGameLineupsResponse(changed.body).home)).deep.equals(
        hostsLineup
      )
      await score(games.revised, [{ type: 'pitch', call: 'B' }])
      expect(await teamDefault(away)).deep.equals(visitors)
      const taken = await teamDefault(home)
      expect(taken?.fromGameId).equals(games.revised)
      expect(taken?.lineup.batters.map(item => item.gumboId)).deep.equals(
        orderOf('home')
      )
    } finally {
      await db!
        .updateTable('teams')
        .set({ default_lineup: null })
        .where('id', 'in', [away, home])
        .execute()
    }
  })

  it('accepts his default when a blind save left his side unseen', async function () {
    // The visitors' default is not roster order. The hosts' coach saves
    // first, leaving the visitors in roster order. Their coach is shown that
    // default with nothing edited, and saving it is what the game holds.
    // The first pitch leaves their stored default as it stands.
    const roster = await startingContext(
      db!,
      games.accept,
      { home_team_id: home, away_team_id: away },
      () => false
    )
    const orderOf = (side: Side): Array<number | null> =>
      roster.setup.sides[side].battingOrder.map(
        id => roster.setup.players[id].id
      )
    const personOf = (id: number): LineupPerson => {
      const player = roster.setup.players[id]
      return {
        gumboId: player.id,
        name: player.fullName,
        jersey: player.jersey
      }
    }
    const team = roster.setup.sides.away
    const reversed: Lineup = {
      batters: [...team.battingOrder].reverse().map(personOf),
      defense: Object.fromEntries(
        POSITIONS.map(position => {
          const id = team.defense[position]
          return [position, id == null ? null : personOf(id)]
        })
      ) as Lineup['defense']
    }
    await db!
      .updateTable('teams')
      .set({
        default_lineup: {
          lineup: reversed,
          fromGameId: games.live,
          setAt: new Date().toISOString()
        }
      })
      .where('id', '=', away)
      .execute()
    const teamDefault = async (): Promise<{
      lineup: { batters: Array<{ gumboId: number | null }> }
      fromGameId: string
    } | null> => {
      const row = await db!
        .selectFrom('teams')
        .select('default_lineup')
        .where('id', '=', away)
        .executeTakeFirstOrThrow()
      return row.default_lineup as never
    }
    try {
      const opened = await ScoringSession.open(
        {
          load: async () => ({ plays: [], currentPlay: null }),
          save: async () => {
            throw new Error('Not saved here')
          }
        },
        games.accept,
        await startingContext(
          db!,
          games.accept,
          { home_team_id: home, away_team_id: away },
          teamId => teamId === home
        ),
        { requireCurrentSetup: true }
      )
      const hosts = bodyOf(opened.state, 'home')
      const saved = await save(games.accept, COACH, hosts)
      expect(saved.status, JSON.stringify(saved.body)).equals(200)
      const before = asGameLineupsResponse(
        (await ask('GET', `/games/${games.accept}/lineups`, FAN)).body
      )
      expect(batters(before.away)).deep.equals(orderOf('away'))
      const visitors = await teamDefault()
      const replayed = await scoring(games.accept)
      const resumed = replayed.resumable()
      const shown = shownWithDefault(
        resumed.state,
        resumed.actions,
        'away',
        reversed
      )
      const hostsLineup = batters(asGameLineupsResponse(saved.body).home)
      const changed = await save(
        games.accept,
        AWAY_COACH,
        bodyOf(shown, 'away')
      )
      expect(changed.status, JSON.stringify(changed.body)).equals(200)
      const after = asGameLineupsResponse(changed.body)
      expect(batters(after.away)).deep.equals(
        reversed.batters.map(person => person.gumboId)
      )
      expect(batters(after.home)).deep.equals(hostsLineup)
      await score(games.accept, [{ type: 'pitch', call: 'B' }])
      expect(await teamDefault()).deep.equals(visitors)
    } finally {
      await db!
        .updateTable('teams')
        .set({ default_lineup: null })
        .where('id', 'in', [away, home])
        .execute()
    }
  })

  it('takes a scorekeeper’s lineup when it is not the unseen roster order', async function () {
    const roster = await startingContext(
      db!,
      games.set,
      { home_team_id: home, away_team_id: away },
      () => false
    )
    const personOf = (id: number): LineupPerson => {
      const player = roster.setup.players[id]
      return {
        gumboId: player.id,
        name: player.fullName,
        jersey: player.jersey
      }
    }
    const team = roster.setup.sides.away
    const reversed: Lineup = {
      batters: [...team.battingOrder].reverse().map(personOf),
      defense: Object.fromEntries(
        POSITIONS.map(position => {
          const id = team.defense[position]
          return [position, id == null ? null : personOf(id)]
        })
      ) as Lineup['defense']
    }
    await db!
      .updateTable('teams')
      .set({
        default_lineup: {
          lineup: reversed,
          fromGameId: games.live,
          setAt: new Date().toISOString()
        }
      })
      .where('id', '=', away)
      .execute()
    try {
      const opened = await ScoringSession.open(
        {
          load: async () => ({ plays: [], currentPlay: null }),
          save: async () => {
            throw new Error('Not saved here')
          }
        },
        games.set,
        await startingContext(
          db!,
          games.set,
          { home_team_id: home, away_team_id: away },
          teamId => teamId === home
        ),
        { requireCurrentSetup: true }
      )
      const hosts = bodyOf(opened.state, 'home')
      const saved = await save(games.set, COACH, hosts)
      expect(saved.status, JSON.stringify(saved.body)).equals(200)
      const session = await scoring(games.set)
      const setup = setupOf(session.state)
      const order = setup.sides.away.battingOrder
      setup.sides.away.battingOrder = [order[1], order[0], ...order.slice(2)]
      const wanted = setup.sides.away.battingOrder.map(
        id => session.state.gameData.players[id].id
      )
      await score(games.set, [
        {
          type: 'lineup',
          kind: 'roster',
          setup,
          confirmed: ['away', 'home']
        },
        { type: 'pitch', call: 'B' }
      ])
      const taken = await db!
        .selectFrom('teams')
        .select('default_lineup')
        .where('id', '=', away)
        .executeTakeFirstOrThrow()
      const lineup = taken.default_lineup as {
        lineup: { batters: Array<{ gumboId: number | null }> }
        fromGameId: string
      }
      expect(lineup.fromGameId).equals(games.set)
      expect(lineup.lineup.batters.map(item => item.gumboId)).deep.equals(
        wanted
      )
    } finally {
      await db!
        .updateTable('teams')
        .set({ default_lineup: null })
        .where('id', '=', away)
        .execute()
    }
  })

  it('leaves the default when a scorekeeper saves the unseen roster order', async function () {
    // The visitors' default is not roster order. The hosts' coach saves
    // first. A scorekeeper's save that is still that roster order does not
    // confirm the visitors, and the first pitch leaves their default.
    const roster = await startingContext(
      db!,
      games.keeper,
      { home_team_id: home, away_team_id: away },
      () => false
    )
    const orderOf = (side: Side): Array<number | null> =>
      roster.setup.sides[side].battingOrder.map(
        id => roster.setup.players[id].id
      )
    const personOf = (id: number): LineupPerson => {
      const player = roster.setup.players[id]
      return {
        gumboId: player.id,
        name: player.fullName,
        jersey: player.jersey
      }
    }
    const team = roster.setup.sides.away
    const reversed: Lineup = {
      batters: [...team.battingOrder].reverse().map(personOf),
      defense: Object.fromEntries(
        POSITIONS.map(position => {
          const id = team.defense[position]
          return [position, id == null ? null : personOf(id)]
        })
      ) as Lineup['defense']
    }
    await db!
      .updateTable('teams')
      .set({
        default_lineup: {
          lineup: reversed,
          fromGameId: games.live,
          setAt: new Date().toISOString()
        }
      })
      .where('id', '=', away)
      .execute()
    const teamDefault = async (): Promise<unknown> => {
      const row = await db!
        .selectFrom('teams')
        .select('default_lineup')
        .where('id', '=', away)
        .executeTakeFirstOrThrow()
      return row.default_lineup
    }
    try {
      const opened = await ScoringSession.open(
        {
          load: async () => ({ plays: [], currentPlay: null }),
          save: async () => {
            throw new Error('Not saved here')
          }
        },
        games.keeper,
        await startingContext(
          db!,
          games.keeper,
          { home_team_id: home, away_team_id: away },
          teamId => teamId === home
        ),
        { requireCurrentSetup: true }
      )
      const saved = await save(
        games.keeper,
        COACH,
        bodyOf(opened.state, 'home')
      )
      expect(saved.status, JSON.stringify(saved.body)).equals(200)
      const before = await teamDefault()
      const session = await scoring(games.keeper)
      const setup = setupOf(session.state)
      const confirmed = confirmedSides(session.actions, setup)
      expect(confirmed).deep.equals(['home'])
      await score(games.keeper, [
        { type: 'lineup', kind: 'roster', setup, confirmed },
        { type: 'pitch', call: 'B' }
      ])
      expect(await teamDefault()).deep.equals(before)
      const after = asGameLineupsResponse(
        (await ask('GET', `/games/${games.keeper}/lineups`, FAN)).body
      )
      expect(batters(after.away)).deep.equals(orderOf('away'))
      expect(batters(after.home)).deep.equals(
        batters(asGameLineupsResponse(saved.body).home)
      )
    } finally {
      await db!
        .updateTable('teams')
        .set({ default_lineup: null })
        .where('id', 'in', [away, home])
        .execute()
    }
  })

  it('scores the default a scorekeeper can see, and the first pitch leaves it', async function () {
    const roster = await startingContext(
      db!,
      games.shown,
      { home_team_id: home, away_team_id: away },
      () => false
    )
    const personOf = (id: number): LineupPerson => {
      const player = roster.setup.players[id]
      return {
        gumboId: player.id,
        name: player.fullName,
        jersey: player.jersey
      }
    }
    const team = roster.setup.sides.away
    const reversed: Lineup = {
      batters: [...team.battingOrder].reverse().map(personOf),
      defense: Object.fromEntries(
        POSITIONS.map(position => {
          const id = team.defense[position]
          return [position, id == null ? null : personOf(id)]
        })
      ) as Lineup['defense']
    }
    await db!
      .updateTable('teams')
      .set({
        default_lineup: {
          lineup: reversed,
          fromGameId: games.live,
          setAt: new Date().toISOString()
        }
      })
      .where('id', '=', away)
      .execute()
    const teamDefault = async (): Promise<unknown> => {
      const row = await db!
        .selectFrom('teams')
        .select('default_lineup')
        .where('id', '=', away)
        .executeTakeFirstOrThrow()
      return row.default_lineup
    }
    try {
      const opened = await ScoringSession.open(
        {
          load: async () => ({ plays: [], currentPlay: null }),
          save: async () => {
            throw new Error('Not saved here')
          }
        },
        games.shown,
        await startingContext(
          db!,
          games.shown,
          { home_team_id: home, away_team_id: away },
          teamId => teamId === home
        ),
        { requireCurrentSetup: true }
      )
      const hosts = bodyOf(opened.state, 'home')
      const saved = await save(games.shown, COACH, hosts)
      expect(saved.status, JSON.stringify(saved.body)).equals(200)
      const fan = asGameLineupsResponse(
        (await ask('GET', `/games/${games.shown}/lineups`, FAN)).body
      )
      const orderOf = roster.setup.sides.away.battingOrder.map(
        id => roster.setup.players[id].id
      )
      expect(batters(fan.away)).deep.equals(orderOf)
      const before = await teamDefault()
      const replayed = await scoring(games.shown)
      const resumed = replayed.resumable()
      const shown = withVisibleDefaults(resumed.state, resumed.actions, {
        away: reversed
      })
      const setup = setupOf(shown)
      const confirmed = confirmedSides(resumed.actions, setup)
      expect(confirmed).includes('away')
      await score(games.shown, [
        { type: 'lineup', kind: 'roster', setup, confirmed },
        { type: 'pitch', call: 'B' }
      ])
      const after = asGameLineupsResponse(
        (await ask('GET', `/games/${games.shown}/lineups`, FAN)).body
      )
      expect(batters(after.away)).deep.equals(
        reversed.batters.map(person => person.gumboId)
      )
      expect(batters(after.home)).deep.equals(
        batters(asGameLineupsResponse(saved.body).home)
      )
      expect(await teamDefault()).deep.equals(before)
    } finally {
      await db!
        .updateTable('teams')
        .set({ default_lineup: null })
        .where('id', 'in', [away, home])
        .execute()
    }
  })

  it('answers the digest its own save left, though another lands before the answer', async function () {
    const session = await scoring(games.between)
    const body = bodyOf(session.state, 'home')
    body.battingOrder.reverse()
    let own: string | null = null
    afterSave = async gameId => {
      own = (await gameRow(gameId)).lineups_digest
      // A scorer swaps the visitors' first two batters in between.
      const scorer = await scoring(gameId)
      const setup = setupOf(scorer.state)
      const [first, second, ...rest] = setup.sides.away.battingOrder
      setup.sides.away.battingOrder = [second, first, ...rest]
      await score(gameId, [{ type: 'lineup', kind: 'roster', setup }])
    }
    const answer = await save(games.between, COACH, body)
    expect(answer.status, JSON.stringify(answer.body)).equals(200)
    expect(own).not.equals(null)
    expect(asGameLineupsResponse(answer.body).digest).equals(own)
    expect((await gameRow(games.between)).lineups_digest).not.equals(own)
  })

  it('saves mid-game, leaving the other side and the status be', async function () {
    const before = asGameLineupsResponse(
      (await ask('GET', `/games/${games.live}/lineups`, FAN)).body
    )
    const session = await scoring(games.live)
    const body = bodyOf(session.state, 'home')
    // Left and right fielders change places, and the players come in another
    // order than the game numbers them.
    const left = body.defense.LF!
    body.defense.LF = body.defense.RF
    body.defense.RF = left
    const order = body.players.map((_, i) => body.players.length - 1 - i)
    const shuffled: SaveLineupsBody = {
      ...body,
      base: before.digest,
      players: order.map(i => body.players[i]),
      battingOrder: body.battingOrder.map(i => order.indexOf(i)),
      defense: Object.fromEntries(
        Object.entries(body.defense).map(([position, i]) => [
          position,
          order.indexOf(i)
        ])
      )
    }
    const answer = await save(games.live, COACH, shuffled)
    expect(answer.status, JSON.stringify(answer.body)).equals(200)
    const read = asGameLineupsResponse(answer.body)
    expect(read.home.current?.defense.LF).deep.equals(
      before.home.current?.defense.RF
    )
    expect(read.home.current?.defense.RF).deep.equals(
      before.home.current?.defense.LF
    )
    expect(batters(read.home)).deep.equals(batters(before.home))
    expect(read.away.current).deep.equals(before.away.current)
    expect(read.digest).not.equals(before.digest)
    expect((await gameRow(games.live)).status).equals('inProgress')
    // The ball before it is still there.
    const after = await scoring(games.live)
    expect(after.state.liveData.linescore.balls).equals(1)
    expect(written.filter(id => id === games.live)).lengthOf(1)
  })

  it('keeps existing guests by identity and adds a newly persisted guest', async function () {
    const session = await scoring(games.locals)
    const body = bodyOf(session.state, 'home')
    const guest = await createGuestPlayer(
      db!,
      { userId: userIdOfGumbo(coach.userId), isAdmin: false, scopes: [] },
      games.locals,
      'home',
      {
        firstName: 'Newcomer',
        lastName: '',
        jersey: '88',
        positions: [],
        bats: null,
        throws: null
      }
    )
    body.players.push({
      gumboId: guest.gumboId!,
      fullName: 'Newcomer',
      jersey: '88'
    })
    body.defense.LF = body.players.length - 1
    const answer = await save(games.locals, COACH, body)
    expect(answer.status, JSON.stringify(answer.body)).equals(200)
    const read = asGameLineupsResponse(answer.body)
    expect(read.home.current?.defense.LF).deep.include({
      gumboId: guest.gumboId!,
      name: 'Newcomer'
    })
    const after = await scoring(games.locals)
    const named = (name: string): number =>
      after.state.liveData.boxscore.teams.home.players.filter(
        id => after.state.gameData.players[id].fullName === name
      ).length
    expect(named('Guest')).equals(1)
    expect(named('Newcomer')).equals(1)
  })

  it("saves and reloads a guest's jersey edit, never the name it posts, without changing identity or roster profiles", async function () {
    const initial = await scoring(games.locals)
    const guest = Object.values(initial.state.gameData.players).find(
      player => player.local && player.fullName === 'Guest'
    )!
    const seeded = setupOf(initial.state)
    seeded.players[guest.id].firstName = 'Guest'
    seeded.players[guest.id].lastName = ''
    await score(games.locals, [
      { type: 'lineup', kind: 'roster', setup: seeded }
    ])
    const session = await scoring(games.locals)
    const body = bodyOf(session.state, 'home')
    body.base = asGameLineupsResponse(
      (await ask('GET', `/games/${games.locals}/lineups`, COACH)).body
    ).digest
    const edited = body.players.find(player => player.gumboId === guest.id)!
    edited.fullName = 'Babe Ruth'
    edited.jersey = '03'
    const rostered = body.players.find(
      player => player.gumboId === homePlayers[0].userId
    )!
    const originalRostered = structuredClone(
      session.state.gameData.players[homePlayers[0].userId]
    )
    rostered.fullName = 'Willie Mays'
    rostered.jersey = '99'
    const users = await db!
      .selectFrom('users')
      .selectAll()
      .orderBy('id')
      .execute()
    const members = await db!
      .selectFrom('memberships')
      .selectAll()
      .orderBy('id')
      .execute()
    const answer = await save(games.locals, COACH, body)
    expect(answer.status, JSON.stringify(answer.body)).equals(200)
    const reopened = await scoring(games.locals)
    // A guest's name is his account's: the save renamed nobody.
    expect(reopened.state.gameData.players[guest.id]).includes({
      id: guest.id,
      fullName: 'Guest',
      jersey: '03',
      local: true
    })
    const stored = JSON.stringify(
      (await readPlays(db!, games.locals)).map(row => row.gumbo)
    )
    expect(stored).not.include('Babe Ruth')
    expect(stored).not.include('Willie Mays')
    expect(reopened.state.gameData.players[guest.id].firstName).equals(
      undefined
    )
    expect(reopened.state.gameData.players[guest.id].lastName).equals(undefined)
    expect(reopened.state.gameData.players[homePlayers[0].userId]).deep.equals(
      originalRostered
    )
    expect(
      await db!.selectFrom('users').selectAll().orderBy('id').execute()
    ).deep.equals(users)
    expect(
      await db!.selectFrom('memberships').selectAll().orderBy('id').execute()
    ).deep.equals(members)
    expect(
      reopened.state.liveData.boxscore.teams.home.players.filter(
        id => id === guest.id
      )
    ).length(1)
    expect(asGameLineupsResponse(answer.body).digest).not.equals(body.base)
    const same = bodyOf(reopened.state, 'home')
    same.base = asGameLineupsResponse(answer.body).digest
    const unchanged = await save(games.locals, COACH, same)
    expect(unchanged.status).equals(200)
    expect(asGameLineupsResponse(unchanged.body).digest).equals(same.base)
  })

  it('lets a scorekeeper save either side, with a pinch runner who keeps the order', async function () {
    const session = await scoring(games.runner)
    expect(session.state.liveData.linescore.offense.first).not.equals(null)
    const body = bodyOf(session.state, 'away')
    const guest = await createGuestPlayer(
      db!,
      { userId: userIdOfGumbo(scorer.userId), isAdmin: false, scopes: [] },
      games.runner,
      'away',
      {
        firstName: 'Freeman',
        lastName: '',
        jersey: '5',
        positions: [],
        bats: null,
        throws: null
      }
    )
    body.players.push({
      gumboId: guest.gumboId!,
      fullName: 'Freeman',
      jersey: '5'
    })
    body.runners = [{ base: '1B', player: body.players.length - 1 }]
    const answer = await save(games.runner, SCORER, body)
    expect(answer.status, JSON.stringify(answer.body)).equals(200)
    const after = await scoring(games.runner)
    expect(after.state.liveData.linescore.offense.first?.fullName).equals(
      'Freeman'
    )
    expect(after.state.liveData.boxscore.teams.away.battingOrder).deep.equals(
      session.state.liveData.boxscore.teams.away.battingOrder
    )
    const current = (await gameRow(games.runner)).currentPlay as {
      playEvents: Array<{ details: { eventType?: string } }>
    }
    expect(
      current.playEvents.filter(
        event => event.details.eventType === 'ts_courtesy_runner'
      )
    ).lengthOf(1)
    // A scorekeeper of the visitors saves the hosts' side too.
    const hosts = bodyOf(after.state, 'home')
    hosts.battingOrder = [...hosts.battingOrder.slice(1), hosts.battingOrder[0]]
    expect((await save(games.runner, SCORER, hosts)).status).equals(200)
  })

  it('refuses an assistant, a member and the other team’s coach', async function () {
    const session = await scoring(games.live)
    const body = bodyOf(session.state, 'home')
    body.battingOrder.reverse()
    for (const token of [ASSISTANT, FAN, AWAY_COACH]) {
      const answer = await save(games.live, token, body)
      expect(answer.status, token).equals(403)
      expect(answer.body.message).equals(
        "Only the team's head coach or a scorekeeper may save its lineup"
      )
    }
    // A team's admin is its head coach.
    const away = bodyOf(session.state, 'away')
    expect((await save(games.live, AWAY_COACH, away)).status).equals(200)
    expect((await save(games.live, TEAM_ADMIN, body)).status).equals(200)
  })

  it('refuses a save with nothing to change to a member, and writes nothing for a coach', async function () {
    const session = await scoring(games.live)
    const body = bodyOf(session.state, 'home')
    expect((await save(games.live, FAN, body)).status).equals(403)
    const before = await gameRow(games.live)
    const writes = written.length
    const answer = await save(games.live, COACH, body)
    expect(answer.status).equals(200)
    expect(asGameLineupsResponse(answer.body).digest).equals(
      before.lineups_digest
    )
    expect(await gameRow(games.live)).deep.equals(before)
    expect(written).lengthOf(writes)
  })

  it('answers 409 with the game’s reason while a play is pending, or the game is final', async function () {
    const session = await scoring(games.pending)
    const body = bodyOf(session.state, 'home')
    body.battingOrder.reverse()
    const pending = await save(games.pending, COACH, body)
    expect(pending.status).equals(409)
    expect(pending.body.message).equals('Finish the current play first')
    const fresh = await scoring(games.final)
    const final = bodyOf(fresh.state, 'home')
    final.battingOrder.reverse()
    const refused = await save(games.final, COACH, final)
    expect(refused.status).equals(409)
    expect(refused.body.message).equals('This game is final')
  })

  it('answers 400 for an index past the players, a stranger, a player twice or a change the game cannot make', async function () {
    const session = await scoring(games.live)
    const body = bodyOf(session.state, 'home')
    const past = await save(games.live, COACH, { ...body, battingOrder: [99] })
    expect(past.status).equals(400)
    expect(past.body.message).match(/Player 99 is not one of the 10 players/)
    const stranger = await save(games.live, COACH, {
      ...body,
      players: [
        ...body.players,
        { gumboId: fan.userId, fullName: 'Fan', jersey: '' }
      ]
    })
    expect(stranger.status).equals(400)
    expect(stranger.body.message).equals(
      'The lineup must include every available roster player and game guest'
    )
    const twice = await save(games.live, COACH, {
      ...body,
      players: [...body.players, body.players[0]]
    })
    expect(twice.status).equals(400)
    const empty = await save(games.live, SCORER, {
      ...bodyOf(session.state, 'away'),
      runners: [{ base: '3B', player: 0 }]
    })
    expect(empty.status).equals(400)
    expect(empty.body.message).equals('Nobody is on 3B')
    expect(
      (await save(games.live, COACH, { ...body, side: 'nowhere' })).status
    ).equals(400)
  })

  it('replays a game a scorer saved to mid-save, keeping his pitch', async function () {
    const session = await scoring(games.race)
    const body = bodyOf(session.state, 'home')
    const left = body.defense.LF!
    body.defense.LF = body.defense.CF
    body.defense.CF = left
    let tries = 0
    beforeSave = async gameId => {
      tries++
      if (tries === 1) await score(gameId, [{ type: 'pitch', call: 'C' }])
    }
    const answer = await save(games.race, COACH, body)
    expect(answer.status, JSON.stringify(answer.body)).equals(200)
    expect(tries).equals(2)
    const after = await scoring(games.race)
    expect(after.state.liveData.linescore.balls).equals(1)
    expect(after.state.liveData.linescore.strikes).equals(1)
    const home = after.state.liveData.boxscore.teams.home
    expect(home.defense.LF).equals(
      session.state.liveData.boxscore.teams.home.defense.CF
    )
  })

  it('refuses a save made on another play generation, and saves on the current one or none (S3)', async function () {
    await db!
      .updateTable('games')
      .set({ play_generation: 1 })
      .where('id', '=', games.generation)
      .execute()
    const read = await ask('GET', `/games/${games.generation}/lineups`, FAN)
    expect(read.body.generation).equals(1)
    const session = await scoring(games.generation)
    const body = bodyOf(session.state, 'home')
    body.battingOrder.reverse()
    const before = await gameRow(games.generation)
    const old = await save(games.generation, COACH, { ...body, generation: 0 })
    expect(old.status).equals(409)
    expect(old.body).deep.include({
      message: RESET_SINCE_READ,
      details: { stale: true, generation: 1 }
    })
    expect(await gameRow(games.generation)).deep.equals(before)
    const saved = await save(games.generation, COACH, {
      ...body,
      generation: 1
    })
    expect(saved.status, JSON.stringify(saved.body)).equals(200)
    expect(saved.body.generation).equals(1)
    // Naming none, as an app not yet updated sends it.
    body.battingOrder.reverse()
    const unnamed = await save(games.generation, COACH, body)
    expect(unnamed.status, JSON.stringify(unnamed.body)).equals(200)
  })

  it('refuses a scorer’s post built on the lineups a coach has saved over since', async function () {
    // The scorer reads the game, and its lineups' digest, before the save.
    const read = asGameLineupsResponse(
      (await ask('GET', `/games/${games.stale}/lineups`, FAN)).body
    )
    const before = await gameRow(games.stale)
    const session = await scoring(games.stale)
    const body = bodyOf(session.state, 'home')
    body.battingOrder.reverse()
    const saved = await save(games.stale, COACH, body)
    expect(saved.status, JSON.stringify(saved.body)).equals(200)
    const coached = asGameLineupsResponse(saved.body)
    // His next post would write back the at-bat it read, without the
    // coach's lineup: it names the digest it read, and is refused.
    const post = async (
      currentPlay: unknown,
      lineupsBase?: string
    ): Promise<unknown> =>
      await postGamePlays(
        db!,
        games.stale,
        asPostEventsBody({
          mode: 'live',
          source: { system: 'teamstation' },
          plays: [],
          currentPlay,
          ...(lineupsBase == null ? {} : { lineupsBase })
        })
      )
    let refused: unknown
    await post(before.currentPlay, read.digest).catch((error: unknown) => {
      refused = error
    })
    expect(refused).deep.include({
      code: 'conflict',
      details: { stale: true }
    })
    const after = asGameLineupsResponse(
      (await ask('GET', `/games/${games.stale}/lineups`, FAN)).body
    )
    expect(after.digest).equals(coached.digest)
    expect(batters(after.home)).deep.equals(batters(coached.home))
    // Built on the coach's lineups, it is written, and answers the digest.
    const posted = (await post(
      (await gameRow(games.stale)).currentPlay,
      coached.digest
    )) as { lineupsDigest: string }
    expect(posted.lineupsDigest).equals(coached.digest)
    // A post that names no base is written as it always was: the last one
    // saved wins.
    await post(before.currentPlay)
    expect((await gameRow(games.stale)).lineups_digest).equals(read.digest)
  })

  it('gives up with 409 after three replays that each found the game changed', async function () {
    const session = await scoring(games.busy)
    const body = bodyOf(session.state, 'home')
    body.battingOrder.reverse()
    let tries = 0
    beforeSave = async gameId => {
      tries++
      await score(gameId, [{ type: 'pitch', call: 'F' }])
    }
    const answer = await save(games.busy, COACH, body)
    expect(answer.status).equals(409)
    expect(answer.body).deep.equals({
      code: 'conflict',
      message: 'The game changed while saving; try again',
      // Marked as one to send again, apart from a refusal of the save.
      details: { retry: true }
    })
    expect(tries).equals(3)
    expect(written).not.include(games.busy)
  })
  it('requires exactly the available roster and guests after a head-coach toggle', async () => {
    const id = games.availability
    const userId = homePlayers[0].userId
    const toggle = async (
      rostered: boolean,
      token = COACH
    ): ReturnType<typeof ask> =>
      await ask('PUT', `/games/${id}/unroster`, token, {
        side: 'home',
        userId: userIdOfGumbo(userId),
        rostered
      })
    expect((await toggle(false, SCORER)).status).equals(403)
    expect((await toggle(false)).body).deep.equals({ away: [], home: [userId] })
    const old = bodyOf((await scoring(id)).state, 'home')
    expect((await save(id, COACH, old)).status).equals(400)
    const context = await startingContext(
      db!,
      id,
      { home_team_id: home, away_team_id: away },
      () => true
    )
    const session = await ScoringSession.open(
      {
        load: async () => ({ plays: [], currentPlay: null }),
        save: async () => {
          throw new Error('Read only')
        }
      },
      id,
      context
    )
    const body = bodyOf(session.state, 'home')
    expect(body.players.map(player => player.gumboId)).not.includes(userId)
    const guest = await createGuestPlayer(
      db!,
      { userId: userIdOfGumbo(coach.userId), isAdmin: false, scopes: [] },
      id,
      'home',
      {
        firstName: 'Babe',
        lastName: 'Ruth',
        jersey: '3',
        positions: [],
        bats: 'left',
        throws: 'left'
      }
    )
    expect((await save(id, COACH, body)).status).equals(400)
    body.players.push({
      gumboId: guest.gumboId!,
      fullName: guest.shortName,
      jersey: guest.jersey ?? ''
    })
    const missing = {
      ...body,
      players: body.players.slice(1),
      battingOrder: [],
      defense: {}
    }
    expect((await save(id, COACH, missing)).status).equals(400)
    expect((await save(id, COACH, body)).status).equals(200)
    expect((await toggle(true)).status).equals(200)
    const returned = (await scoring(id)).state.liveData.boxscore.teams.home
    expect(returned.players).includes(userId)
    expect(returned.battingOrder).not.includes(userId)
    expect(Object.values(returned.defense)).not.includes(userId)
    expect((await toggle(true)).status).equals(200)
    expect(
      (
        await ask('PUT', `/games/${id}/unroster`, COACH, {
          side: 'bad',
          userId: userIdOfGumbo(userId),
          rostered: false
        })
      ).status
    ).equals(400)
  })
})
