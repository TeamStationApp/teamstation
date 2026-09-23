import type { Server } from 'node:http'

import { expect } from 'chai'
import express from 'express'
import { type Insertable, Kysely, PostgresDialect } from 'kysely'
import { after, before, describe, it } from 'mocha'
import { Pool } from 'pg'

import type { GameChange } from '../../common/gameSocket'
import { makeId } from '../../common/ids'
import { mintUserId } from '../../common/mintUserId'
import type { Role } from '../../common/roles'
import type { WalkUpSong } from '../../common/walkUpSong'
import { migrations } from '../../migrate/migrations'
import { migrateUp } from '../../migrate/runner'
import { testDatabaseUrl } from '../../migrate/testDatabase'
import type { GameScope } from '../access'
import type { Database, ScopeRolesTable } from '../db/database'
import { attachInt8Parser } from '../db/int8'
import { withAudit } from '../middleware/withAudit'
import { errorHandler } from '../middleware/withErrors'
import { GameFanout } from '../socket/fanout'
import { readWalkUpSong, walkUpSongRoutes } from './walkUpSongs'

/**
 * Who may set a player's walk-up song on a team, what a song must be, and
 * that every change reaches the games the team plays in.
 */
const adminUrl = testDatabaseUrl
const scratchName = `gamestation_walkup_${Date.now()}`
const scratchUrl = adminUrl.replace(/\/[^/]*$/, `/${scratchName}`)

const taken = new Set<number>()
const legacyOf = new Map<number, string>()
function mintUser(): number {
  const made = mintUserId(id => taken.has(id))
  taken.add(made.userId)
  legacyOf.set(made.userId, made.legacyId)
  return made.userId
}

const centerfield: WalkUpSong = {
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
const fixture: WalkUpSong = {
  provider: 'localFile',
  providerId: 'lf:0123456789abcdef',
  isrc: null,
  title: 'Walkup Fixture',
  artist: 'GameStation',
  album: null,
  artworkUrl: null,
  durationMs: 90000,
  startMs: 5000,
  endMs: 20000
}

const wait = async (ms: number): Promise<void> => {
  await new Promise(resolve => setTimeout(resolve, ms))
}

async function until(ready: () => boolean, what: string): Promise<void> {
  const deadline = Date.now() + 3000
  while (!ready()) {
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${what}`)
    await wait(10)
  }
}

describe('walk-up songs', function () {
  this.timeout(60000)

  let admin: Pool | undefined
  let pool: Pool | undefined
  let db: Kysely<Database>
  let server: Server | undefined
  let fanout: GameFanout | undefined
  let base = ''

  const leagueId = makeId('league')
  const seasonId = makeId('season')
  const teamId = makeId('team')
  const rivalId = makeId('team')
  const otherId = makeId('team')
  const finalGame = makeId('game')
  const laterGame = makeId('game')
  const elsewhereGame = makeId('game')

  // Players: two on the team, one on the rival, one who leaves.
  const batterId = mintUser()
  const secondId = mintUser()
  const rivalPlayerId = mintUser()
  const leaverId = mintUser()
  // People: one per flag on the team, songkeepers at each level, admins.
  const songkeeperId = mintUser()
  const seasonSongkeeperId = mintUser()
  const leagueSongkeeperId = mintUser()
  const teamAdminId = mintUser()
  const managerId = mintUser()
  const siteAdminId = mintUser()
  const scorekeeperId = mintUser()
  const coachId = mintUser()
  const videographerId = mintUser()
  const memberId = mintUser()

  const songOf = (team: string, player: number): string =>
    `/teams/${team}/players/${player}/walk-up-song`

  const send = async (
    method: 'PUT' | 'DELETE',
    path: string,
    viewer: number,
    body?: unknown
  ): Promise<{ status: number; body: unknown }> => {
    const response = await fetch(base + path, {
      method,
      headers: {
        'x-test-user': String(viewer),
        ...(body === undefined ? {} : { 'content-type': 'application/json' })
      },
      body: body === undefined ? undefined : JSON.stringify(body)
    })
    const text = await response.text()
    return {
      status: response.status,
      body: text === '' ? undefined : JSON.parse(text)
    }
  }

  const subscriber = (): {
    sent: GameChange[]
    send: (message: GameChange) => void
    maySee: () => Promise<boolean>
  } => {
    const sent: GameChange[] = []
    return {
      sent,
      send: message => {
        sent.push(message)
      },
      maySee: async () => true
    }
  }
  const scopeOf = (home: string, away: string): GameScope => ({
    homeTeamId: home,
    awayTeamId: away,
    seasonId
  })

  before(async function () {
    attachInt8Parser()
    admin = new Pool({ connectionString: adminUrl })
    try {
      await admin.query('select 1')
    } catch {
      await admin.end()
      admin = undefined
      this.skip()
      return
    }
    await admin.query(`create database ${scratchName}`)
    pool = new Pool({ connectionString: scratchUrl })
    await migrateUp(pool, migrations)
    db = new Kysely<Database>({ dialect: new PostgresDialect({ pool }) })

    await db
      .insertInto('leagues')
      .values({ id: leagueId, name: 'Spring league' })
      .execute()
    await db
      .insertInto('seasons')
      .values({
        id: seasonId,
        name: 'Spring 2026',
        year: 2026,
        league_id: leagueId
      })
      .execute()
    await db
      .insertInto('teams')
      .values([
        { id: teamId, name: 'Badgers' },
        { id: rivalId, name: 'Legends' },
        { id: otherId, name: 'Owls' }
      ])
      .execute()
    await db
      .insertInto('season_teams')
      .values([
        { season_id: seasonId, team_id: teamId },
        { season_id: seasonId, team_id: rivalId }
      ])
      .execute()
    await db
      .insertInto('users')
      .values(
        [...taken].map(id => ({
          id,
          legacyId: legacyOf.get(id) ?? '',
          display_name: `Person ${id}`,
          is_admin: id === siteAdminId
        }))
      )
      .execute()
    const member = (
      userId: number,
      team: string,
      extra: { is_player?: boolean; role?: 'manager' } = {}
    ): {
      id: string
      user_id: number
      team_id: string
      is_player?: boolean
      role?: 'manager'
    } => ({
      id: makeId('membership'),
      user_id: userId,
      team_id: team,
      ...extra
    })
    await db
      .insertInto('memberships')
      .values([
        member(batterId, teamId, { is_player: true }),
        member(secondId, teamId, { is_player: true }),
        member(leaverId, teamId, { is_player: true }),
        member(rivalPlayerId, rivalId, { is_player: true }),
        member(managerId, teamId, { role: 'manager' }),
        member(memberId, teamId),
        member(songkeeperId, teamId),
        member(scorekeeperId, teamId),
        member(coachId, teamId),
        member(videographerId, teamId)
      ])
      .execute()
    const flag = (
      userId: number,
      scopeType: 'league' | 'season' | 'team',
      scopeId: string,
      role: Role
    ): Insertable<ScopeRolesTable> => ({
      id: makeId('scopeRole'),
      user_id: userId,
      scope_type: scopeType,
      scope_id: scopeId,
      role,
      granted_by: null,
      granted_at: new Date()
    })
    await db
      .insertInto('scope_roles')
      .values([
        flag(songkeeperId, 'team', teamId, 'songkeeper'),
        flag(seasonSongkeeperId, 'season', seasonId, 'songkeeper'),
        flag(leagueSongkeeperId, 'league', leagueId, 'songkeeper'),
        flag(teamAdminId, 'team', teamId, 'admin'),
        flag(scorekeeperId, 'team', teamId, 'scorekeeper'),
        flag(coachId, 'team', teamId, 'coach'),
        flag(videographerId, 'team', teamId, 'videographer')
      ])
      .execute()
    const now = Date.now()
    await db
      .insertInto('games')
      .values([
        {
          id: finalGame,
          home_team_id: teamId,
          away_team_id: rivalId,
          season_id: seasonId,
          start_at: new Date(now - 30 * 86_400_000),
          status: 'final'
        },
        {
          id: laterGame,
          home_team_id: rivalId,
          away_team_id: teamId,
          season_id: seasonId,
          start_at: new Date(now + 21 * 86_400_000)
        },
        {
          id: elsewhereGame,
          home_team_id: otherId,
          away_team_id: rivalId,
          season_id: seasonId,
          start_at: new Date(now)
        }
      ])
      .execute()

    const app = express()
    app.use((req, _res, next) => {
      const id = req.header('x-test-user')
      if (id != null) {
        req.actor = {
          userId: Number(id),
          isAdmin: Number(id) === siteAdminId,
          scopes: []
        }
      }
      next()
    })
    app.use(express.json())
    app.use(withAudit(db))
    app.use(walkUpSongRoutes(db))
    app.use(errorHandler)
    server = await new Promise<Server>(resolve => {
      const listening = app.listen(0, '127.0.0.1', () => {
        resolve(listening)
      })
    })
    const bound = server.address()
    if (bound == null || typeof bound === 'string') throw new Error('no port')
    base = `http://127.0.0.1:${bound.port}`
  })

  after(async function () {
    await fanout?.close()
    await new Promise<void>(resolve => {
      if (server == null) resolve()
      else
        server.close(() => {
          resolve()
        })
    })
    await pool?.end()
    if (admin != null) {
      await admin.query(`drop database if exists ${scratchName} with (force)`)
      await admin.end()
    }
  })

  it('lets songkeepers of the team, season and league, and admins, set a song', async function () {
    for (const viewer of [
      songkeeperId,
      seasonSongkeeperId,
      leagueSongkeeperId,
      teamAdminId,
      managerId,
      siteAdminId
    ]) {
      const song = { ...centerfield, startMs: 1000 + (viewer % 1000) }
      const answer = await send('PUT', songOf(teamId, batterId), viewer, song)
      expect(answer.status, String(viewer)).equals(200)
      expect(answer.body).deep.equals(song)
      expect(await readWalkUpSong(db, teamId, batterId)).deep.equals(song)
    }
    const row = await db
      .selectFrom('walk_up_songs')
      .select(['set_by'])
      .where('team_id', '=', teamId)
      .where('user_id', '=', batterId)
      .executeTakeFirstOrThrow()
    expect(row.set_by).equals(siteAdminId)
  })

  it('answers 404 to anybody else, and for anybody who is not a player on the team', async function () {
    for (const viewer of [scorekeeperId, coachId, videographerId, memberId]) {
      for (const method of ['PUT', 'DELETE'] as const) {
        const answer = await send(
          method,
          songOf(teamId, secondId),
          viewer,
          method === 'PUT' ? centerfield : undefined
        )
        expect(answer.status, `${method} ${viewer}`).equals(404)
      }
    }
    // Rights come first: a bad body from somebody with none is still 404.
    expect(
      (await send('PUT', songOf(teamId, secondId), coachId, {})).status
    ).equals(404)
    // A member who does not play, a player on another team, and teams and
    // players that do not exist.
    for (const path of [
      songOf(teamId, memberId),
      songOf(teamId, rivalPlayerId),
      songOf(rivalId, rivalPlayerId),
      songOf('tem_none', batterId),
      `/teams/${teamId}/players/nobody/walk-up-song`
    ]) {
      const answer = await send('PUT', path, songkeeperId, centerfield)
      expect(answer.status, path).equals(404)
    }
    // A site admin may set a song on any team, the rival's included.
    expect(
      (await send('PUT', songOf(rivalId, rivalPlayerId), siteAdminId, fixture))
        .status
    ).equals(200)
    expect(await readWalkUpSong(db, teamId, secondId)).equals(null)
  })

  it('refuses a bad body with 400', async function () {
    for (const body of [
      {},
      [],
      'song',
      { ...centerfield, provider: 'spotify' },
      { ...centerfield, providerId: '' },
      { ...fixture, providerId: 'lf:nothex' },
      { ...centerfield, title: '' },
      { ...centerfield, durationMs: 0 },
      { ...centerfield, startMs: -1 },
      { ...centerfield, endMs: centerfield.startMs + 999 },
      { ...centerfield, endMs: centerfield.startMs + 60001 },
      { ...centerfield, startMs: 229000, endMs: 231000 }
    ]) {
      const answer = await send(
        'PUT',
        songOf(teamId, secondId),
        songkeeperId,
        body
      )
      expect(answer.status, JSON.stringify(body)).equals(400)
    }
    expect(await readWalkUpSong(db, teamId, secondId)).equals(null)
  })

  it('removes a song, and answers 204 again when there is none', async function () {
    await send('PUT', songOf(teamId, secondId), songkeeperId, fixture)
    expect(
      (await send('DELETE', songOf(teamId, secondId), songkeeperId)).status
    ).equals(204)
    expect(await readWalkUpSong(db, teamId, secondId)).equals(null)
    expect(
      (await send('DELETE', songOf(teamId, secondId), songkeeperId)).status
    ).equals(204)
  })

  it('audits each change', async function () {
    await send('PUT', songOf(teamId, leaverId), songkeeperId, centerfield)
    await send('PUT', songOf(teamId, leaverId), songkeeperId, fixture)
    await send('DELETE', songOf(teamId, leaverId), songkeeperId)
    let audited: Array<{ method: string; before: unknown; after: unknown }> = []
    for (let tries = 0; tries < 100 && audited.length < 3; tries++) {
      await wait(10)
      audited = await db
        .selectFrom('audit_log')
        .select(['method', 'before', 'after', 'at'])
        .where('entity_type', '=', 'walkUpSong')
        .where('entity_id', '=', String(leaverId))
        .orderBy('at')
        .execute()
        .then(rows => rows.map(({ at: _, ...row }) => row))
    }
    expect(audited).deep.equals([
      {
        method: 'PUT',
        before: { teamId, song: null },
        after: { teamId, song: centerfield }
      },
      {
        method: 'PUT',
        before: { teamId, song: centerfield },
        after: { teamId, song: fixture }
      },
      {
        method: 'DELETE',
        before: { teamId, song: fixture },
        after: { teamId, song: null }
      }
    ])
  })

  it('goes with its player, and with its team', async function () {
    await send('PUT', songOf(teamId, leaverId), songkeeperId, centerfield)
    await db.deleteFrom('users').where('id', '=', leaverId).execute()
    expect(await readWalkUpSong(db, teamId, leaverId)).equals(null)

    const gone = makeId('team')
    await db.insertInto('teams').values({ id: gone, name: 'Gone' }).execute()
    await db
      .insertInto('memberships')
      .values({
        id: makeId('membership'),
        user_id: secondId,
        team_id: gone,
        is_player: true
      })
      .execute()
    await send('PUT', songOf(gone, secondId), siteAdminId, fixture)
    expect(await readWalkUpSong(db, gone, secondId)).deep.equals(fixture)
    await db.deleteFrom('teams').where('id', '=', gone).execute()
    expect(await readWalkUpSong(db, gone, secondId)).equals(null)
  })

  it('refuses a clip the table does not allow, whoever writes it', async function () {
    const row = {
      team_id: teamId,
      user_id: secondId,
      provider: 'appleMusic' as const,
      provider_id: '1',
      title: 'T',
      artist: 'A',
      duration_ms: 60000,
      start_ms: 0,
      end_ms: 30000,
      set_by: siteAdminId
    }
    for (const bad of [
      { provider: 'spotify' as 'appleMusic' },
      { duration_ms: 0, end_ms: 0 },
      { start_ms: -1 },
      { end_ms: 500 },
      { end_ms: 61000 },
      { duration_ms: 20000 }
    ]) {
      let refused = false
      try {
        await db
          .insertInto('walk_up_songs')
          .values({ ...row, ...bad })
          .execute()
      } catch {
        refused = true
      }
      expect(refused, JSON.stringify(bad)).equals(true)
    }
  })

  it('announces a change to every game of the team, final or weeks away', async function () {
    fanout = new GameFanout({
      db,
      databaseUrl: scratchUrl,
      log: () => undefined
    })
    await fanout.listening
    const onFinal = subscriber()
    const onLater = subscriber()
    const onElsewhere = subscriber()
    fanout.watch(finalGame, scopeOf(teamId, rivalId), onFinal)
    fanout.watch(laterGame, scopeOf(rivalId, teamId), onLater)
    fanout.watch(elsewhereGame, scopeOf(otherId, rivalId), onElsewhere)

    expect(
      (await send('PUT', songOf(teamId, secondId), songkeeperId, fixture))
        .status
    ).equals(200)
    await until(
      () => onFinal.sent.length === 1 && onLater.sent.length === 1,
      'the song on both games'
    )
    for (const [heard, gameId] of [
      [onFinal, finalGame],
      [onLater, laterGame]
    ] as const) {
      expect(heard.sent[0]).to.include({
        type: 'change',
        gameId,
        kind: 'walkUpSong'
      })
      expect(heard.sent[0].data).deep.equals({
        teamId,
        userId: secondId,
        song: fixture
      })
    }

    // Two players at once are two changes, both sent.
    await Promise.all([
      send('PUT', songOf(teamId, batterId), songkeeperId, centerfield),
      send('DELETE', songOf(teamId, secondId), songkeeperId)
    ])
    await until(() => onFinal.sent.length === 3, 'both players')
    const byPlayer = new Map(
      onFinal.sent.slice(1).map(message => {
        const data = message.data as Extract<
          GameChange,
          { kind: 'walkUpSong' }
        >['data']
        return [data.userId, data.song]
      })
    )
    expect(byPlayer.get(batterId)).deep.equals(centerfield)
    expect(byPlayer.get(secondId)).equals(null)

    // A removal with nothing to remove announces nothing.
    await send('DELETE', songOf(teamId, secondId), songkeeperId)
    await wait(300)
    expect(onFinal.sent).length(3)
    expect(onLater.sent).length(3)
    expect(onElsewhere.sent).length(0)
  })
})
