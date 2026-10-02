import type { AddressInfo } from 'node:net'

import { expect } from 'chai'
import express from 'express'
import type { Insertable, Kysely } from 'kysely'
import { after, before, describe, it } from 'mocha'
import { Pool } from 'pg'

import { makeId } from '../../common/ids'
import { mintUserId } from '../../common/mintUserId'
import { migrations } from '../../migrate/migrations'
import { migrateUp } from '../../migrate/runner'
import { testDatabaseUrl } from '../../migrate/testDatabase'
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

const admin = mintUserId(() => false)
const member = mintUserId(id => id === admin.userId)

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
    await db
      .insertInto('users')
      .values(
        [
          { made: admin, name: 'Ada', isAdmin: true },
          { made: member, name: 'Cam', isAdmin: false }
        ].map(person => ({
          id: person.made.userId,
          legacyId: person.made.legacyId,
          display_name: person.name,
          is_admin: person.isAdmin,
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
            [ADMIN, admin.userId],
            [MEMBER, member.userId]
          ] as Array<[string, number]>
        ).map(([token, userId]) => ({
          id: makeId('authSession'),
          user_id: userId,
          token_hash: hashToken(token),
          created_at: now,
          expires_at: new Date(now.getTime() + 3_600_000)
        }))
      )
      .execute()
    await db
      .insertInto('seasons')
      .values({ id: force, name: 'Titan Force 2026', year: 2026 })
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
        user_id: member.userId,
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
    app.use(jsonBody)
    app.use(withActor(db))
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
          externalIds: ['ext-hawks', 'nick-hawks']
        }
      ])
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

  describe('POST /teams', function () {
    it('answers 401 to nobody and 403 to anybody but a site administrator', async function () {
      const body = { name: 'Owls', season: { id: force } }
      expect((await create(null, body)).status).equals(401)
      const refused = await create(MEMBER, body)
      expect(refused.status).equals(403)
      expect(refused.body).deep.include({
        code: 'forbidden',
        message: 'Only a site administrator may create a team'
      })
    })

    it('refuses a malformed body, naming the field', async function () {
      const season = { id: force }
      const cases: Array<[unknown, string]> = [
        [[], 'The body must be an object'],
        [{ season }, 'name must be a string'],
        [{ name: '   ', season }, 'name must be 1-100 characters'],
        [{ name: 'x'.repeat(101), season }, 'name must be 1-100 characters'],
        [{ name: 'Owls' }, 'season must be an object'],
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
          externalIds: ['ext-owls', 'nick-owls']
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
        actor_user_id: admin.userId,
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
