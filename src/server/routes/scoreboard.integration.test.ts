import { readFileSync } from 'node:fs'
import type { AddressInfo } from 'node:net'

import { expect } from 'chai'
import express from 'express'
import type { Kysely } from 'kysely'
import { after, before, describe, it } from 'mocha'

import { makeId } from '../../common/ids'
import { asScoreboardState, NO_OVERRIDES } from '../../common/scoreboard'
import {
  asScoreboardDashboard,
  asScoreboardEvents,
  asScoreboardView
} from '../../common/scoreboardEvents'
import {
  addGame,
  addPerson,
  addTeam,
  dropPrefix,
  type Person,
  quiet,
  requireRedis,
  scratchDatabase,
  testPrefix,
  testStore
} from '../../test/scoreboardKit'
import type { Database } from '../db/database'
import { jsonBody } from '../jsonBody'
import type { MediaContext } from '../media/mediaContext'
import { withActor } from '../middleware/withAuth'
import { errorHandler } from '../middleware/withErrors'
import {
  makeScoreboardClient,
  makeScoreboardStore,
  type ScoreboardClient,
  type ScoreboardStore
} from '../scoreboard/scoreboardStore'
import { eventListRoutes } from './eventList'
import { scoreboardRoutes } from './scoreboard'
import { teamRoutes } from './teams'

/**
 * The scoreboard over HTTP, on a scratch database and a real Redis: the
 * lists Watcher picks from, the board anybody may read, the dashboard's
 * state, and the `scoreboard` a game's answer carries.
 */

const HOUR = 3_600_000
const MINUTE = 60_000
const FIXTURE = 'src/server/scoreboard/fixtures/scoreboardEvents.json'
const RECENT =
  '/api/v1/events?scope=run&when=recent&lookbackHours=3&scoreboard=open&limit=10'
const UPCOMING = '/api/v1/events?scope=run&when=future&limit=5'

const media: MediaContext = {
  ffmpegPath: '/usr/bin/ffmpeg',
  mediaRoot: '/tmp',
  mediaSecret: 'secret',
  publicUrl: 'http://127.0.0.1',
  space: {
    endpoint: '',
    region: '',
    bucket: '',
    accessKeyId: '',
    secretAccessKey: '',
    pathStyle: false
  }
}

describe('the scoreboard over HTTP', function () {
  this.timeout(60000)

  let db: Kysely<Database>
  let drop: () => Promise<void>
  let client: ScoreboardClient
  let store: ScoreboardStore
  let offline: ScoreboardClient
  let server: ReturnType<express.Express['listen']> | undefined
  let base = ''
  let prefix = ''

  let runner: Person
  let viewer: Person
  let admin: Person
  let nobody: Person
  const games: Record<string, string> = {}
  let elsewhere = ''

  before(async function () {
    await requireRedis()
    ;({ db, drop } = await scratchDatabase('scoreboard_routes'))
    prefix = testPrefix()
    ;({ client, store } = await testStore(prefix))
    // A store whose Redis is away: never connected, so never ready.
    offline = makeScoreboardClient('redis://127.0.0.1:1', quiet)
    const away = makeScoreboardStore({ client: offline, prefix })

    const pioneers = await addTeam(db, 'Pioneers')
    const visitors = await addTeam(db, 'Visitors')
    const others = await addTeam(db, 'Others')
    runner = await addPerson(db, 'runner', { owns: pioneers })
    viewer = await addPerson(db, 'viewer')
    await db
      .insertInto('memberships')
      .values({
        id: makeId('membership'),
        user_id: viewer.userId,
        team_id: pioneers,
        role: 'member'
      })
      .execute()
    admin = await addPerson(db, 'admin', { isAdmin: true })
    nobody = await addPerson(db, 'nobody')

    const now = Date.now()
    const at = (offset: number): Date => new Date(now + offset)
    const slots: Array<[string, number]> = [
      ['-4h', -4 * HOUR],
      ['-2h59m', -2 * HOUR - 59 * MINUTE],
      ['-10m', -10 * MINUTE],
      ...[1, 2, 3, 4, 5, 6, 7].map((hours): [string, number] => [
        `+${hours}h`,
        hours * HOUR
      ])
    ]
    for (const [name, offset] of slots) {
      games[name] = await addGame(db, {
        homeTeamId: pioneers,
        awayTeamId: visitors,
        startAt: at(offset)
      })
    }
    games.cancelled = await addGame(db, {
      homeTeamId: pioneers,
      awayTeamId: visitors,
      startAt: at(30 * MINUTE),
      status: 'cancelled'
    })
    elsewhere = await addGame(db, {
      homeTeamId: others,
      awayTeamId: visitors,
      startAt: at(-5 * MINUTE)
    })

    const app = express()
    app.use(jsonBody)
    app.use(withActor(db))
    app.use('/api/v1', scoreboardRoutes(db, store))
    app.use('/api/v1', eventListRoutes(db, media, { store }))
    app.use('/api/v1', teamRoutes(db, media, store))
    app.use('/plain/api/v1', teamRoutes(db, media))
    app.use('/away/api/v1', scoreboardRoutes(db, away))
    app.use('/away/api/v1', eventListRoutes(db, media, { store: away }))
    app.use('/away/api/v1', teamRoutes(db, media, away))
    app.use(errorHandler)
    server = app.listen(0, '127.0.0.1')
    await new Promise(resolve => server?.once('listening', resolve))
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  })

  after(async function () {
    server?.close()
    if (client?.isOpen) await client.close()
    if (offline?.isOpen) await offline.close().catch(() => undefined)
    await dropPrefix('ts-test')
    await drop?.()
  })

  async function get(
    path: string,
    who?: Person
  ): Promise<{ status: number; body: any }> {
    const answer = await fetch(`${base}${path}`, {
      headers: who == null ? {} : { authorization: `Bearer ${who.token}` }
    })
    return { status: answer.status, body: await answer.json() }
  }
  const ids = (list: Array<{ gameId: string }>): string[] =>
    list.map(event => event.gameId)

  it('lists recent open games and the next five for a runner', async function () {
    const recent = await get(RECENT, runner)
    const upcoming = await get(UPCOMING, runner)
    expect(recent.status).equals(200)
    // The game 2 h 59 m in has no key, so it is closed and not listed.
    expect(ids(recent.body)).deep.equals([games['-10m']])
    expect(ids(upcoming.body)).deep.equals(
      ['+1h', '+2h', '+3h', '+4h', '+5h'].map(name => games[name])
    )

    // Written an hour after its start, it is open until two hours after that.
    const late = await testStore(prefix, () => Date.now() - 2 * HOUR + MINUTE)
    const startAt = Date.now() - 2 * HOUR - 59 * MINUTE
    expect(
      (await late.store.mergeWatcher(games['-2h59m'], { outs: 1 }, startAt))
        .kind
    ).equals('written')
    await late.client.close()
    const second = await get(RECENT, runner)
    expect(ids(second.body)).deep.equals([games['-10m'], games['-2h59m']])
    expect(ids((await get(UPCOMING, runner)).body)).has.length(5)
  })

  it('lists nothing for somebody who runs nothing, everything for an admin, and refuses no token', async function () {
    expect((await get(RECENT, nobody)).body).deep.equals([])
    expect((await get(UPCOMING, nobody)).body).deep.equals([])
    expect((await get(RECENT, viewer)).body).deep.equals([])
    expect((await get(UPCOMING, viewer)).body).deep.equals([])
    const recent = await get(RECENT, admin)
    const upcoming = await get(UPCOMING, admin)
    expect(ids(recent.body)).includes(elsewhere).and.includes(games['-10m'])
    expect(ids(recent.body)).not.includes(games['-4h'])
    expect(ids(upcoming.body)).not.includes(games.cancelled)
    expect((await get(RECENT)).status).equals(401)
  })

  it('answers in the committed fixture’s shape', async function () {
    const fixture: unknown = JSON.parse(readFileSync(FIXTURE, 'utf8'))
    const parsed = asScoreboardEvents(fixture)
    const keys = Object.keys(parsed.recent[0]).sort()
    const recent = (await get(RECENT, runner)).body as object[]
    const upcoming = (await get(UPCOMING, runner)).body as object[]
    for (const event of [...recent, ...upcoming]) {
      expect(Object.keys(event)).to.include.members(keys)
    }
    expect(Object.keys(parsed.upcoming[0]).sort()).deep.equals(keys)
  })

  it('shows the board to anybody while it is open, and 404 otherwise', async function () {
    const open = await get(`/api/v1/scoreboard/${games['-10m']}`)
    expect(open.status).equals(200)
    const view = asScoreboardView(open.body)
    expect(view.state).includes({
      homeTeam: 'Pioneers',
      awayTeam: 'Visitors',
      homeScore: 0
    })
    expect(asScoreboardState(open.body.state)).deep.equals(view.state)
    for (const closed of [games['-4h'], games.cancelled, 'gam_nothere']) {
      expect((await get(`/api/v1/scoreboard/${closed}`)).status).equals(404)
    }
  })

  it('answers 404 for an id no game could have', async function () {
    const nothing = ['%00', 'gam_%01x', 'g'.repeat(65), 'gam_%2Fx', '%E0%A4%A']
    for (const id of nothing) {
      const board = await get(`/api/v1/scoreboard/${id}`)
      expect(board.status, id).equals(404)
      expect(board.body.code).equals('notFound')
      const dashboard = await get(`/api/v1/scoreboard/${id}/dashboard`, runner)
      expect(dashboard.status, id).equals(404)
    }
    // The longest id there could be is still asked about.
    expect((await get(`/api/v1/scoreboard/${'g'.repeat(64)}`)).status).equals(
      404
    )
  })

  it('gives the dashboard its five fields, to a runner only', async function () {
    const path = `/api/v1/scoreboard/${games['+1h']}/dashboard`
    await store.mergeWatcher(games['+1h'], { balls: 2 }, Date.now() + HOUR)
    const answer = await get(path, runner)
    expect(answer.status).equals(200)
    expect(Object.keys(answer.body).sort()).deep.equals([
      'automated',
      'final',
      'gameAt',
      'overrides',
      'watcherAt'
    ])
    const dashboard = asScoreboardDashboard(answer.body)
    expect(dashboard.automated.balls).equals(2)
    expect(answer.body.overrides).deep.equals(NO_OVERRIDES)
    expect(dashboard.gameAt).equals(undefined)
    expect(dashboard.watcherAt).is.a('number')
    expect((await get(path, viewer)).status).equals(404)
    expect((await get(path)).status).equals(401)
    expect(
      (await get(`/api/v1/scoreboard/${games['-4h']}/dashboard`, runner)).status
    ).equals(404)
  })

  it('tells a game’s page whether the board is open and who may override it', async function () {
    const detail = async (
      gameId: string,
      who: Person,
      root = '/api/v1'
    ): Promise<unknown> =>
      (await get(`${root}/games/${gameId}`, who)).body.scoreboard
    expect(await detail(games['-10m'], runner)).deep.equals({
      open: true,
      mayOverride: true
    })
    expect(await detail(games['-10m'], viewer)).deep.equals({
      open: true,
      mayOverride: false
    })
    // Past start + 2 h: open while its key lives, closed once it is gone.
    await client.del(store.keyOf(games['-2h59m']))
    expect(await detail(games['-2h59m'], runner)).deep.equals({
      open: false,
      mayOverride: true
    })
    const late = await testStore(prefix, () => Date.now() - 2 * HOUR + MINUTE)
    await late.store.mergeWatcher(
      games['-2h59m'],
      { outs: 2 },
      Date.now() - 2 * HOUR - 59 * MINUTE
    )
    await late.client.close()
    expect(await detail(games['-2h59m'], runner)).deep.equals({
      open: true,
      mayOverride: true
    })
    // No store, and a store whose Redis is away: null, and nothing else changes.
    const plain = await get(`/plain/api/v1/games/${games['-10m']}`, runner)
    const full = await get(`/api/v1/games/${games['-10m']}`, runner)
    expect(plain.body.scoreboard).equals(null)
    expect({ ...plain.body, scoreboard: 'x' }).deep.equals({
      ...full.body,
      scoreboard: 'x'
    })
    expect(await detail(games['-10m'], runner, '/away/api/v1')).equals(null)
  })

  it('tells a game’s page who may score it, by the rule a posted play meets', async function () {
    const hosts = await addTeam(db, 'Hosts')
    const guests = await addTeam(db, 'Guests')
    const league = makeId('league')
    const season = makeId('season')
    await db.insertInto('leagues').values({ id: league, name: 'L' }).execute()
    await db
      .insertInto('seasons')
      .values({
        starts_on: `2026-03-01`,
        ends_on: `2026-05-31`,
        id: season,
        league_id: league,
        name: 'S',
        year: 2026
      })
      .execute()
    await db
      .insertInto('season_teams')
      .values([
        { season_id: season, team_id: hosts, joined_at: new Date() },
        { season_id: season, team_id: guests, joined_at: new Date() }
      ])
      .execute()
    // This fixture explicitly models management in addition to competition.
    await db
      .updateTable('teams')
      .set({ league_id: league })
      .where('id', 'in', [hosts, guests])
      .execute()
    await db
      .insertInto('season_team_parents')
      .values([
        { season_id: season, team_id: hosts },
        { season_id: season, team_id: guests }
      ])
      .execute()
    const gameId = await addGame(db, {
      homeTeamId: hosts,
      awayTeamId: guests,
      startAt: new Date()
    })
    await db
      .updateTable('games')
      .set({ season_id: season })
      .where('id', '=', gameId)
      .execute()
    const owner = await addPerson(db, 'hostOwner', { owns: hosts })
    const manager = await addPerson(db, 'guestManager')
    const member = await addPerson(db, 'hostMember')
    const spectator = await addPerson(db, 'seasonViewer')
    const seasonAdmin = await addPerson(db, 'seasonAdmin')
    const leagueAdmin = await addPerson(db, 'leagueAdmin')
    for (const [who, team, role] of [
      [manager, guests, 'manager'],
      [member, hosts, 'member']
    ] as const) {
      await db
        .insertInto('memberships')
        .values({
          id: makeId('membership'),
          user_id: who.userId,
          team_id: team,
          role
        })
        .execute()
    }
    // The season and league admins see the game as members of the season
    // and the league; what they may change comes from their admin roles.
    for (const who of [spectator, seasonAdmin]) {
      await db
        .insertInto('season_members')
        .values({
          id: makeId('seasonMember'),
          user_id: who.userId,
          season_id: season,
          joined_at: new Date()
        })
        .execute()
    }
    await db
      .insertInto('league_members')
      .values({
        id: makeId('leagueMember'),
        user_id: leagueAdmin.userId,
        league_id: league,
        joined_at: new Date()
      })
      .execute()
    await db
      .insertInto('scope_roles')
      .values([
        {
          id: makeId('scopeRole'),
          user_id: seasonAdmin.userId,
          scope_type: 'season',
          scope_id: season,
          granted_at: new Date()
        },
        {
          id: makeId('scopeRole'),
          user_id: leagueAdmin.userId,
          scope_type: 'league',
          scope_id: league,
          granted_at: new Date()
        }
      ])
      .execute()

    const mayScore = async (
      who: Person,
      root = '/api/v1'
    ): Promise<unknown> => {
      const answer = await get(`${root}/games/${gameId}`, who)
      expect(answer.status).equals(200)
      return answer.body.canScore
    }
    for (const [label, who, expected] of [
      ['an owner of the home team', owner, true],
      ['a manager of the away team', manager, true],
      ['a season admin', seasonAdmin, true],
      ['a league admin', leagueAdmin, true],
      ['a site admin', admin, true],
      ['a plain member', member, false],
      ['a season viewer', spectator, false]
    ] as const) {
      expect(await mayScore(who), label).equals(expected)
    }
    // Without a store, and with Redis away: it needs neither.
    expect(await mayScore(owner, '/plain/api/v1')).equals(true)
    expect(await mayScore(owner, '/away/api/v1')).equals(true)
    expect(await mayScore(member, '/away/api/v1')).equals(false)
    // Whoever may score may override the board.
    expect(
      (await get(`/api/v1/games/${gameId}`, manager)).body.scoreboard
    ).deep.equals({ open: true, mayOverride: true })
  })

  it('answers 503 with Redis away', async function () {
    for (const path of [
      `/away/api/v1/scoreboard/${games['-10m']}`,
      `/away/api/v1/scoreboard/${games['-10m']}/dashboard`,
      '/away/api/v1/events?scoreboard=open'
    ]) {
      const answer = await get(path, runner)
      expect(answer.status, path).equals(503)
      expect(answer.body).deep.equals({
        code: 'unavailable',
        message: 'The scoreboard is unavailable'
      })
    }
  })
})
