import type { AddressInfo } from 'node:net'

import { expect } from 'chai'
import express from 'express'
import type { Kysely } from 'kysely'
import { after, before, describe, it } from 'mocha'
import { Pool } from 'pg'

import { makeId } from '../../common/ids'
import { mintUserId } from '../../common/mintUserId'
import { asTeamPlayersBody } from '../../common/teamMembers'
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
import { mintFreeUserId } from '../teams/addPlayers'
import { teamMemberRoutes } from './teamMembers'
import { teamRoutes } from './teams'
import { userRoutes } from './users'

/**
 * Adding a team's people by the ids another system has for them:
 * `POST /teams/:teamId/players`.
 */

const adminUrl = testDatabaseUrl
const scratchName = `teamstation_team_members_${Date.now()}`
const scratchUrl = adminUrl.replace(/\/[^/]*$/, `/${scratchName}`)

const ADMIN = 'tok_members_admin_000000000000000000'
const TEAM_ADMIN = 'tok_members_teamadmin_00000000000000'
const MEMBER = 'tok_members_member_00000000000000000'
const SEASON_ADMIN = 'tok_members_seasonadmin_000000000000'
const LEAGUE_ADMIN = 'tok_members_leagueadmin_000000000000'
const STRANGER = 'tok_members_stranger_000000000000000'

interface Answer {
  status: number
  body: any
}

/** A neutral external id, as any client of these routes might send. */
const ext = (
  id: string,
  kind = 'player'
): { system: string; kind: string; id: string } => ({
  system: 'otherLeague',
  kind,
  id
})

describe('a team’s people by external id', function () {
  this.timeout(60000)

  let adminPool: Pool | undefined
  let db: Kysely<Database> | undefined
  let server: ReturnType<express.Express['listen']> | undefined
  let base = ''
  const season = makeId('season')
  const league = makeId('league')
  const hawks = makeId('team')
  const gulls = makeId('team')
  const game = makeId('game')
  const taken = new Set<number>()
  const person = (): { legacyId: string; userId: number } => {
    const made = mintUserId(id => taken.has(id))
    taken.add(made.userId)
    return made
  }
  const admin = person()
  const teamAdmin = person()
  const seasonAdmin = person()
  const leagueAdmin = person()
  const member = person()
  const stranger = person()

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
          { made: teamAdmin, name: 'Tess', isAdmin: false },
          { made: seasonAdmin, name: 'Sam', isAdmin: false },
          { made: leagueAdmin, name: 'Lee', isAdmin: false },
          { made: member, name: 'Cam', isAdmin: false },
          { made: stranger, name: 'Sol', isAdmin: false }
        ].map(one => ({
          id: one.made.userId,
          legacyId: one.made.legacyId,
          display_name: one.name,
          is_admin: one.isAdmin,
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
            [TEAM_ADMIN, teamAdmin.userId],
            [SEASON_ADMIN, seasonAdmin.userId],
            [LEAGUE_ADMIN, leagueAdmin.userId],
            [MEMBER, member.userId],
            [STRANGER, stranger.userId]
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
      .insertInto('leagues')
      .values({ id: league, name: 'Spring league' })
      .execute()
    await db
      .insertInto('seasons')
      .values({
        id: season,
        name: 'Spring 2026',
        year: 2026,
        league_id: league
      })
      .execute()
    await db
      .insertInto('teams')
      .values([
        { id: hawks, name: 'Hawks' },
        { id: gulls, name: 'Gulls' }
      ])
      .execute()
    await db
      .insertInto('season_teams')
      .values([
        { season_id: season, team_id: hawks },
        { season_id: season, team_id: gulls }
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
    // An administrator of the Hawks, of the season every team here is in,
    // and of the league above it. None is a site administrator.
    await db
      .insertInto('scope_roles')
      .values(
        (
          [
            [teamAdmin, 'team', hawks],
            [seasonAdmin, 'season', season],
            [leagueAdmin, 'league', league]
          ] as const
        ).map(([made, scopeType, scopeId]) => ({
          id: makeId('scopeRole'),
          user_id: made.userId,
          scope_type: scopeType,
          scope_id: scopeId,
          role: 'admin' as const,
          granted_at: now
        }))
      )
      .execute()
    await db
      .insertInto('games')
      .values({
        id: game,
        season_id: season,
        home_team_id: hawks,
        away_team_id: gulls,
        start_at: new Date('2026-05-02T17:00:00Z')
      })
      .execute()
    await db
      .insertInto('external_ids')
      .values({
        id: makeId('externalId'),
        entity_type: 'game',
        entity_id: game,
        system: 'otherLeague',
        kind: 'player',
        external_id: 'held-by-a-game',
        created_at: now
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
    app.use('/api/v1', userRoutes(db))
    app.use('/api/v1', teamMemberRoutes(db))
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

  async function ask(
    method: string,
    path: string,
    token: string | null,
    body?: unknown
  ): Promise<Answer> {
    const response = await fetch(`${base}${path}`, {
      method,
      headers: {
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
        ...(token == null ? {} : { authorization: `Bearer ${token}` })
      },
      body: body === undefined ? undefined : JSON.stringify(body)
    })
    return {
      status: response.status,
      body: await response.json().catch(() => null)
    }
  }

  /** A team of its own, so one case's people never meet another's. */
  async function newTeam(name: string): Promise<string> {
    const id = makeId('team')
    await database().insertInto('teams').values({ id, name }).execute()
    await database()
      .insertInto('season_teams')
      .values({ season_id: season, team_id: id })
      .execute()
    return id
  }

  /** A user already here, holding one external id. */
  async function existingUser(
    externalId: string | null,
    values: Partial<{
      displayName: string
      mergedInto: number
      bats: 'left' | 'right' | 'switch' | null
      batsSource: 'import' | 'manual' | null
      loginEnabled: boolean
    }> = {},
    kind = 'player'
  ): Promise<number> {
    const made = person()
    const now = new Date()
    await database()
      .insertInto('users')
      .values({
        id: made.userId,
        legacyId: made.legacyId,
        display_name: values.displayName ?? 'Someone',
        merged_into: values.mergedInto ?? null,
        bats: values.bats ?? null,
        bats_source: values.batsSource ?? null,
        login_enabled: values.loginEnabled ?? false,
        created_at: now,
        updated_at: now
      })
      .execute()
    if (externalId != null) {
      await database()
        .insertInto('external_ids')
        .values({
          id: makeId('externalId'),
          entity_type: 'user',
          entity_id: String(made.userId),
          system: 'otherLeague',
          kind,
          external_id: externalId,
          created_at: now
        })
        .execute()
    }
    return made.userId
  }

  /**
   * Runs `request` while another connection, taking no advisory lock, holds
   * an uncommitted row for the external id, and commits that row once the
   * request is waiting on it: the request read the id as free, and then
   * finds it taken.
   */
  async function whileHeldElsewhere(
    externalId: string,
    request: () => Promise<Answer>,
    kind = 'player'
  ): Promise<Answer> {
    const racer = new Pool({ connectionString: scratchUrl })
    const client = await racer.connect()
    try {
      await client.query('begin')
      await client.query(
        `insert into external_ids (id, entity_type, entity_id, system, kind, external_id)
         values ($1, 'game', $2, 'otherLeague', $3, $4)`,
        [makeId('externalId'), game, kind, externalId]
      )
      const pending = request()
      for (let tries = 0; tries < 250; tries += 1) {
        const waiting = await racer.query<{ n: string }>(
          `select count(*) as n from pg_stat_activity
           where datname = current_database() and wait_event_type = 'Lock'`
        )
        if (Number(waiting.rows[0]?.n) > 0) break
        await new Promise(resolve => setTimeout(resolve, 20))
      }
      await client.query('commit')
      return await pending
    } finally {
      client.release()
      await racer.end()
    }
  }

  async function count(
    table: 'users' | 'memberships' | 'external_ids'
  ): Promise<number> {
    const row = await database()
      .selectFrom(table)
      .select(eb => eb.fn.countAll<string>().as('n'))
      .executeTakeFirstOrThrow()
    return Number(row.n)
  }

  const membershipOf = async (
    teamId: string,
    userId: number
  ): Promise<
    | {
        is_player: boolean
        is_spectator: boolean
        jersey: string | null
        role: string
      }
    | undefined
  > =>
    await database()
      .selectFrom('memberships')
      .select(['is_player', 'is_spectator', 'jersey', 'role'])
      .where('team_id', '=', teamId)
      .where('user_id', '=', userId)
      .executeTakeFirst()

  describe('the players body', function () {
    const row = { firstName: 'Ann', lastName: 'Lee', externalId: ext('x') }
    const refusals: Array<[unknown, string]> = [
      [null, 'The body must be { players: [...] }'],
      [{ players: 'many' }, 'players must be an array'],
      [{ players: [] }, 'players must hold at least one player'],
      [
        { players: new Array(201).fill(row) },
        'players holds at most 200 players per call'
      ],
      [{ players: ['Ann'] }, 'players[0] must be an object'],
      [
        { players: [{ ...row, firstName: 7 }] },
        'players[0].firstName must be a string'
      ],
      [
        { players: [row, { ...row, lastName: 'x'.repeat(101) }] },
        'players[1].lastName must be at most 100 characters'
      ],
      [
        { players: [{ ...row, jersey: '1234' }] },
        'players[0].jersey must be at most 3 characters'
      ],
      [
        { players: [{ ...row, jersey: 12 }] },
        'players[0].jersey must be a string'
      ],
      [
        { players: [{ ...row, bats: 'both' }] },
        'players[0].bats must be left, right or switch'
      ],
      [
        { players: [{ ...row, throws: 'switch' }] },
        'players[0].throws must be left or right'
      ],
      [
        { players: [{ ...row, externalId: 'x' }] },
        'players[0].externalId must be an object'
      ],
      [
        { players: [{ ...row, externalId: { ...ext('x'), system: 'Other' } }] },
        'players[0].externalId.system must match ^[a-z][a-zA-Z0-9]{0,31}$'
      ],
      [
        { players: [{ ...row, externalId: { ...ext('x'), kind: '' } }] },
        'players[0].externalId.kind must be a non-empty string'
      ],
      [
        { players: [{ ...row, externalId: { ...ext('x'), id: '' } }] },
        'players[0].externalId.id must be a non-empty string'
      ]
    ]
    for (const [body, message] of refusals) {
      it(`refuses with “${message}”`, function () {
        expect(() => asTeamPlayersBody(body)).throws(TypeError, message)
      })
    }

    it('trims, and reads a missing or blank field as none', function () {
      expect(
        asTeamPlayersBody({
          players: [
            {
              firstName: '  Ann ',
              jersey: ' ',
              bats: null,
              externalId: ext('x')
            }
          ]
        })
      ).deep.equals({
        players: [
          {
            firstName: 'Ann',
            lastName: '',
            jersey: null,
            bats: null,
            throws: null,
            externalId: ext('x')
          }
        ]
      })
    })
  })

  describe('POST /teams/:teamId/players', function () {
    const one = (id: string): unknown => ({
      players: [{ firstName: 'Ann', lastName: 'Lee', externalId: ext(id) }]
    })

    it('answers 401 without a session', async function () {
      expect(
        (await ask('POST', `/teams/${hawks}/players`, null, one('a'))).status
      ).equals(401)
    })

    it('answers 403 to a member who does not administer the team', async function () {
      const answer = await ask(
        'POST',
        `/teams/${hawks}/players`,
        MEMBER,
        one('a')
      )
      expect(answer.status).equals(403)
      expect(answer.body.code).equals('forbidden')
    })

    it('answers 404 for a team the caller cannot see, or that is not there', async function () {
      expect(
        (await ask('POST', `/teams/${hawks}/players`, STRANGER, one('a')))
          .status
      ).equals(404)
      expect(
        (await ask('POST', `/teams/tem_nothere/players`, ADMIN, one('a')))
          .status
      ).equals(404)
    })

    it('lets an administrator of the team who is not a site administrator in', async function () {
      const answer = await ask(
        'POST',
        `/teams/${hawks}/players`,
        TEAM_ADMIN,
        one('by-team-admin')
      )
      expect(answer.status).equals(200)
      expect(answer.body.counts).deep.equals({
        created: 1,
        joined: 0,
        unchanged: 0,
        error: 0
      })
    })

    it('lets an administrator of the team’s season or league in, and adds a player from a team they do not administer', async function () {
      // A player of a team in no season, whom neither administrator reaches.
      const elsewhere = makeId('team')
      await database()
        .insertInto('teams')
        .values({ id: elsewhere, name: 'Elsewhere' })
        .execute()
      const traveller = await existingUser('traveller')
      await database()
        .insertInto('memberships')
        .values({
          id: makeId('membership'),
          user_id: traveller,
          team_id: elsewhere,
          is_player: true
        })
        .execute()

      const teamId = await newTeam('Run by the season')
      const bySeason = await ask(
        'POST',
        `/teams/${teamId}/players`,
        SEASON_ADMIN,
        {
          players: [
            {
              firstName: 'Tra',
              lastName: 'Veller',
              externalId: ext('traveller')
            }
          ]
        }
      )
      expect(bySeason.status).equals(200)
      expect(bySeason.body.results).deep.equals([
        { index: 0, result: 'joined', userId: traveller }
      ])
      expect(await membershipOf(teamId, traveller)).deep.include({
        is_player: true
      })

      const byLeague = await ask(
        'POST',
        `/teams/${teamId}/players`,
        LEAGUE_ADMIN,
        one('by-league-admin')
      )
      expect(byLeague.status).equals(200)
      expect(byLeague.body.counts).deep.include({ created: 1 })
    })

    it('answers 400 naming the field', async function () {
      const cases: Array<[unknown, string]> = [
        [{ players: [] }, 'players must hold at least one player'],
        [
          { players: new Array(201).fill({ externalId: ext('x') }) },
          'players holds at most 200 players per call'
        ],
        [
          { players: [{ externalId: { ...ext('x'), system: 'Bad System' } }] },
          'players[0].externalId.system'
        ],
        [
          { players: [{ externalId: { ...ext('x'), kind: '' } }] },
          'players[0].externalId.kind'
        ],
        [
          { players: [{ externalId: { ...ext('x'), id: '' } }] },
          'players[0].externalId.id'
        ],
        [
          { players: [{ jersey: '1234', externalId: ext('x') }] },
          'players[0].jersey'
        ],
        [
          { players: [{ bats: 'both', externalId: ext('x') }] },
          'players[0].bats'
        ]
      ]
      for (const [body, field] of cases) {
        const answer = await ask('POST', `/teams/${hawks}/players`, ADMIN, body)
        expect(answer.status, field).equals(400)
        expect(answer.body.message).includes(field)
      }
    })

    it('makes a new player a user who cannot sign in, on the team with a jersey', async function () {
      const team = await newTeam('New players')
      const answer = await ask('POST', `/teams/${team}/players`, ADMIN, {
        players: [
          {
            firstName: ' Ann ',
            lastName: 'Lee',
            jersey: '7',
            bats: 'left',
            throws: 'right',
            externalId: ext('new-1')
          },
          { firstName: '', lastName: '', externalId: ext('new-2') }
        ]
      })
      expect(answer.status).equals(200)
      expect(answer.body.counts).deep.equals({
        created: 2,
        joined: 0,
        unchanged: 0,
        error: 0
      })
      const [first, second] = answer.body.results
      expect(first).deep.include({ index: 0, result: 'created' })
      expect(second).deep.include({ index: 1, result: 'created' })

      const user = await database()
        .selectFrom('users')
        .selectAll()
        .where('id', '=', first.userId)
        .executeTakeFirstOrThrow()
      expect(user.display_name).equals('Ann Lee')
      expect(user.first_name).equals('Ann')
      expect(user.last_name).equals('Lee')
      expect(user.login_enabled).equals(false)
      expect(user.bats).equals('left')
      expect(user.throws).equals('right')
      expect(user.bats_source).equals('import')

      const held = await database()
        .selectFrom('external_ids')
        .selectAll()
        .where('external_id', '=', 'new-1')
        .executeTakeFirstOrThrow()
      expect(held).deep.include({
        entity_type: 'user',
        entity_id: String(first.userId),
        system: 'otherLeague',
        kind: 'player'
      })
      expect(await membershipOf(team, first.userId)).deep.include({
        is_player: true,
        jersey: '7',
        role: 'member'
      })

      const unnamed = await database()
        .selectFrom('users')
        .selectAll()
        .where('id', '=', second.userId)
        .executeTakeFirstOrThrow()
      expect(unnamed.display_name).equals('Unknown player')
      expect(unnamed.first_name).equals(null)
      expect(unnamed.bats_source).equals(null)
    })

    it('adds nothing twice when the same roster comes again', async function () {
      const team = await newTeam('Again')
      const body = {
        players: [
          {
            firstName: 'Bo',
            lastName: 'Ng',
            jersey: '3',
            externalId: ext('again-1')
          },
          { firstName: 'Cy', lastName: 'Ng', externalId: ext('again-2') }
        ]
      }
      const first = await ask('POST', `/teams/${team}/players`, ADMIN, body)
      expect(first.body.counts.created).equals(2)
      const before = [
        await count('users'),
        await count('memberships'),
        await count('external_ids')
      ]
      const again = await ask('POST', `/teams/${team}/players`, ADMIN, body)
      expect(again.status).equals(200)
      expect(again.body.counts).deep.equals({
        created: 0,
        joined: 0,
        unchanged: 2,
        error: 0
      })
      expect(again.body.results.map((one: any) => one.userId)).deep.equals(
        first.body.results.map((one: any) => one.userId)
      )
      expect([
        await count('users'),
        await count('memberships'),
        await count('external_ids')
      ]).deep.equals(before)
    })

    it('makes a spectator who holds the id a player, filling a jersey only where none was', async function () {
      const team = await newTeam('Spectators')
      const watcher = await existingUser('spectator-1')
      const numbered = await existingUser('spectator-2')
      await database()
        .insertInto('memberships')
        .values([
          {
            id: makeId('membership'),
            user_id: watcher,
            team_id: team,
            is_spectator: true
          },
          {
            id: makeId('membership'),
            user_id: numbered,
            team_id: team,
            is_spectator: true,
            jersey: '5'
          }
        ])
        .execute()
      const users = await count('users')
      const answer = await ask('POST', `/teams/${team}/players`, ADMIN, {
        players: [
          {
            firstName: 'Di',
            lastName: 'Ro',
            jersey: '9',
            externalId: ext('spectator-1')
          },
          {
            firstName: 'Ed',
            lastName: 'Ro',
            jersey: '9',
            externalId: ext('spectator-2')
          }
        ]
      })
      expect(answer.body.results).deep.equals([
        { index: 0, result: 'joined', userId: watcher },
        { index: 1, result: 'joined', userId: numbered }
      ])
      expect(await count('users')).equals(users)
      expect(await membershipOf(team, watcher)).deep.include({
        is_player: true,
        jersey: '9'
      })
      expect(await membershipOf(team, numbered)).deep.include({
        is_player: true,
        jersey: '5'
      })
    })

    it('fills a missing jersey on a player already here, and still answers unchanged', async function () {
      const team = await newTeam('Numbers')
      const playing = await existingUser('numbers-1')
      await database()
        .insertInto('memberships')
        .values({
          id: makeId('membership'),
          user_id: playing,
          team_id: team,
          is_player: true
        })
        .execute()
      const answer = await ask('POST', `/teams/${team}/players`, ADMIN, {
        players: [{ jersey: '22', externalId: ext('numbers-1') }]
      })
      expect(answer.body.results[0]).deep.equals({
        index: 0,
        result: 'unchanged',
        userId: playing
      })
      expect((await membershipOf(team, playing))?.jersey).equals('22')
    })

    it('follows a merged account to the one it became', async function () {
      const team = await newTeam('Merged')
      const survivor = await existingUser(null, { displayName: 'Survivor' })
      await existingUser('merged-1', { mergedInto: survivor })
      const answer = await ask('POST', `/teams/${team}/players`, ADMIN, {
        players: [
          { firstName: 'Fay', lastName: 'Su', externalId: ext('merged-1') }
        ]
      })
      expect(answer.body.results[0]).deep.equals({
        index: 0,
        result: 'joined',
        userId: survivor
      })
      expect((await membershipOf(team, survivor))?.is_player).equals(true)
    })

    it('makes a new user for an id whose user row is gone, and moves the id onto them', async function () {
      const team = await newTeam('Orphans')
      await database()
        .insertInto('external_ids')
        .values({
          id: makeId('externalId'),
          entity_type: 'user',
          entity_id: 'not-a-user',
          system: 'otherLeague',
          kind: 'player',
          external_id: 'orphan-1',
          created_at: new Date()
        })
        .execute()
      const answer = await ask('POST', `/teams/${team}/players`, ADMIN, {
        players: [{ firstName: 'Gil', externalId: ext('orphan-1') }]
      })
      expect(answer.body.results[0].result).equals('created')
      const held = await database()
        .selectFrom('external_ids')
        .select(['entity_id'])
        .where('external_id', '=', 'orphan-1')
        .execute()
      expect(held).deep.equals([
        { entity_id: String(answer.body.results[0].userId) }
      ])
    })

    it("never replaces a coach's hands, and fills them where nobody gave any", async function () {
      const team = await newTeam('Hands')
      const coached = await existingUser('hands-1', {
        bats: 'left',
        batsSource: 'manual'
      })
      const blank = await existingUser('hands-2')
      await ask('POST', `/teams/${team}/players`, ADMIN, {
        players: [
          { bats: 'right', throws: 'right', externalId: ext('hands-1') },
          { bats: 'switch', throws: 'left', externalId: ext('hands-2') }
        ]
      })
      const read = async (userId: number): Promise<unknown> =>
        await database()
          .selectFrom('users')
          .select(['bats', 'throws', 'bats_source'])
          .where('id', '=', userId)
          .executeTakeFirstOrThrow()
      expect(await read(coached)).deep.equals({
        bats: 'left',
        throws: null,
        bats_source: 'manual'
      })
      expect(await read(blank)).deep.equals({
        bats: 'switch',
        throws: 'left',
        bats_source: 'import'
      })
    })

    it('writes each hand an import sends over an imported one, and leaves the other', async function () {
      const team = await newTeam('Hands later')
      const read = async (userId: number): Promise<unknown> =>
        await database()
          .selectFrom('users')
          .select(['bats', 'throws', 'bats_source'])
          .where('id', '=', userId)
          .executeTakeFirstOrThrow()
      const post = async (hands: object): Promise<void> => {
        await ask('POST', `/teams/${team}/players`, ADMIN, {
          players: [{ ...hands, externalId: ext('hands-later') }]
        })
      }

      // Throws alone first, on a new player.
      await post({ throws: 'left' })
      const [held] = await database()
        .selectFrom('external_ids')
        .select('entity_id')
        .where('external_id', '=', 'hands-later')
        .execute()
      const userId = Number(held?.entity_id)
      expect(await read(userId)).deep.equals({
        bats: null,
        throws: 'left',
        bats_source: 'import'
      })
      // Bats later, which the first import did not have.
      await post({ bats: 'right' })
      expect(await read(userId)).deep.equals({
        bats: 'right',
        throws: 'left',
        bats_source: 'import'
      })
      // An imported hand that changes is changed.
      await post({ bats: 'switch', throws: 'right' })
      expect(await read(userId)).deep.equals({
        bats: 'switch',
        throws: 'right',
        bats_source: 'import'
      })
      // Nothing sent, nothing written.
      await post({})
      expect(await read(userId)).deep.include({ bats_source: 'import' })

      // A coach's hands are never touched, even the one not set.
      await database()
        .updateTable('users')
        .set({ bats_source: 'manual', throws: null })
        .where('id', '=', userId)
        .execute()
      await post({ bats: 'left', throws: 'left' })
      expect(await read(userId)).deep.equals({
        bats: 'switch',
        throws: null,
        bats_source: 'manual'
      })

      // A new player sent no hands has no source.
      await ask('POST', `/teams/${team}/players`, ADMIN, one('no-hands'))
      const [bare] = await database()
        .selectFrom('external_ids')
        .select('entity_id')
        .where('external_id', '=', 'no-hands')
        .execute()
      expect(await read(Number(bare?.entity_id))).deep.equals({
        bats: null,
        throws: null,
        bats_source: null
      })
    })

    it('refuses only the row whose id a game holds', async function () {
      const team = await newTeam('Conflicts')
      const answer = await ask('POST', `/teams/${team}/players`, ADMIN, {
        players: [
          { firstName: 'Hal', externalId: ext('held-by-a-game') },
          { firstName: 'Ivy', externalId: ext('conflict-ok') }
        ]
      })
      expect(answer.status).equals(200)
      expect(answer.body.results[0]).deep.equals({
        index: 0,
        result: 'error',
        error: {
          code: 'conflict',
          message: 'otherLeague player held-by-a-game is already on a game'
        }
      })
      expect(answer.body.results[1].result).equals('created')
      expect(answer.body.counts).deep.equals({
        created: 1,
        joined: 0,
        unchanged: 0,
        error: 1
      })
    })

    it('draws another user id when the first is already a user’s, and gives up after five', async function () {
      const held = await existingUser(null)
      const fresh = mintUserId(id => id === held)
      const draws = [{ legacyId: 'usr_held', userId: held }, fresh]
      const minted = await database()
        .transaction()
        .execute(
          async trx => await mintFreeUserId(trx, () => draws.shift() ?? fresh)
        )
      expect(minted).deep.equals(fresh)
      expect(draws).deep.equals([])

      let failed: unknown
      try {
        await database()
          .transaction()
          .execute(
            async trx =>
              await mintFreeUserId(trx, () => ({
                legacyId: 'usr_held',
                userId: held
              }))
          )
      } catch (error) {
        failed = error
      }
      expect((failed as Error).message).equals(
        'Five user ids drawn were all taken'
      )
    })

    it('answers conflict, and makes nobody, when a writer that took no lock records the id first', async function () {
      const teamId = await newTeam('Raced ids')
      const users = await count('users')
      const answer = await whileHeldElsewhere(
        'raced-1',
        async () =>
          await ask('POST', `/teams/${teamId}/players`, ADMIN, one('raced-1'))
      )
      expect(answer.body.results).deep.equals([
        {
          index: 0,
          result: 'error',
          error: {
            code: 'conflict',
            message:
              'otherLeague player raced-1 is already held by something else'
          }
        }
      ])
      expect(await count('users')).equals(users)
    })

    it('makes one user when the same new player is posted twice at once', async function () {
      const team = await newTeam('Races')
      const body = {
        players: [
          { firstName: 'Jo', lastName: 'Ra', externalId: ext('race-1') }
        ]
      }
      const answers = await Promise.all([
        ask('POST', `/teams/${team}/players`, ADMIN, body),
        ask('POST', `/teams/${team}/players`, ADMIN, body)
      ])
      expect(answers.map(one => one.status)).deep.equals([200, 200])
      expect(
        answers
          .map(one => one.body.results[0].result as string)
          .sort((a, b) => a.localeCompare(b))
      ).deep.equals(['created', 'unchanged'])
      const held = await database()
        .selectFrom('external_ids')
        .select(['entity_id'])
        .where('external_id', '=', 'race-1')
        .execute()
      expect(held).to.have.length(1)
      const userIds = new Set(answers.map(one => one.body.results[0].userId))
      expect(userIds.size).equals(1)
      const players = await database()
        .selectFrom('memberships')
        .select(['user_id'])
        .where('team_id', '=', team)
        .execute()
      expect(players).to.have.length(1)
    })

    it('is found on the roster and by external id afterwards', async function () {
      const team = await newTeam('Found')
      const answer = await ask('POST', `/teams/${team}/players`, ADMIN, {
        players: [
          {
            firstName: 'Kai',
            lastName: 'Moe',
            jersey: '11',
            externalId: ext('found-1')
          }
        ]
      })
      const userId = answer.body.results[0].userId
      const roster = await ask('GET', `/teams/${team}/roster`, ADMIN)
      expect(roster.status).equals(200)
      expect(roster.body).to.have.length(1)
      expect(roster.body[0]).deep.include({
        userId,
        jersey: '11',
        isPlayer: true
      })
      const found = await ask('GET', '/users?externalId=found-1', ADMIN)
      expect(found.body).deep.equals([{ userId, externalIds: ['found-1'] }])
    })

    it('records an audit entry for the team', async function () {
      const team = await newTeam('Audited')
      await ask('POST', `/teams/${team}/players`, ADMIN, one('audit-1'))
      // The audit row is written after the answer goes out.
      let row
      for (let tries = 0; tries < 50 && row == null; tries += 1) {
        row = await database()
          .selectFrom('audit_log')
          .select(['entity_type', 'entity_id', 'after'])
          .where('path', '=', `/api/v1/teams/${team}/players`)
          .executeTakeFirst()
        if (row == null) await new Promise(resolve => setTimeout(resolve, 20))
      }
      expect(row).deep.include({ entity_type: 'team', entity_id: team })
      expect((row?.after as any).players.created).equals(1)
    })
  })
})
