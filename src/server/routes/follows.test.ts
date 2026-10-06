import type { AddressInfo } from 'node:net'

import { expect } from 'chai'
import express from 'express'
import type { Kysely } from 'kysely'
import { after, before, describe, it } from 'mocha'
import { Pool } from 'pg'
import WebSocket from 'ws'

import { makeId } from '../../common/ids'
import { mintUserId } from '../../common/mintUserId'
import { migrations } from '../../migrate/migrations'
import { migrateUp } from '../../migrate/runner'
import { testDatabaseUrl } from '../../migrate/testDatabase'
import { visibleScopes } from '../access'
import { mergeTeams } from '../admin/mergeTeams'
import { hashToken } from '../auth/tokens'
import { type Database, makeDatabase } from '../db/database'
import { type ChatSeed, chatSeed } from '../dev/chatSeed'
import { jsonBody } from '../jsonBody'
import type { MediaContext } from '../media/mediaContext'
import { withAudit } from '../middleware/withAudit'
import { withActor } from '../middleware/withAuth'
import { errorHandler } from '../middleware/withErrors'
import { attachGameSocket, type GameSocketHandle } from '../socket/gameSocket'
import { followRoutes, seasonTitle } from './follows'
import { mediaRoutes } from './media'
import { playerRoutes } from './players'
import { teamRoutes } from './teams'

/**
 * U1: following a team, on the chat fixture (`chatSeed`) in a scratch
 * database, through the real routes.
 *
 * Fan F follows Hawks. Eagles parent D2 is on no Hawks roster and follows
 * nothing, so D2 sees nothing of Hawks until following it. Hawks coach Hc is
 * one of Hawks' own people.
 */

const adminUrl = testDatabaseUrl
const scratchName = `teamstation_follows_${Date.now()}_${process.pid}`
const scratchUrl = adminUrl.replace(/\/[^/]*$/, `/${scratchName}`)

interface Answer {
  status: number
  body: any
}

describe('following a team (U1)', function () {
  this.timeout(120000)

  let adminPool: Pool | undefined
  let db: Kysely<Database> | undefined
  let server: ReturnType<express.Express['listen']> | undefined
  let socket: GameSocketHandle | undefined
  let base = ''
  let socketUrl = ''
  let seed: ChatSeed
  const tokens = new Map<string, string>()
  const external = makeId('team')
  const merged = makeId('team')
  const ravens = makeId('team')
  const ravensTwo = makeId('team')
  const cancelled = makeId('game')
  let stranger = 0
  let mergedCoach = 0

  const database = (): Kysely<Database> => {
    if (db == null) throw new Error('no database')
    return db
  }
  const userId = (key: string): number => {
    const person = seed.people[key]
    if (person == null) throw new Error(`nobody called ${key}`)
    return person.userId
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
    seed = await chatSeed(db, {
      password: 'pw',
      now: new Date('2027-04-10T12:00:00Z')
    })

    // Somebody tied to nothing, and a merged row that holds a coach role.
    const taken = new Set(Object.values(seed.people).map(p => p.userId))
    const mint = (): { userId: number; legacyId: string } => {
      const made = mintUserId(id => taken.has(id))
      taken.add(made.userId)
      return made
    }
    const strangerRow = mint()
    const mergedRow = mint()
    stranger = strangerRow.userId
    mergedCoach = mergedRow.userId
    await db
      .insertInto('users')
      .values([
        {
          id: strangerRow.userId,
          legacyId: strangerRow.legacyId,
          display_name: 'Sol Stranger'
        },
        {
          id: mergedRow.userId,
          legacyId: mergedRow.legacyId,
          display_name: 'Hank Coach (old)',
          merged_into: userId('Hc')
        }
      ])
      .execute()

    const now = new Date()
    const sessions: Array<[string, number]> = [
      ...['F', 'D2', 'Hc', 'Z', 'E'].map((key): [string, number] => [
        key,
        userId(key)
      ]),
      ['X', stranger]
    ]
    for (const [key, id] of sessions) {
      const token = `tok_follows_${key}_${'0'.repeat(24)}`
      tokens.set(key, token)
      await db
        .insertInto('auth_sessions')
        .values({
          id: makeId('authSession'),
          user_id: id,
          token_hash: hashToken(token),
          created_at: now,
          expires_at: new Date(now.getTime() + 3_600_000)
        })
        .execute()
    }

    await db
      .insertInto('teams')
      .values([
        { id: external, name: 'Hawkeye Visitors', kind: 'external' },
        { id: merged, name: 'Hawks (old)', merged_into: seed.teams.hawks },
        { id: ravens, name: 'Ravens' },
        { id: ravensTwo, name: 'Ravens II' },
        ...Array.from({ length: 22 }, (_, i) => ({
          id: makeId('team'),
          name: `Search Team ${String(i).padStart(2, '0')}`
        }))
      ])
      .execute()
    await db
      .insertInto('scope_roles')
      .values([
        // A videographer is not staff.
        {
          id: makeId('scopeRole'),
          user_id: userId('N'),
          scope_type: 'team',
          scope_id: seed.teams.hawks,
          role: 'videographer'
        },
        // A merged row's role is its survivor's.
        {
          id: makeId('scopeRole'),
          user_id: mergedCoach,
          scope_type: 'team',
          scope_id: seed.teams.hawks,
          role: 'scorekeeper'
        }
      ])
      .execute()
    await db
      .insertInto('games')
      .values({
        id: cancelled,
        season_id: seed.seasonId,
        home_team_id: seed.teams.hawks,
        away_team_id: seed.teams.eagles,
        start_at: new Date('2027-04-01T17:00:00Z'),
        status: 'cancelled'
      })
      .execute()
    await db
      .insertInto('walk_up_songs')
      .values({
        team_id: seed.teams.hawks,
        user_id: userId('P'),
        provider: 'appleMusic',
        provider_id: '1',
        title: 'Song',
        artist: 'Band',
        duration_ms: 200000,
        start_ms: 0,
        end_ms: 10000,
        set_by: userId('Hs')
      })
      .execute()

    const media: MediaContext = {
      mediaRoot: '/tmp',
      ffmpegPath: 'ffmpeg',
      mediaSecret: 'secret',
      publicUrl: 'http://127.0.0.1',
      space: {
        endpoint: '',
        region: '',
        bucket: '',
        accessKeyId: '',
        secretAccessKey: '',
        pathStyle: true
      }
    }
    const app = express()
    app.use(jsonBody)
    app.use(withActor(db))
    app.use(withAudit(db))
    app.use('/api/v1', teamRoutes(db, media))
    app.use('/api/v1', followRoutes(db, media))
    app.use('/api/v1', playerRoutes(db, media))
    app.use('/api/v1', mediaRoutes(db, media))
    app.use(errorHandler)
    server = app.listen(0, '127.0.0.1')
    await new Promise<void>(resolve => server?.once('listening', resolve))
    const port = (server.address() as AddressInfo).port
    base = `http://127.0.0.1:${port}/api/v1`
    socketUrl = `ws://127.0.0.1:${port}/socket`
    socket = attachGameSocket(server, db, scratchUrl, {
      stopSignals: null,
      log: () => undefined,
      fanout: { log: () => undefined }
    })
    await socket.fanout.listening
  })

  after(async function () {
    if (socket != null) await socket.close()
    server?.close()
    if (db != null) await db.destroy()
    if (adminPool != null) {
      await adminPool.query(
        `drop database if exists ${scratchName} with (force)`
      )
      await adminPool.end()
    }
  })

  async function call(
    who: string | null,
    method: string,
    path: string
  ): Promise<Answer> {
    const token = who == null ? undefined : tokens.get(who)
    const response = await fetch(`${base}${path}`, {
      method,
      headers: token == null ? {} : { authorization: `Bearer ${token}` }
    })
    return {
      status: response.status,
      body: await response.json().catch(() => null)
    }
  }

  async function followRows(teamId: string): Promise<number[]> {
    const rows = await database()
      .selectFrom('team_follows')
      .select(['user_id'])
      .where('team_id', '=', teamId)
      .orderBy('user_id')
      .execute()
    return rows.map(row => row.user_id)
  }

  describe('search', function () {
    it('needs a session and two characters', async function () {
      expect((await call(null, 'GET', '/teams/search?q=Haw')).status).equals(
        401
      )
      for (const query of ['', '?q=', '?q=H', '?q=%20H%20']) {
        const answer = await call('X', 'GET', `/teams/search${query}`)
        expect(answer.status, query).equals(400)
        expect(answer.body.code).equals('badRequest')
      }
    })

    it('finds full, unmerged teams by any part of the name, and says which are followed', async function () {
      const answer = await call('F', 'GET', '/teams/search?q=hAW')
      expect(answer.status).equals(200)
      expect(answer.body).deep.equals([
        {
          id: seed.teams.hawks,
          name: 'Hawks',
          logoUrl: null,
          seasons: [{ id: seed.seasonId, title: 'QPLL Spring 2027' }],
          following: true
        }
      ])
      const unfollowed = await call('X', 'GET', '/teams/search?q=Haw')
      expect(unfollowed.body[0].following).equals(false)
      const ravensFound = await call('X', 'GET', '/teams/search?q=avens')
      expect(
        ravensFound.body.map((team: { name: string }) => team.name)
      ).deep.equals(['Ravens', 'Ravens II'])
      expect(ravensFound.body[0].seasons).deep.equals([])
    })

    it('stops at twenty, and reads a % or _ as itself', async function () {
      const answer = await call('X', 'GET', '/teams/search?q=Search%20Team')
      expect(answer.body).length(20)
      expect(answer.body[0].name).equals('Search Team 00')
      expect(answer.body[19].name).equals('Search Team 19')
      for (const query of ['%25%25', '__', 'S%25T']) {
        const literal = await call('X', 'GET', `/teams/search?q=${query}`)
        expect(literal.body, query).deep.equals([])
      }
    })
  })

  describe('follow and unfollow', function () {
    it('are idempotent, and answer whether the caller follows', async function () {
      for (let i = 0; i < 2; i += 1) {
        const answer = await call('X', 'PUT', `/teams/${ravens}/follow`)
        expect(answer).deep.equals({ status: 200, body: { following: true } })
      }
      expect(await followRows(ravens)).deep.equals([stranger])
      const mine = await call('X', 'GET', '/me/follows')
      expect(mine.body).deep.equals([
        {
          id: ravens,
          name: 'Ravens',
          logoUrl: null,
          seasons: [],
          following: true
        }
      ])
      for (let i = 0; i < 2; i += 1) {
        const answer = await call('X', 'DELETE', `/teams/${ravens}/follow`)
        expect(answer).deep.equals({ status: 200, body: { following: false } })
      }
      expect(await followRows(ravens)).deep.equals([])
      expect((await call('X', 'GET', '/me/follows')).body).deep.equals([])
    })

    it('answers 404 for a missing, external or merged team, and 401 without a session', async function () {
      for (const teamId of ['tem_nosuch', external, merged]) {
        expect(
          (await call('X', 'PUT', `/teams/${teamId}/follow`)).status
        ).equals(404)
        expect(
          (await call('X', 'DELETE', `/teams/${teamId}/follow`)).status
        ).equals(404)
      }
      expect(
        (await call(null, 'PUT', `/teams/${ravens}/follow`)).status
      ).equals(401)
      expect((await call(null, 'GET', '/me/follows')).status).equals(401)
      expect(await followRows(merged)).deep.equals([])
    })

    it('lists only the full, unmerged teams followed in /me/follows', async function () {
      const answer = await call('F', 'GET', '/me/follows')
      expect(answer.body.map((team: { id: string }) => team.id)).deep.equals([
        seed.teams.hawks
      ])
    })
  })

  describe('what a fan sees', function () {
    it('keeps the followed team out of teamIds', async function () {
      const fan = await visibleScopes(database(), userId('F'), false)
      expect([...fan.teamIds]).deep.equals([])
      expect([...fan.followedTeamIds]).deep.equals([seed.teams.hawks])
      // A follow of one's own team adds nothing to follow.
      const player = await visibleScopes(database(), userId('E'), false)
      expect([...player.teamIds]).deep.equals([seed.teams.eagles])
      expect([...player.followedTeamIds]).deep.equals([seed.teams.hawks])
      const coach = await visibleScopes(database(), userId('Hc'), false)
      expect([...coach.followedTeamIds]).deep.equals([])
    })

    it('lists the team in GET /teams as a fan, with no record', async function () {
      const fan = await call('F', 'GET', '/teams')
      expect(fan.status).equals(200)
      expect(fan.body).length(1)
      expect(fan.body[0]).deep.include({
        id: seed.teams.hawks,
        access: 'fan',
        record: null,
        following: true,
        onTeam: false
      })
      const coach = await call('Hc', 'GET', '/teams')
      expect(coach.body).length(1)
      expect(coach.body[0]).deep.include({
        id: seed.teams.hawks,
        access: 'member',
        following: false,
        onTeam: true
      })
      expect(coach.body[0].record).deep.include({ w: 1, l: 0 })
      const player = await call('E', 'GET', '/teams')
      expect(
        player.body.map((team: { name: string; access: string }) => [
          team.name,
          team.access
        ])
      ).deep.equals([
        ['Eagles', 'member'],
        ['Hawks', 'fan']
      ])
      expect((await call('X', 'GET', '/teams')).body).deep.equals([])
      const admin = await call('Z', 'GET', '/teams')
      const hawks = admin.body.find(
        (team: { id: string }) => team.id === seed.teams.hawks
      )
      expect(hawks).deep.include({ access: 'member', onTeam: false })
    })

    it('reads the schedule with dates and opponents and nothing more', async function () {
      const answer = await call(
        'F',
        'GET',
        `/teams/${seed.teams.hawks}/schedule`
      )
      expect(answer.status).equals(200)
      expect(answer.body).deep.equals([
        {
          gameId: seed.games.hawksOwlsFinal,
          startsAt: '2027-04-03T17:00:00.000Z',
          homeTeam: { id: seed.teams.hawks, name: 'Hawks' },
          awayTeam: { id: seed.teams.owls, name: 'Owls' },
          venue: 'Northpoint Field 1'
        },
        {
          gameId: seed.games.hawksOwlsNext,
          startsAt: '2027-04-17T17:00:00.000Z',
          homeTeam: { id: seed.teams.owls, name: 'Owls' },
          awayTeam: { id: seed.teams.hawks, name: 'Hawks' },
          venue: 'Northpoint Field 2'
        },
        {
          gameId: seed.games.eaglesHawksNext,
          startsAt: '2027-04-18T17:00:00.000Z',
          homeTeam: { id: seed.teams.eagles, name: 'Eagles' },
          awayTeam: { id: seed.teams.hawks, name: 'Hawks' },
          venue: 'Northpoint Field 1'
        }
      ])
      // The cancelled game is left out for a member too.
      const coach = await call(
        'Hc',
        'GET',
        `/teams/${seed.teams.hawks}/schedule`
      )
      expect(
        coach.body.map((game: { gameId: string }) => game.gameId)
      ).not.to.include(cancelled)
    })

    it('reads the roster without its followers, songs or whole names', async function () {
      const answer = await call('F', 'GET', `/teams/${seed.teams.hawks}/roster`)
      expect(answer.status).equals(200)
      const groups = answer.body.map(
        (entry: { group: string; shortName: string }) =>
          `${entry.group} ${entry.shortName}`
      )
      expect(groups).deep.equals([
        'coach Harper H',
        'player Pat P',
        'player Quilvio V',
        'player Riley R',
        'player Trea T'
      ])
      for (const entry of answer.body) {
        expect(entry).not.to.have.property('walkUpSong')
      }
      const coach = await call('Hc', 'GET', `/teams/${seed.teams.hawks}/roster`)
      const followers = coach.body.filter(
        (entry: { group: string }) => entry.group === 'follower'
      )
      // The parents, P's guardians and the team's role holders, who are
      // members.
      expect(followers.length).equals(9)
      const pat = coach.body.find(
        (entry: { userId: number }) => entry.userId === userId('P')
      )
      expect(pat.walkUpSong).deep.include({ title: 'Song' })
    })

    it('reads the staff with their roles on the team, and nobody else', async function () {
      const answer = await call('F', 'GET', `/teams/${seed.teams.hawks}/staff`)
      expect(answer.status).equals(200)
      expect(
        answer.body.map(
          (entry: { shortName: string; roles: string[]; userId: number }) => [
            entry.shortName,
            entry.roles
          ]
        )
      ).deep.equals([
        ['Harper H', ['admin']],
        ['Hank C', ['coach', 'scorekeeper']],
        ['Holly S', ['scorekeeper']],
        ['Hugo S', ['songkeeper']]
      ])
      expect(answer.body[1]).deep.equals({
        userId: userId('Hc'),
        shortName: 'Hank C',
        avatarUrl: null,
        roles: ['coach', 'scorekeeper']
      })
      const owls = await call('Z', 'GET', `/teams/${seed.teams.owls}/staff`)
      expect(owls.body).deep.equals([])
    })

    it('answers 404 for the games, a game, its box score, stats, a player and a video', async function () {
      const reads = [
        `/teams/${seed.teams.hawks}/games`,
        `/games/${seed.games.hawksOwlsFinal}`,
        `/games/${seed.games.hawksOwlsFinal}/box-score`,
        `/teams/${seed.teams.hawks}/stats`,
        `/players/${userId('P')}`,
        `/videos/${seed.videoId}/playback`
      ]
      for (const path of reads) {
        expect((await call('F', 'GET', path)).status, path).equals(404)
        // And they are there for the team's own people.
        expect((await call('Hc', 'GET', path)).status, path).not.equals(404)
      }
    })

    it('is refused a Hawks game on the socket', async function () {
      const ws = new WebSocket(socketUrl, {
        headers: { authorization: `Bearer ${tokens.get('F') ?? ''}` }
      })
      await new Promise<void>((resolve, reject) => {
        ws.once('open', () => {
          resolve()
        })
        ws.once('error', reject)
      })
      const reply = new Promise<any>(resolve => {
        ws.once('message', data => {
          resolve(JSON.parse((data as Buffer).toString('utf8')))
        })
      })
      ws.send(
        JSON.stringify({
          type: 'subscribe',
          gameId: seed.games.hawksOwlsFinal,
          id: 'c1'
        })
      )
      expect(await reply).deep.include({
        type: 'error',
        id: 'c1',
        code: 'notFound'
      })
      ws.close()
    })
  })

  describe('somebody who neither belongs nor follows', function () {
    it('gets 404 from the schedule, roster and staff, until following', async function () {
      const reads = ['schedule', 'roster', 'staff'].map(
        what => `/teams/${seed.teams.hawks}/${what}`
      )
      for (const path of reads) {
        expect((await call('D2', 'GET', path)).status, path).equals(404)
      }
      await call('D2', 'PUT', `/teams/${seed.teams.hawks}/follow`)
      for (const path of reads) {
        expect((await call('D2', 'GET', path)).status, path).equals(200)
      }
      await call('D2', 'DELETE', `/teams/${seed.teams.hawks}/follow`)
      for (const path of reads) {
        expect((await call('D2', 'GET', path)).status, path).equals(404)
      }
      expect(
        (await call('X', 'GET', `/teams/tem_nosuch/schedule`)).status
      ).equals(404)
    })
  })

  describe('a team merge', function () {
    it('moves the follows to the survivor, once each', async function () {
      await call('X', 'PUT', `/teams/${ravens}/follow`)
      await call('X', 'PUT', `/teams/${ravensTwo}/follow`)
      await call('F', 'PUT', `/teams/${ravensTwo}/follow`)
      const planned = await mergeTeams(database(), {
        fromTeamId: ravensTwo,
        intoTeamId: ravens
      })
      expect(planned.repointed['team_follows.team_id']).equals(2)
      expect(await followRows(ravensTwo)).length(2)

      await mergeTeams(database(), {
        fromTeamId: ravensTwo,
        intoTeamId: ravens,
        apply: true
      })
      expect(await followRows(ravens)).deep.equals(
        [stranger, userId('F')].sort((a, b) => a - b)
      )
      expect(await followRows(ravensTwo)).deep.equals([])
      // And the merged team can no longer be found or followed.
      const found = await call('X', 'GET', '/teams/search?q=Ravens')
      expect(found.body.map((team: { id: string }) => team.id)).deep.equals([
        ravens
      ])
      expect(
        (await call('X', 'PUT', `/teams/${ravensTwo}/follow`)).status
      ).equals(404)
    })
  })

  it('titles a season with its league when it has one', function () {
    expect(seasonTitle('QPLL', 'Spring 2027')).equals('QPLL Spring 2027')
    expect(seasonTitle(null, 'Titan Force 2026')).equals('Titan Force 2026')
  })
})
