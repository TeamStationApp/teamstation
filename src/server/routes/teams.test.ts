import type { AddressInfo } from 'node:net'

import { expect } from 'chai'
import express from 'express'
import type { Insertable, Kysely } from 'kysely'
import { after, before, describe, it } from 'mocha'
import { Pool } from 'pg'

import { makeId } from '../../common/ids'
import { userIdOfGumbo } from '../../common/userId'
import { migrations } from '../../migrate/migrations'
import { migrateUp } from '../../migrate/runner'
import { testDatabaseUrl } from '../../migrate/testDatabase'
import {
  type GuardianFixture,
  guardianFixture
} from '../../test/guardianFixture'
import { mintUserId } from '../../test/historicalUserIds'
import { insertFixtureUsers } from '../../test/insertFixtureUsers'
import { hashToken } from '../auth/tokens'
import type { Database } from '../db/database'
import { makeDatabase } from '../db/database'
import { jsonBody } from '../jsonBody'
import type { MediaContext } from '../media/mediaContext'
import { withAudit } from '../middleware/withAudit'
import { withActor } from '../middleware/withAuth'
import { errorHandler } from '../middleware/withErrors'
import { teamRoutes } from './teams'

/**
 * Finding a team by the id another system has for it, and making one when
 * there is none: `GET /teams?externalId=` and `POST /teams`.
 */

const adminUrl = testDatabaseUrl
const scratchName = `teamstation_teams_route_${Date.now()}`
const scratchUrl = adminUrl.replace(/\/[^/]*$/, `/${scratchName}`)

const ADMIN = 'tok_teams_admin_00000000000000000000'
const MEMBER = 'tok_teams_member_0000000000000000000'
const SEASON_ADMIN = 'tok_teams_seasonadmin_00000000000000'
const LEAGUE_ADMIN = 'tok_teams_leagueadmin_00000000000000'

const admin = mintUserId(() => false)
const member = mintUserId(id => id === admin.userId)
const seasonAdmin = mintUserId(id =>
  [admin, member].some(one => one.userId === id)
)
const leagueAdmin = mintUserId(id =>
  [admin, member, seasonAdmin].some(one => one.userId === id)
)

interface Answer {
  status: number
  body: any
}

describe('teams by external id, and making one', function () {
  this.timeout(60000)

  let adminPool: Pool | undefined
  let db: Kysely<Database> | undefined
  let server: ReturnType<express.Express['listen']> | undefined
  let base = ''
  const force = makeId('season')
  const circuit = makeId('league')
  const circuitSeason = makeId('season')
  const hawks = makeId('team')
  const gulls = makeId('team')
  const rivals = makeId('team')
  const oldHawks = makeId('team')
  const game = makeId('game')

  const database = (): Kysely<Database> => {
    if (db == null) throw new Error('no database')
    return db
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
      [
        { made: admin, name: 'Adam Dunn', isAdmin: true },
        { made: member, name: 'Cam Bedrosian', isAdmin: false },
        { made: seasonAdmin, name: 'Sam Fuld', isAdmin: false },
        { made: leagueAdmin, name: 'Lee Smith', isAdmin: false }
      ].map(person => ({
        id: person.made.userId,
        legacyId: person.made.legacyId,
        display_name: person.name,
        login_enabled: true,
        is_admin: person.isAdmin,
        created_at: now,
        updated_at: now
      }))
    )
    await db
      .insertInto('auth_sessions')
      .values(
        (
          [
            [ADMIN, admin.userId],
            [MEMBER, member.userId],
            [SEASON_ADMIN, seasonAdmin.userId],
            [LEAGUE_ADMIN, leagueAdmin.userId]
          ] as Array<[string, number]>
        ).map(([token, userId]) => ({
          id: makeId('authSession'),
          user_id: userIdOfGumbo(userId),
          token_hash: hashToken(token),
          created_at: now,
          expires_at: new Date(now.getTime() + 3_600_000)
        }))
      )
      .execute()
    await db
      .insertInto('leagues')
      .values({ id: circuit, name: 'Circuit' })
      .execute()
    await db
      .insertInto('seasons')
      .values([
        {
          starts_on: `2026-03-01`,
          ends_on: `2026-05-31`,
          id: force,
          name: 'Titan Force 2026',
          year: 2026
        },
        {
          starts_on: `2026-03-01`,
          ends_on: `2026-05-31`,
          id: circuitSeason,
          name: 'Circuit 2026',
          year: 2026,
          league_id: circuit
        }
      ])
      .execute()
    // An administrator of the Force season, and one of the Circuit league,
    // neither a site administrator.
    await db
      .insertInto('scope_roles')
      .values([
        {
          id: makeId('scopeRole'),
          user_id: userIdOfGumbo(seasonAdmin.userId),
          scope_type: 'season',
          scope_id: force,
          role: 'admin',
          granted_at: now
        },
        {
          id: makeId('scopeRole'),
          user_id: userIdOfGumbo(leagueAdmin.userId),
          scope_type: 'league',
          scope_id: circuit,
          role: 'admin',
          granted_at: now
        }
      ])
      .execute()
    await db
      .insertInto('teams')
      .values([
        { id: hawks, name: 'Hawks' },
        { id: gulls, name: 'Gulls' },
        { id: rivals, name: 'Rivals', kind: 'external' },
        { id: oldHawks, name: 'Hawks (old)', merged_into: hawks }
      ])
      .execute()
    await db
      .insertInto('season_teams')
      .values([
        { season_id: force, team_id: hawks },
        { season_id: force, team_id: gulls }
      ])
      .execute()
    await db
      .insertInto('memberships')
      .values({
        id: makeId('membership'),
        user_id: userIdOfGumbo(member.userId),
        team_id: hawks
      })
      .execute()
    await db
      .insertInto('games')
      .values({
        id: game,
        season_id: force,
        home_team_id: hawks,
        away_team_id: rivals,
        start_at: new Date('2026-05-02T17:00:00Z')
      })
      .execute()
    const externalId = (
      entityType: string,
      entityId: string,
      kind: string,
      id: string
    ): Insertable<Database['external_ids']> => ({
      id: makeId('externalId'),
      entity_type: entityType,
      entity_id: entityId,
      system: 'otherLeague',
      kind,
      external_id: id,
      created_at: now
    })
    await db
      .insertInto('external_ids')
      .values([
        externalId('team', hawks, 'team', 'ext-hawks'),
        externalId('team', hawks, 'alias', 'nick-hawks'),
        externalId('team', gulls, 'team', 'ext-gulls'),
        externalId('team', rivals, 'team', 'ext-rivals'),
        externalId('team', oldHawks, 'team', 'ext-old-hawks'),
        externalId('game', game, 'event', 'ext-game')
      ])
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
    app.use(withActor(db))
    app.use(jsonBody)
    app.use(withAudit(db))
    app.use('/api/v1', teamRoutes(db, media))
    app.use(errorHandler)
    server = app.listen(0, '127.0.0.1')
    await new Promise<void>(resolve => server?.once('listening', resolve))
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/v1`
  })

  after(async function () {
    server?.close()
    if (db != null) await db.destroy()
    if (adminPool != null) {
      await adminPool.query(
        `drop database if exists ${scratchName} with (force)`
      )
      await adminPool.end()
    }
  })

  async function list(token: string | null, query = ''): Promise<Answer> {
    const response = await fetch(`${base}/teams${query}`, {
      headers: token == null ? {} : { authorization: `Bearer ${token}` }
    })
    return {
      status: response.status,
      body: await response.json().catch(() => null)
    }
  }

  async function create(token: string | null, body: unknown): Promise<Answer> {
    const response = await fetch(`${base}/teams`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(token == null ? {} : { authorization: `Bearer ${token}` })
      },
      body: JSON.stringify(body)
    })
    return {
      status: response.status,
      body: await response.json().catch(() => null)
    }
  }

  const ids = (answer: Answer): string[] =>
    (answer.body as Array<{ id: string }>).map(team => team.id).sort()

  async function counts(): Promise<{ teams: number; seasons: number }> {
    const teams = await database()
      .selectFrom('teams')
      .select(eb => eb.fn.countAll<string>().as('n'))
      .executeTakeFirstOrThrow()
    const seasons = await database()
      .selectFrom('seasons')
      .select(eb => eb.fn.countAll<string>().as('n'))
      .executeTakeFirstOrThrow()
    return { teams: Number(teams.n), seasons: Number(seasons.n) }
  }

  describe('GET /teams', function () {
    it('says which external ids each team has, asked by one or not', async function () {
      const all = await list(ADMIN)
      expect(all.status).equals(200)
      const byId = new Map(
        (all.body as Array<{ id: string; externalIds: string[] }>).map(team => [
          team.id,
          team.externalIds
        ])
      )
      expect(byId.get(hawks)).deep.equals(['ext-hawks', 'nick-hawks'])
      expect(byId.get(gulls)).deep.equals(['ext-gulls'])
      // An opponent is never listed, whatever ids it holds, and nor is a
      // team merged into another.
      expect(byId.has(rivals)).equals(false)
      expect(byId.has(oldHawks)).equals(false)
      expect((await list(MEMBER)).body).deep.equals([
        {
          id: hawks,
          name: 'Hawks',
          shortName: null,
          logoPath: null,
          logoUrl: null,
          record: null,
          externalIds: ['ext-hawks', 'nick-hawks'],
          kind: 'full'
        }
      ])
      // Asking for full teams is asking for nothing more.
      expect((await list(MEMBER, '?kind=full')).body).deep.equals(
        (await list(MEMBER)).body
      )
      expect(
        (all.body as Array<{ kind: string }>).every(
          team => team.kind === 'full'
        )
      ).equals(true)
    })

    it('narrows to the teams holding any of the ids, among those the caller may see', async function () {
      expect(ids(await list(ADMIN, '?externalId=ext-hawks'))).deep.equals([
        hawks
      ])
      expect(ids(await list(ADMIN, '?externalId=nick-hawks'))).deep.equals([
        hawks
      ])
      expect(
        ids(await list(ADMIN, '?externalId=ext-gulls&externalId=ext-hawks'))
      ).deep.equals([gulls, hawks].sort())
      expect(ids(await list(ADMIN, '?externalId=ext-none'))).deep.equals([])
      // An opponent's id, and a game's, find no team.
      expect(ids(await list(ADMIN, '?externalId=ext-rivals'))).deep.equals([])
      expect(ids(await list(ADMIN, '?externalId=ext-game'))).deep.equals([])
      expect(ids(await list(ADMIN, '?externalId=ext-old-hawks'))).deep.equals(
        []
      )

      expect(ids(await list(MEMBER, '?externalId=ext-hawks'))).deep.equals([
        hawks
      ])
      expect(ids(await list(MEMBER, '?externalId=ext-gulls'))).deep.equals([])
      expect(
        ids(await list(MEMBER, '?externalId=ext-gulls&externalId=ext-hawks'))
      ).deep.equals([hawks])
    })

    it('refuses an externalId with no usable value, and nobody at all', async function () {
      for (const query of [
        '?externalId=',
        '?externalId=ext-hawks&externalId='
      ]) {
        const refused = await list(ADMIN, query)
        expect(refused.status, query).equals(400)
        expect(refused.body, query).deep.include({
          message: 'externalId must be a non-empty string'
        })
      }
      expect((await list(null, '?externalId=ext-hawks')).status).equals(401)
    })
  })

  describe('GET /teams?season=', function () {
    // Bay 2026: two full teams, one merged into another, and the external
    // teams its games were played against, one of them merged too. Cove
    // 2026: one of each.
    const bay = makeId('season')
    const cove = makeId('season')
    const herons = makeId('team')
    const sealions = makeId('team')
    const oldSealions = makeId('team')
    const gullsLive = makeId('team')
    const otters = makeId('team')
    const oldOtters = makeId('team')
    const bobcats = makeId('team')
    const coyotes = makeId('team')
    const visitors = makeId('team')

    before(async function () {
      const db = database()
      await db
        .insertInto('seasons')
        .values([
          {
            starts_on: `2026-03-01`,
            ends_on: `2026-05-31`,
            id: bay,
            name: 'Bay 2026',
            year: 2026
          },
          {
            starts_on: `2026-03-01`,
            ends_on: `2026-05-31`,
            id: cove,
            name: 'Cove 2026',
            year: 2026
          }
        ])
        .execute()
      await db
        .insertInto('teams')
        .values([
          { id: herons, name: 'Harbor Herons' },
          { id: sealions, name: 'Sea Lions' },
          { id: oldSealions, name: 'Sea Lions (old)', merged_into: sealions },
          { id: gullsLive, name: 'Gulls - Livestream', kind: 'external' },
          { id: otters, name: 'Otters 1', kind: 'external' },
          {
            id: oldOtters,
            name: 'Otters',
            kind: 'external',
            merged_into: otters
          },
          { id: bobcats, name: 'Bobcats' },
          { id: coyotes, name: 'Coyotes', kind: 'external' },
          // A full team of no season here that played one of Bay's games.
          { id: visitors, name: 'Visiting Plovers' }
        ])
        .execute()
      await db
        .insertInto('season_teams')
        .values([
          { season_id: bay, team_id: herons },
          { season_id: bay, team_id: sealions },
          { season_id: bay, team_id: oldSealions },
          { season_id: cove, team_id: bobcats }
        ])
        .execute()
      const game = (
        season: string,
        home: string,
        away: string,
        day: number
      ): Insertable<Database['games']> => ({
        id: makeId('game'),
        season_id: season,
        home_team_id: home,
        away_team_id: away,
        start_at: new Date(Date.UTC(2026, 4, day, 17))
      })
      await db
        .insertInto('games')
        .values([
          game(bay, herons, gullsLive, 2),
          game(bay, gullsLive, sealions, 9),
          game(bay, herons, oldOtters, 16),
          game(bay, visitors, sealions, 20),
          game(cove, bobcats, coyotes, 23)
        ])
        .execute()
      await db
        .insertInto('external_ids')
        .values({
          id: makeId('externalId'),
          entity_type: 'team',
          entity_id: gullsLive,
          system: 'scoreKeeper',
          kind: 'opponent',
          external_id: 'opp-gulls-1',
          created_at: new Date()
        })
        .execute()
    })

    const kinds = (answer: Answer): Array<[string, string]> =>
      (answer.body as Array<{ id: string; kind: string }>)
        .map((team): [string, string] => [team.id, team.kind])
        .sort((a, b) => a[0].localeCompare(b[0]))
    const sorted = (pairs: Array<[string, string]>): Array<[string, string]> =>
      [...pairs].sort((a, b) => a[0].localeCompare(b[0]))

    it('lists a season\u2019s full teams, and the external teams its games were against', async function () {
      expect(kinds(await list(ADMIN, `?season=${bay}`))).deep.equals(
        sorted([
          [herons, 'full'],
          [sealions, 'full']
        ])
      )
      expect(kinds(await list(ADMIN, `?season=${bay}&kind=any`))).deep.equals(
        sorted([
          [herons, 'full'],
          [sealions, 'full'],
          [gullsLive, 'external'],
          [otters, 'external']
        ])
      )
      expect(
        kinds(await list(ADMIN, `?season=${bay}&kind=external`))
      ).deep.equals(
        sorted([
          [gullsLive, 'external'],
          [otters, 'external']
        ])
      )
      expect(
        kinds(await list(ADMIN, `?season=${bay}&season=${cove}&kind=any`))
      ).deep.equals(
        sorted([
          [herons, 'full'],
          [sealions, 'full'],
          [gullsLive, 'external'],
          [otters, 'external'],
          [bobcats, 'full'],
          [coyotes, 'external']
        ])
      )
      // An external team in the answer carries its ids, and `externalId`
      // narrows the season's teams further.
      const narrowed = await list(
        ADMIN,
        `?season=${bay}&kind=any&externalId=opp-gulls-1`
      )
      expect(narrowed.body).deep.equals([
        {
          id: gullsLive,
          name: 'Gulls - Livestream',
          shortName: null,
          logoPath: null,
          logoUrl: null,
          record: null,
          externalIds: ['opp-gulls-1'],
          kind: 'external'
        }
      ])
    })

    it('lists a season\u2019s teams to anybody who may see or schedule in it, and 404s otherwise', async function () {
      // An administrator of the Force season sees its teams, whoever they
      // belong to; a league administrator, the league's season's.
      expect(ids(await list(SEASON_ADMIN, `?season=${force}`))).deep.equals(
        [hawks, gulls].sort()
      )
      expect(
        ids(await list(LEAGUE_ADMIN, `?season=${circuitSeason}&kind=any`))
      ).deep.equals([])
      // The member can neither see nor schedule in Bay, nor in Force.
      for (const query of [`?season=${bay}`, `?season=${force}&kind=any`]) {
        expect((await list(MEMBER, query)).status, query).equals(404)
      }
      // One unseen season among seen ones is enough to refuse.
      expect(
        (await list(SEASON_ADMIN, `?season=${force}&season=${bay}`)).status
      ).equals(404)
      expect((await list(ADMIN, '?season=sea_nothere')).status).equals(404)
    })

    it('gives a team listed by season its record from the seasons asked only', async function () {
      // Gulls also plays in Reef 2026, a season the season administrator
      // cannot see, and won there; it has no finished game in Force.
      const reef = makeId('season')
      const db = database()
      await db
        .insertInto('seasons')
        .values({
          starts_on: `2026-03-01`,
          ends_on: `2026-05-31`,
          id: reef,
          name: 'Reef 2026',
          year: 2026
        })
        .execute()
      await db
        .insertInto('season_teams')
        .values({ season_id: reef, team_id: gulls })
        .execute()
      await db
        .insertInto('games')
        .values({
          id: makeId('game'),
          season_id: reef,
          home_team_id: gulls,
          away_team_id: rivals,
          start_at: new Date('2026-05-30T17:00:00Z'),
          status: 'final',
          home_score: 4,
          away_score: 1
        })
        .execute()
      const listed = await list(SEASON_ADMIN, `?season=${force}`)
      const gullsListed = (
        listed.body as Array<{ id: string; record: unknown }>
      ).find(team => team.id === gulls)
      expect(gullsListed?.record).equals(null)
      // Asked by Reef, as the site administrator, the record is there.
      const reefListed = (
        (await list(ADMIN, `?season=${reef}`)).body as Array<{
          id: string
          record: unknown
        }>
      ).find(team => team.id === gulls)
      expect(reefListed?.record).deep.equals({
        w: 1,
        l: 0,
        t: 0,
        seasonName: 'Reef 2026'
      })
    })

    it('refuses kind without season, a kind it does not know, and nobody at all', async function () {
      for (const query of ['?kind=external', '?kind=any']) {
        const refused = await list(ADMIN, query)
        expect(refused.status, query).equals(400)
        expect(refused.body, query).deep.include({
          message: 'kind needs season'
        })
      }
      const unknown = await list(ADMIN, `?season=${bay}&kind=opponents`)
      expect(unknown.status).equals(400)
      expect(unknown.body).deep.include({
        message: 'kind must be full, external or any'
      })
      const empty = await list(ADMIN, '?season=')
      expect(empty.status).equals(400)
      expect(empty.body).deep.include({
        message: 'season must be a non-empty string'
      })
      expect((await list(null, `?season=${bay}`)).status).equals(401)
    })
  })

  describe('POST /teams', function () {
    /** The administrators `scope_roles` gives of one team or season. */
    async function adminsOf(
      scopeType: 'season' | 'team',
      scopeId: string
    ): Promise<Array<{ user_id: string; granted_by: string | null }>> {
      return await database()
        .selectFrom('scope_roles')
        .select(['user_id', 'granted_by'])
        .where('scope_type', '=', scopeType)
        .where('scope_id', '=', scopeId)
        .where('role', '=', 'admin')
        .execute()
    }

    it('answers 401 to nobody', async function () {
      expect((await create(null, { name: 'Owls' })).status).equals(401)
    })

    it('lets a member make a standalone team, and makes them its administrator', async function () {
      const before = await counts()
      const made = await create(MEMBER, {
        name: 'Owls on their own',
        externalIds: [{ system: 'otherLeague', kind: 'team', id: 'ext-solo' }]
      })
      expect(made.status).equals(201)
      expect(made.body).deep.include({
        name: 'Owls on their own',
        created: true,
        season: null
      })
      expect(await counts()).deep.equals({
        teams: before.teams + 1,
        seasons: before.seasons
      })
      const seasons = await database()
        .selectFrom('season_teams')
        .select('season_id')
        .where('team_id', '=', made.body.id)
        .execute()
      expect(seasons).deep.equals([])
      expect(await adminsOf('team', made.body.id)).deep.equals([
        {
          user_id: userIdOfGumbo(member.userId),
          granted_by: userIdOfGumbo(member.userId)
        }
      ])
      // Its owner, so it is among their teams.
      const owners = await database()
        .selectFrom('memberships')
        .select(['user_id', 'role'])
        .where('team_id', '=', made.body.id)
        .execute()
      expect(owners).deep.equals([
        { user_id: userIdOfGumbo(member.userId), role: 'owner' }
      ])
      expect(ids(await list(MEMBER))).includes(made.body.id)

      // Theirs to post again.
      const again = await create(MEMBER, {
        name: 'Owls again',
        season: null,
        externalIds: [{ system: 'otherLeague', kind: 'team', id: 'ext-solo' }]
      })
      expect(again.status).equals(200)
      expect(again.body).deep.include({ id: made.body.id, created: false })
    })

    it('refuses to put a team in a season the caller does not administer', async function () {
      const before = await counts()
      for (const [token, season] of [
        [MEMBER, force],
        [LEAGUE_ADMIN, force],
        [SEASON_ADMIN, circuitSeason]
      ]) {
        const refused = await create(token, {
          name: 'Gatecrashers',
          season: { id: season }
        })
        expect(refused.status, `${token} ${season}`).equals(403)
        expect(refused.body).deep.equals({
          code: 'forbidden',
          message:
            'Only an administrator of the season or its league may add a team to it'
        })
      }
      expect(await counts()).deep.equals(before)
    })

    it('lets a season administrator and a league administrator put a team in their season', async function () {
      for (const [token, userId, season] of [
        [SEASON_ADMIN, seasonAdmin.userId, force],
        [LEAGUE_ADMIN, leagueAdmin.userId, circuitSeason]
      ] as const) {
        const seasonAdmins = await adminsOf('season', season)
        const made = await create(token, {
          name: `Kites of ${token}`,
          season: { id: season }
        })
        expect(made.status, token).equals(201)
        expect(made.body.season).deep.include({ id: season, created: false })
        const joined = await database()
          .selectFrom('season_teams')
          .select('season_id')
          .where('team_id', '=', made.body.id)
          .execute()
        expect(joined).deep.equals([{ season_id: season }])
        expect(await adminsOf('team', made.body.id)).deep.equals([
          { user_id: userIdOfGumbo(userId), granted_by: userIdOfGumbo(userId) }
        ])
        // Nothing is given on a season this call did not make.
        expect(await adminsOf('season', season), token).deep.equals(
          seasonAdmins
        )
      }
    })

    it('reuses a season by name only for a caller who administers it', async function () {
      const asked = { name: 'Titan Force 2026', year: 2026 }
      const mine = await create(MEMBER, { name: 'Jays', season: asked })
      expect(mine.status).equals(201)
      expect(mine.body.season).deep.include({
        name: 'Titan Force 2026',
        year: 2026,
        created: true
      })
      expect(mine.body.season.id).not.equals(force)
      const season = await database()
        .selectFrom('seasons')
        .select(['league_id'])
        .where('id', '=', mine.body.season.id)
        .executeTakeFirstOrThrow()
      expect(season.league_id).equals(null)
      expect(await adminsOf('season', mine.body.season.id)).deep.equals([
        {
          user_id: userIdOfGumbo(member.userId),
          granted_by: userIdOfGumbo(member.userId)
        }
      ])

      // The member's own season is theirs to reuse; the Force is its
      // administrator's.
      const again = await create(MEMBER, { name: 'Jays B', season: asked })
      expect(again.body.season).deep.include({
        id: mine.body.season.id,
        created: false
      })
      const theirs = await create(SEASON_ADMIN, {
        name: 'Jays C',
        season: asked
      })
      expect(theirs.body.season).deep.include({ id: force, created: false })
    })

    it('answers 409, and makes and records nothing, for an id on a team the caller cannot see', async function () {
      const before = await counts()
      const refused = await create(MEMBER, {
        name: 'Gulls',
        externalIds: [
          { system: 'otherLeague', kind: 'alias', id: 'nick-gulls' },
          { system: 'otherLeague', kind: 'team', id: 'ext-gulls' }
        ]
      })
      expect(refused.status).equals(409)
      expect(refused.body).deep.equals({
        code: 'conflict',
        message: 'That id is already on a team you cannot see'
      })
      expect(await counts()).deep.equals(before)
      const alias = await database()
        .selectFrom('external_ids')
        .select('id')
        .where('external_id', '=', 'nick-gulls')
        .execute()
      expect(alias).deep.equals([])

      // A team the member is on is answered as it is to anybody, but an
      // id nothing holds is not recorded on a team they do not administer.
      const seen = await create(MEMBER, {
        name: 'Hawks',
        externalIds: [
          { system: 'otherLeague', kind: 'team', id: 'ext-hawks' },
          { system: 'otherLeague', kind: 'alias', id: 'nick-hawks-2' }
        ]
      })
      expect(seen.status).equals(200)
      expect(seen.body).deep.include({ id: hawks, created: false })
      const unrecorded = await database()
        .selectFrom('external_ids')
        .select('id')
        .where('external_id', '=', 'nick-hawks-2')
        .execute()
      expect(unrecorded).deep.equals([])
    })

    it('refuses a malformed body, naming the field', async function () {
      const season = { id: force }
      const cases: Array<[unknown, string]> = [
        [[], 'The body must be an object'],
        [{ season }, 'name must be a string'],
        [{ name: '   ', season }, 'name must be 1-100 characters'],
        [{ name: 'x'.repeat(101), season }, 'name must be 1-100 characters'],
        [{ name: 'Owls', season: 'Spring' }, 'season must be an object'],
        [
          { name: 'Owls', season: {} },
          'season needs either id, or name and year'
        ],
        [
          { name: 'Owls', season: { id: force, name: 'Spring', year: 2026 } },
          'season needs either id, or name and year'
        ],
        [
          { name: 'Owls', season: { id: ' ' } },
          'season.id must be a non-empty string'
        ],
        [
          { name: 'Owls', season: { name: 'Spring' } },
          'season.year must be a whole year from 1900 to 2200'
        ],
        [
          { name: 'Owls', season: { name: 'Spring', year: 2026.5 } },
          'season.year must be a whole year from 1900 to 2200'
        ],
        [
          { name: 'Owls', season: { name: 'Spring', year: '2026' } },
          'season.year must be a whole year from 1900 to 2200'
        ],
        [
          { name: 'Owls', season: { name: '', year: 2026 } },
          'season.name must be 1-100 characters'
        ],
        [
          { name: 'Owls', season, externalIds: {} },
          'externalIds must be an array'
        ],
        [
          {
            name: 'Owls',
            season,
            externalIds: Array.from({ length: 21 }, (_, index) => ({
              system: 'otherLeague',
              kind: 'team',
              id: `id${index}`
            }))
          },
          'externalIds holds at most 20 ids'
        ],
        [
          { name: 'Owls', season, externalIds: ['ext-owls'] },
          'externalIds[0] must be an object'
        ],
        [
          {
            name: 'Owls',
            season,
            externalIds: [{ system: 'OtherLeague', kind: 'team', id: 'x' }]
          },
          'externalIds[0].system must match ^[a-z][a-zA-Z0-9]{0,31}$'
        ],
        [
          {
            name: 'Owls',
            season,
            externalIds: [
              { system: 'otherLeague', kind: 'team', id: 'x' },
              { system: 'otherLeague', kind: '', id: 'y' }
            ]
          },
          'externalIds[1].kind must be a non-empty string'
        ],
        [
          {
            name: 'Owls',
            season,
            externalIds: [{ system: 'otherLeague', kind: 'team', id: '' }]
          },
          'externalIds[0].id must be a non-empty string'
        ]
      ]
      const before = await counts()
      for (const [body, message] of cases) {
        const refused = await create(ADMIN, body)
        expect(refused.status, message).equals(400)
        expect(refused.body, message).deep.include({
          code: 'badRequest',
          message
        })
      }
      expect(await counts()).deep.equals(before)
    })

    it('makes a team in a new season by name and year, with its ids', async function () {
      const before = await counts()
      const made = await create(ADMIN, {
        name: '  Owls 12U  ',
        season: { name: ' Owls 2027 ', year: 2027 },
        externalIds: [
          { system: 'otherLeague', kind: 'team', id: 'ext-owls' },
          { system: 'otherLeague', kind: 'alias', id: 'nick-owls' }
        ]
      })
      expect(made.status).equals(201)
      expect(made.body).deep.include({ name: 'Owls 12U', created: true })
      expect(made.body.season).deep.include({
        name: 'Owls 2027',
        year: 2027,
        created: true
      })
      expect(await counts()).deep.equals({
        teams: before.teams + 1,
        seasons: before.seasons + 1
      })

      const team = await database()
        .selectFrom('teams')
        .selectAll()
        .where('id', '=', made.body.id)
        .executeTakeFirstOrThrow()
      expect(team).deep.include({
        name: 'Owls 12U',
        kind: 'full',
        created_from: 'api',
        merged_into: null
      })
      const season = await database()
        .selectFrom('seasons')
        .selectAll()
        .where('id', '=', made.body.season.id)
        .executeTakeFirstOrThrow()
      expect(season).deep.include({
        league_id: null,
        name: 'Owls 2027',
        year: 2027,
        spectator_access: 'team'
      })
      const joined = await database()
        .selectFrom('season_teams')
        .select(['season_id'])
        .where('team_id', '=', made.body.id)
        .execute()
      expect(joined).deep.equals([{ season_id: made.body.season.id }])
      // A site administrator administers it, and belongs to no team.
      expect(await adminsOf('team', made.body.id)).deep.equals([
        {
          user_id: userIdOfGumbo(admin.userId),
          granted_by: userIdOfGumbo(admin.userId)
        }
      ])
      const members = await database()
        .selectFrom('memberships')
        .select('id')
        .where('team_id', '=', made.body.id)
        .execute()
      expect(members).deep.equals([])
      const held = await database()
        .selectFrom('external_ids')
        .select(['entity_type', 'system', 'kind', 'external_id'])
        .where('entity_id', '=', made.body.id)
        .orderBy('external_id')
        .execute()
      expect(held).deep.equals([
        {
          entity_type: 'team',
          system: 'otherLeague',
          kind: 'team',
          external_id: 'ext-owls'
        },
        {
          entity_type: 'team',
          system: 'otherLeague',
          kind: 'alias',
          external_id: 'nick-owls'
        }
      ])

      // Found the way the app looks first.
      const found = await list(ADMIN, '?externalId=ext-owls')
      expect(found.body).deep.equals([
        {
          id: made.body.id,
          name: 'Owls 12U',
          shortName: null,
          logoPath: null,
          logoUrl: null,
          record: null,
          externalIds: ['ext-owls', 'nick-owls'],
          kind: 'full'
        }
      ])

      // The audit row is written after the answer, so wait for it.
      let audit
      for (let tries = 0; tries < 50 && audit == null; tries++) {
        audit = await database()
          .selectFrom('audit_log')
          .selectAll()
          .where('entity_id', '=', made.body.id)
          .executeTakeFirst()
        if (audit == null) await new Promise(resolve => setTimeout(resolve, 20))
      }
      expect(audit).deep.include({
        actor_user_id: userIdOfGumbo(admin.userId),
        method: 'POST',
        path: '/api/v1/teams',
        entity_type: 'team'
      })
      expect(audit?.after).deep.include({
        name: 'Owls 12U',
        seasonId: made.body.season.id,
        seasonCreated: true
      })
    })

    it('answers the same team, and makes nothing, when an id is posted again', async function () {
      const first = await create(ADMIN, {
        name: 'Crows',
        season: { name: 'Crows 2026', year: 2026 },
        externalIds: [{ system: 'otherLeague', kind: 'team', id: 'ext-crows' }]
      })
      expect(first.status).equals(201)
      const before = await counts()

      const again = await create(ADMIN, {
        name: 'Crows, renamed',
        season: { name: 'Another season', year: 2026 },
        externalIds: [
          { system: 'otherLeague', kind: 'alias', id: 'nick-crows' },
          { system: 'otherLeague', kind: 'team', id: 'ext-crows' }
        ]
      })
      expect(again.status).equals(200)
      expect(again.body).deep.equals({
        id: first.body.id,
        name: 'Crows',
        created: false,
        season: null
      })
      expect(await counts()).deep.equals(before)
      // The id nothing held is the team's now, not dropped.
      const pub = await database()
        .selectFrom('external_ids')
        .select(['entity_type', 'entity_id', 'system', 'kind'])
        .where('external_id', '=', 'nick-crows')
        .execute()
      expect(pub).deep.equals([
        {
          entity_type: 'team',
          entity_id: first.body.id,
          system: 'otherLeague',
          kind: 'alias'
        }
      ])
    })

    it('answers an existing team that was not made here, following a merge', async function () {
      const before = await counts()
      const held = await create(ADMIN, {
        name: 'Hawks again',
        season: { id: force },
        externalIds: [{ system: 'otherLeague', kind: 'team', id: 'ext-hawks' }]
      })
      expect(held.status).equals(200)
      expect(held.body).deep.equals({
        id: hawks,
        name: 'Hawks',
        created: false,
        season: null
      })
      const merged = await create(ADMIN, {
        name: 'Old Hawks',
        season: { id: force },
        externalIds: [
          { system: 'otherLeague', kind: 'team', id: 'ext-old-hawks' }
        ]
      })
      expect(merged.status).equals(200)
      expect(merged.body).deep.include({ id: hawks, created: false })
      expect(await counts()).deep.equals(before)
    })

    it('reuses a season of the same name and year, ignoring case and spaces', async function () {
      const before = await counts()
      const made = await create(ADMIN, {
        name: 'Titan Force 13U',
        season: { name: '  Titan Force 2026 ', year: 2026 },
        externalIds: [{ system: 'otherLeague', kind: 'team', id: 'ext-force' }]
      })
      expect(made.status).equals(201)
      expect(made.body.season).deep.equals({
        id: force,
        name: 'Titan Force 2026',
        year: 2026,
        created: false
      })
      expect(await counts()).deep.equals({
        teams: before.teams + 1,
        seasons: before.seasons
      })

      // The same name in another year is another season.
      const later = await create(ADMIN, {
        name: 'Titan Force 14U',
        season: { name: 'Titan Force 2026', year: 2027 }
      })
      expect(later.status).equals(201)
      expect(later.body.season.id).not.equals(force)
      expect(later.body.season.created).equals(true)
    })

    it('puts a team in a season named by id, and 404s for one that is not there', async function () {
      const before = await counts()
      const made = await create(ADMIN, {
        name: 'Larks',
        season: { id: force }
      })
      expect(made.status).equals(201)
      expect(made.body).deep.include({ name: 'Larks', created: true })
      expect(made.body.season).deep.equals({
        id: force,
        name: 'Titan Force 2026',
        year: 2026,
        created: false
      })
      const joined = await database()
        .selectFrom('season_teams')
        .select('season_id')
        .where('team_id', '=', made.body.id)
        .execute()
      expect(joined).deep.equals([{ season_id: force }])

      const missing = await create(ADMIN, {
        name: 'Wrens',
        season: { id: 'sea_nothere' },
        externalIds: [{ system: 'otherLeague', kind: 'team', id: 'ext-wrens' }]
      })
      expect(missing.status).equals(404)
      expect(missing.body).deep.include({
        code: 'notFound',
        message: 'No season sea_nothere'
      })
      expect(await counts()).deep.equals({
        teams: before.teams + 1,
        seasons: before.seasons
      })
      // Rolled back: the id was not kept for a team that was never made.
      expect((await list(ADMIN, '?externalId=ext-wrens')).body).deep.equals([])
    })

    it('stops following merges that go round in a circle', async function () {
      const loopA = makeId('team')
      const loopB = makeId('team')
      await database()
        .insertInto('teams')
        .values([
          { id: loopA, name: 'Loop A' },
          { id: loopB, name: 'Loop B', merged_into: loopA }
        ])
        .execute()
      await database()
        .updateTable('teams')
        .set({ merged_into: loopB })
        .where('id', '=', loopA)
        .execute()
      await database()
        .insertInto('external_ids')
        .values({
          id: makeId('externalId'),
          entity_type: 'team',
          entity_id: loopA,
          system: 'otherLeague',
          kind: 'team',
          external_id: 'ext-loop'
        })
        .execute()
      const held = await create(ADMIN, {
        name: 'Loop',
        season: { id: force },
        externalIds: [{ system: 'otherLeague', kind: 'team', id: 'ext-loop' }]
      })
      expect(held.status).equals(200)
      expect(held.body).deep.include({ id: loopA, created: false })
    })

    it('gives a new team an id left behind by a team that is gone', async function () {
      const orphan = makeId('externalId')
      await database()
        .insertInto('external_ids')
        .values({
          id: orphan,
          entity_type: 'team',
          entity_id: 'tem_gone',
          system: 'otherLeague',
          kind: 'team',
          external_id: 'ext-gone'
        })
        .execute()
      const made = await create(ADMIN, {
        name: 'Phoenix',
        season: { id: force },
        externalIds: [{ system: 'otherLeague', kind: 'team', id: 'ext-gone' }]
      })
      expect(made.status).equals(201)
      const row = await database()
        .selectFrom('external_ids')
        .select(['entity_id'])
        .where('id', '=', orphan)
        .executeTakeFirstOrThrow()
      expect(row.entity_id).equals(made.body.id)
      expect(ids(await list(ADMIN, '?externalId=ext-gone'))).deep.equals([
        made.body.id
      ])
    })

    it('refuses an id that is already on something other than a team', async function () {
      const before = await counts()
      const refused = await create(ADMIN, {
        name: 'Games',
        season: { id: force },
        externalIds: [{ system: 'otherLeague', kind: 'event', id: 'ext-game' }]
      })
      expect(refused.status).equals(409)
      expect(refused.body).deep.include({
        code: 'conflict',
        message: 'otherLeague event ext-game is already on a game'
      })
      // Even after an id that names a team, whose other ids it would record.
      const after = await create(ADMIN, {
        name: 'Hawks',
        season: { id: force },
        externalIds: [
          { system: 'otherLeague', kind: 'team', id: 'ext-hawks' },
          { system: 'otherLeague', kind: 'event', id: 'ext-game' }
        ]
      })
      expect(after.status).equals(409)
      expect(await counts()).deep.equals(before)
    })

    it('answers a member’s second post of a new id with the team the first made', async function () {
      const body = {
        name: 'Racing owls',
        externalIds: [{ system: 'otherLeague', kind: 'team', id: 'ext-race' }]
      }
      const answers = await Promise.all([
        create(MEMBER, body),
        create(MEMBER, body)
      ])
      expect(
        answers.map(answer => answer.status).sort((a, b) => a - b)
      ).deep.equals([200, 201])
      expect(new Set(answers.map(answer => answer.body.id)).size).equals(1)
    })

    it('makes one season when a member posts two teams in the same new season at once', async function () {
      const before = await counts()
      const season = { name: 'Racing 2031', year: 2031 }
      const answers = await Promise.all([
        create(MEMBER, { name: 'Racers A', season }),
        create(MEMBER, { name: 'Racers B', season })
      ])
      expect(answers.map(answer => answer.status)).deep.equals([201, 201])
      expect(new Set(answers.map(answer => answer.body.season.id)).size).equals(
        1
      )
      expect(
        answers.map(answer => answer.body.season.created as boolean)
      ).to.have.members([false, true])
      expect(await counts()).deep.equals({
        teams: before.teams + 2,
        seasons: before.seasons + 1
      })
    })

    it('makes one team when the same new id is posted twice at once', async function () {
      const before = await counts()
      const body = {
        name: 'Swifts',
        season: { name: 'Swifts 2026', year: 2026 },
        externalIds: [{ system: 'otherLeague', kind: 'team', id: 'ext-swifts' }]
      }
      const answers = await Promise.all([
        create(ADMIN, body),
        create(ADMIN, body),
        create(ADMIN, body)
      ])
      expect(
        answers.map(answer => answer.status).sort((a, b) => a - b)
      ).deep.equals([200, 200, 201])
      expect(new Set(answers.map(answer => answer.body.id)).size).equals(1)
      expect(await counts()).deep.equals({
        teams: before.teams + 1,
        seasons: before.seasons + 1
      })
    })
  })
})

/**
 * A guardian is a member of every team their child plays on now: `GET /teams`
 * lists them, and stops listing one the child leaves. On `guardianFixture`,
 * where Alfonso plays for Demo Hawks and Demo Comets and Tim Raines is his
 * guardian with no membership of his own.
 */
describe('GET /teams for a guardian', function () {
  this.timeout(120000)

  let f: GuardianFixture

  before(async function () {
    f = await guardianFixture()
  })

  after(async function () {
    await f?.h.close()
  })

  const teamsOf = async (userId: number): Promise<string[]> => {
    const answer = await f.h.request('GET', '/teams', undefined, userId)
    expect(answer.status).equals(200)
    return ((await answer.json()) as Array<{ id: string }>)
      .map(team => team.id)
      .sort()
  }

  it('lists the child’s teams, and drops one the child leaves', async function () {
    expect(await teamsOf(f.people.guardian)).deep.equals(
      [f.teamA, f.secondTeam].sort()
    )
    // Nobody else's list changes: a follower and the coach of the Hawks.
    expect(await teamsOf(f.people.follower)).deep.equals([])
    expect(await teamsOf(f.people.teamCoach)).deep.equals([f.teamA])
    await f.h.db
      .deleteFrom('memberships')
      .where('user_id', '=', userIdOfGumbo(f.players[0].id))
      .where('team_id', '=', f.secondTeam)
      .execute()
    expect(await teamsOf(f.people.guardian)).deep.equals([f.teamA])
  })
})
