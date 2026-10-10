import type { AddressInfo } from 'node:net'

import { expect } from 'chai'
import express from 'express'
import type { Kysely } from 'kysely'
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
import { withActor } from '../middleware/withAuth'
import { errorHandler } from '../middleware/withErrors'
import { seasonRoutes } from './seasons'

/**
 * `GET /seasons`: the seasons a caller may see, with what is in each, and
 * the seasons some teams play in (`?team=`).
 */

const adminUrl = testDatabaseUrl
const scratchName = `teamstation_seasons_route_${Date.now()}`
const scratchUrl = adminUrl.replace(/\/[^/]*$/, `/${scratchName}`)

const ADMIN = 'tok_seasons_admin_000000000000000000'
const MEMBER = 'tok_seasons_member_00000000000000000'
const SEASON_ADMIN = 'tok_seasons_seasonadmin_000000000000'
const TEAM_ADMIN = 'tok_seasons_teamadmin_00000000000000'
const OUTSIDER = 'tok_seasons_outsider_000000000000000'

const people = (() => {
  const made: Array<ReturnType<typeof mintUserId>> = []
  const next = (): ReturnType<typeof mintUserId> => {
    const one = mintUserId(id => made.some(other => other.userId === id))
    made.push(one)
    return one
  }
  return {
    admin: next(),
    member: next(),
    seasonAdmin: next(),
    teamAdmin: next(),
    outsider: next()
  }
})()

interface Answer {
  status: number
  body: any
}

describe('GET /seasons', function () {
  this.timeout(60000)

  let adminPool: Pool | undefined
  let db: Kysely<Database> | undefined
  let server: ReturnType<express.Express['listen']> | undefined
  let base = ''
  // Harbor League is opened to its teams' members; Bayside is not; Inland
  // has nobody this test signs in as.
  const harbor = makeId('season')
  const bayside = makeId('season')
  const inland = makeId('season')
  const herons = makeId('team')
  const sealions = makeId('team')
  const bobcats = makeId('team')
  const coyotes = makeId('team')
  const gulls = makeId('team')

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
        (
          [
            [people.admin, 'Ty Cobb', true],
            [people.member, 'Mel Ott', false],
            [people.seasonAdmin, 'Cy Young', false],
            [people.teamAdmin, 'Al Kaline', false],
            [people.outsider, 'Rod Carew', false]
          ] as const
        ).map(([made, name, isAdmin]) => ({
          id: made.userId,
          legacyId: made.legacyId,
          display_name: name,
          is_admin: isAdmin,
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
            [ADMIN, people.admin],
            [MEMBER, people.member],
            [SEASON_ADMIN, people.seasonAdmin],
            [TEAM_ADMIN, people.teamAdmin],
            [OUTSIDER, people.outsider]
          ] as const
        ).map(([token, made]) => ({
          id: makeId('authSession'),
          user_id: made.userId,
          token_hash: hashToken(token),
          created_at: now,
          expires_at: new Date(now.getTime() + 3_600_000)
        }))
      )
      .execute()
    await db
      .insertInto('seasons')
      .values([
        {
          id: harbor,
          name: 'Harbor League 2026',
          year: 2026,
          term: 'spring',
          age_group: '12U',
          starts_on: '2026-03-01',
          ends_on: '2026-06-30',
          spectator_access: 'season'
        },
        { id: bayside, name: 'Bayside League 2026', year: 2026 },
        { id: inland, name: 'Inland League 2025', year: 2025 }
      ])
      .execute()
    await db
      .insertInto('teams')
      .values([
        { id: herons, name: 'Harbor Herons' },
        { id: sealions, name: 'Sea Lions' },
        { id: bobcats, name: 'Bayside Bobcats' },
        { id: coyotes, name: 'Inland Coyotes' },
        { id: gulls, name: 'Gulls', kind: 'external' }
      ])
      .execute()
    await db
      .insertInto('season_teams')
      .values([
        { season_id: harbor, team_id: herons },
        { season_id: harbor, team_id: sealions },
        { season_id: bayside, team_id: herons },
        { season_id: bayside, team_id: bobcats },
        { season_id: inland, team_id: coyotes }
      ])
      .execute()
    await db
      .insertInto('games')
      .values([
        {
          id: makeId('game'),
          season_id: harbor,
          home_team_id: herons,
          away_team_id: sealions,
          start_at: new Date('2026-05-02T17:00:00Z')
        },
        {
          id: makeId('game'),
          season_id: harbor,
          home_team_id: herons,
          away_team_id: gulls,
          start_at: new Date('2026-05-09T17:00:00Z')
        },
        {
          id: makeId('game'),
          season_id: bayside,
          home_team_id: bobcats,
          away_team_id: herons,
          start_at: new Date('2026-06-06T17:00:00Z')
        }
      ])
      .execute()
    await db
      .insertInto('memberships')
      .values({
        id: makeId('membership'),
        user_id: people.member.userId,
        team_id: herons
      })
      .execute()
    await db
      .insertInto('season_members')
      .values({
        id: makeId('seasonMember'),
        season_id: harbor,
        user_id: people.member.userId
      })
      .execute()
    // An administrator of Bayside, and one of Inland Coyotes, neither of
    // whom belongs to anything.
    await db
      .insertInto('scope_roles')
      .values([
        {
          id: makeId('scopeRole'),
          user_id: people.seasonAdmin.userId,
          scope_type: 'season',
          scope_id: bayside,
          role: 'admin',
          granted_at: now
        },
        {
          id: makeId('scopeRole'),
          user_id: people.teamAdmin.userId,
          scope_type: 'team',
          scope_id: coyotes,
          role: 'admin',
          granted_at: now
        }
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
    app.use('/api/v1', seasonRoutes(db, media))
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
    const response = await fetch(`${base}/seasons${query}`, {
      headers: token == null ? {} : { authorization: `Bearer ${token}` }
    })
    return {
      status: response.status,
      body: await response.json().catch(() => null)
    }
  }

  const names = (answer: Answer): string[] =>
    (answer.body as Array<{ name: string }>).map(season => season.name)

  const harborItem = (): Record<string, unknown> => ({
    id: harbor,
    leagueId: null,
    name: 'Harbor League 2026',
    year: 2026,
    term: 'spring',
    ageGroup: '12U',
    startsOn: '2026-03-01',
    endsOn: '2026-06-30',
    logoUrl: null,
    teams: 3,
    games: 2,
    videos: 0
  })

  it('lists the seasons a caller may see, with what is in each', async function () {
    const member = await list(MEMBER)
    expect(member.status).equals(200)
    expect(member.body).deep.equals([harborItem()])

    const admin = await list(ADMIN)
    expect(admin.status).equals(200)
    expect(admin.body).deep.equals(
      [
        harborItem(),
        {
          id: bayside,
          leagueId: null,
          name: 'Bayside League 2026',
          year: 2026,
          term: null,
          ageGroup: null,
          startsOn: null,
          endsOn: null,
          logoUrl: null,
          teams: 2,
          games: 1,
          videos: 0
        },
        {
          id: inland,
          leagueId: null,
          name: 'Inland League 2025',
          year: 2025,
          term: null,
          ageGroup: null,
          startsOn: null,
          endsOn: null,
          logoUrl: null,
          teams: 1,
          games: 0,
          videos: 0
        }
      ].sort((a, b) => {
        const dateA = typeof a.startsOn === 'string' ? a.startsOn : ''
        const dateB = typeof b.startsOn === 'string' ? b.startsOn : ''
        const dateOrder = dateB.localeCompare(dateA)
        return dateOrder !== 0
          ? dateOrder
          : String(a.id).localeCompare(String(b.id))
      })
    )

    // True season roles grant its own scope; team roles never widen upwards.
    expect(names(await list(SEASON_ADMIN))).deep.equals(['Bayside League 2026'])
    expect((await list(TEAM_ADMIN)).body).deep.equals([])
    expect((await list(OUTSIDER)).body).deep.equals([])
    expect((await list(null)).status).equals(401)
  })

  it('narrows to the seasons the teams asked for play in', async function () {
    // Either team's seasons, once each, in the same shape and order.
    expect(
      (await list(ADMIN, `?team=${sealions}&team=${bobcats}`)).body
    ).deep.equals(
      (await list(ADMIN)).body.filter(
        (season: { id: string }) => season.id !== inland
      )
    )
    expect(names(await list(ADMIN, `?team=${herons}`))).deep.equals([
      'Harbor League 2026',
      'Bayside League 2026'
    ])
    // An external team plays in no season of its own.
    expect(names(await list(ADMIN, `?team=${gulls}`))).deep.equals([])
    expect(names(await list(ADMIN, '?team=tem_nobody'))).deep.equals([])
  })

  it('counts a season the caller may schedule in as one they may see, asked by team', async function () {
    // The member sees the season opened to them, and not Bayside, which
    // their team plays in too.
    expect((await list(MEMBER, `?team=${herons}`)).body).deep.equals([
      harborItem()
    ])
    // A season's administrator, and a team's, see the seasons they
    // schedule in, and only when asked by team.
    expect(names(await list(SEASON_ADMIN, `?team=${herons}`))).deep.equals([
      'Bayside League 2026'
    ])
    expect(names(await list(TEAM_ADMIN, `?team=${coyotes}`))).deep.equals([
      'Inland League 2025'
    ])
    expect(names(await list(TEAM_ADMIN, `?team=${herons}`))).deep.equals([])
    expect(names(await list(OUTSIDER, `?team=${herons}`))).deep.equals([])
  })

  it('refuses a team with no usable value, and nobody at all', async function () {
    for (const query of ['?team=', `?team=${herons}&team=`]) {
      const refused = await list(ADMIN, query)
      expect(refused.status, query).equals(400)
      expect(refused.body, query).deep.include({
        message: 'team must be a non-empty string'
      })
    }
    expect((await list(null, `?team=${herons}`)).status).equals(401)
  })
})
