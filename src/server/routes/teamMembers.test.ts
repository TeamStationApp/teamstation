import { execFile } from 'node:child_process'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'

import { expect } from 'chai'
import express from 'express'
import type { Kysely } from 'kysely'
import { after, before, describe, it } from 'mocha'
import { Pool } from 'pg'

import { makeId } from '../../common/ids'
import { mintUserId } from '../../common/mintUserId'
import { asTeamAdultsBody, asTeamPlayersBody } from '../../common/teamMembers'
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
import { attachEmail } from '../teams/addAdults'
import { mintFreeUserId } from '../teams/addPlayers'
import { authRoutes } from './auth'
import { manageRoutes } from './manage'
import { teamMemberRoutes } from './teamMembers'
import { teamRoutes } from './teams'
import { userRoutes } from './users'

/**
 * Adding a team's people by the ids another system has for them:
 * `POST /teams/:teamId/players` and `POST /teams/:teamId/adults`; and the
 * team's logo and its players' headshots, stored in a stand-in Space.
 */

const adminUrl = testDatabaseUrl
const scratchName = `teamstation_team_members_${Date.now()}`
const scratchUrl = adminUrl.replace(/\/[^/]*$/, `/${scratchName}`)

const run = promisify(execFile)
const FFMPEG = process.env.TS_FFMPEG ?? '/opt/homebrew/bin/ffmpeg'
const BUCKET = 'example-media-bkt'

const ADMIN = 'tok_members_admin_000000000000000000'
const TEAM_ADMIN = 'tok_members_teamadmin_00000000000000'
const MEMBER = 'tok_members_member_00000000000000000'
const SEASON_ADMIN = 'tok_members_seasonadmin_000000000000'
const LEAGUE_ADMIN = 'tok_members_leagueadmin_000000000000'
const STRANGER = 'tok_members_stranger_000000000000000'

/** The eight bytes every PNG begins with. */
const PNG_SIGNATURE = Buffer.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a
])

/** A 16 px purple square as lossless WebP, which FFmpeg can read. */
const WEBP = 'UklGRhwAAABXRUJQVlA4TBAAAAAvD8ADAAcQ/etf/wMR0f8A'

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

  const mail: Array<{ to: string; code?: string }> = []
  /** What the stand-in Space was sent, by path, and every PUT in order. */
  const objects = new Map<string, Buffer>()
  const puts: string[] = []
  /** While set, the stand-in Space refuses every upload with a 500. */
  let refusing = false
  /** While set, the next upload is held until `release` settles. */
  let holdNext: { arrived: () => void; release: Promise<void> } | undefined
  let space: Server | undefined

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

    // A Space that keeps what it is sent and hands it back.
    space = createServer((req, res) => {
      const path = new URL(req.url ?? '/', 'http://space.test').pathname
      if (req.method === 'GET') {
        const held = objects.get(path)
        res.statusCode = held == null ? 404 : 200
        res.end(held)
        return
      }
      if (req.method !== 'PUT') {
        res.statusCode = 405
        res.end()
        return
      }
      const chunks: Buffer[] = []
      req.on('data', chunk => chunks.push(chunk as Buffer))
      req.on('end', () => {
        if (refusing) {
          res.statusCode = 500
          res.end('<Error><Code>InternalError</Code></Error>')
          return
        }
        const keep = (): void => {
          puts.push(path)
          objects.set(path, Buffer.concat(chunks))
          res.statusCode = 200
          res.end()
        }
        const hold = holdNext
        if (hold == null) {
          keep()
          return
        }
        holdNext = undefined
        hold.arrived()
        hold.release.then(keep, () => {})
      })
    })
    await new Promise<void>(resolve => {
      space?.listen(0, '127.0.0.1', resolve)
    })
    const spacePort = (space.address() as AddressInfo).port
    const noSpace = {
      endpoint: '',
      region: '',
      bucket: '',
      accessKeyId: '',
      secretAccessKey: '',
      pathStyle: true
    }
    const media: MediaContext = {
      mediaRoot: '/tmp',
      ffmpegPath: FFMPEG,
      mediaSecret: 'secret',
      publicUrl: 'http://127.0.0.1',
      space: {
        endpoint: `http://127.0.0.1:${spacePort}`,
        region: 'sfo3',
        bucket: BUCKET,
        accessKeyId: 'AKIAEXAMPLE000000000',
        secretAccessKey: 'secret',
        pathStyle: true
      }
    }
    const app = express()
    app.use(withActor(db))
    app.use(jsonBody)
    app.use(withAudit(db))
    app.use('/api/v1', teamRoutes(db, media))
    app.use('/api/v1', userRoutes(db))
    app.use('/api/v1', teamMemberRoutes(db, media))
    // The same routes on a server with no Space configured.
    app.use(
      '/bare/api/v1',
      teamMemberRoutes(db, { ffmpegPath: FFMPEG, space: noSpace })
    )
    // Mail doubles: the adults route must never send anything, and the
    // sign-in cases read their codes from here.
    app.use(
      '/api/v1',
      authRoutes(db, {
        sendCode: async (to, code) => {
          mail.push({ to, code })
        },
        publicUrl: 'http://127.0.0.1'
      })
    )
    app.use(
      '/api/v1',
      manageRoutes(db, {
        sendInvite: async to => {
          mail.push({ to })
        },
        publicUrl: 'http://127.0.0.1'
      })
    )
    app.use(errorHandler)
    server = app.listen(0, '127.0.0.1')
    await new Promise<void>(resolve => server?.once('listening', resolve))
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  })

  after(async function () {
    server?.close()
    space?.close()
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
    body?: unknown,
    prefix = '/api/v1'
  ): Promise<Answer> {
    const response = await fetch(`${base}${prefix}${path}`, {
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
   * an uncommitted row from `insert`, and commits that row once the request
   * is waiting on it: the request read the row's key as free, and then finds
   * it taken.
   */
  async function whileUncommitted(
    insert: { text: string; values: unknown[] },
    request: () => Promise<Answer>
  ): Promise<Answer> {
    const racer = new Pool({ connectionString: scratchUrl })
    const client = await racer.connect()
    try {
      await client.query('begin')
      await client.query(insert.text, insert.values)
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

  /** `whileUncommitted`, for an external id a game is given. */
  async function whileHeldElsewhere(
    externalId: string,
    request: () => Promise<Answer>,
    kind = 'player'
  ): Promise<Answer> {
    return await whileUncommitted(
      {
        text: `insert into external_ids (id, entity_type, entity_id, system, kind, external_id)
               values ($1, 'game', $2, 'otherLeague', $3, $4)`,
        values: [makeId('externalId'), game, kind, externalId]
      },
      request
    )
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

  describe('the adults body', function () {
    const row = { externalId: ext('x', 'member') }
    const refusals: Array<[unknown, string]> = [
      [{ adults: [] }, 'adults must hold at least one adult'],
      [{ adults: [7] }, 'adults[0] must be an object'],
      [
        { adults: [{ ...row, email: 'nobody' }] },
        'adults[0].email must be an address, with an @'
      ],
      [{ adults: [{ ...row, email: 5 }] }, 'adults[0].email must be a string'],
      [
        { adults: [{ ...row, email: `${'x'.repeat(250)}@a.bc` }] },
        'adults[0].email must be at most 254 characters'
      ],
      [
        { adults: [{ ...row, guardianOf: ext('p') }] },
        'adults[0].guardianOf must be an array'
      ],
      [
        { adults: [{ ...row, guardianOf: new Array(51).fill(ext('p')) }] },
        'adults[0].guardianOf holds at most 50 players'
      ],
      [
        {
          adults: [{ ...row, guardianOf: [ext('p'), { ...ext('q'), id: '' }] }]
        },
        'adults[0].guardianOf[1].id must be a non-empty string'
      ],
      [
        { adults: [{ ...row, staff: 'yes' }] },
        'adults[0].staff must be true or false'
      ]
    ]
    for (const [body, message] of refusals) {
      it(`refuses with “${message}”`, function () {
        expect(() => asTeamAdultsBody(body)).throws(TypeError, message)
      })
    }

    it('lower-cases the address, and reads missing lists and flags as none', function () {
      expect(
        asTeamAdultsBody({
          adults: [{ firstName: 'Al', email: ' Al@Example.TEST ', ...row }]
        })
      ).deep.equals({
        adults: [
          {
            firstName: 'Al',
            lastName: '',
            email: 'al@example.test',
            externalId: ext('x', 'member'),
            guardianOf: [],
            staff: false
          }
        ]
      })
    })
  })

  describe('POST /teams/:teamId/adults', function () {
    /** People the sign-in cases at the end reach by address. */
    const signIns: Array<{ email: string; userId: number; teamId: string }> = []

    const adults = async (
      teamId: string,
      rows: unknown[],
      token = ADMIN
    ): Promise<Answer> =>
      await ask('POST', `/teams/${teamId}/adults`, token, { adults: rows })

    /** A team with players `<prefix>-1` … `<prefix>-n`, by external id. */
    async function teamWithPlayers(
      name: string,
      prefix: string,
      n: number
    ): Promise<{ teamId: string; players: number[] }> {
      const teamId = await newTeam(name)
      const answer = await ask('POST', `/teams/${teamId}/players`, ADMIN, {
        players: Array.from({ length: n }, (_, i) => ({
          firstName: `Kid${i + 1}`,
          lastName: name,
          externalId: ext(`${prefix}-${i + 1}`)
        }))
      })
      return {
        teamId,
        players: answer.body.results.map((one: any) => one.userId)
      }
    }

    const emailsOf = async (
      userId: number
    ): Promise<
      Array<{
        email: string
        is_primary: boolean
        source: string
        verified_at: Date | null
      }>
    > =>
      await database()
        .selectFrom('user_emails')
        .select(['email', 'is_primary', 'source', 'verified_at'])
        .where('user_id', '=', userId)
        .orderBy('created_at')
        .execute()

    const linksOf = async (
      userId: number
    ): Promise<
      Array<{ related_user_id: number; kind: string; can_manage: boolean }>
    > =>
      await database()
        .selectFrom('user_links')
        .select(['related_user_id', 'kind', 'can_manage'])
        .where('user_id', '=', userId)
        .orderBy('related_user_id')
        .execute()

    const rolesOf = async (userId: number, teamId: string): Promise<string[]> =>
      (
        await database()
          .selectFrom('scope_roles')
          .select(['role'])
          .where('user_id', '=', userId)
          .where('scope_type', '=', 'team')
          .where('scope_id', '=', teamId)
          .execute()
      )
        .map(row => row.role as string)
        .sort((a, b) => a.localeCompare(b))

    async function giveEmail(
      userId: number,
      email: string,
      isPrimary: boolean
    ): Promise<void> {
      await database()
        .insertInto('user_emails')
        .values({
          id: makeId('userEmail'),
          user_id: userId,
          email,
          is_primary: isPrimary,
          created_at: new Date()
        })
        .execute()
    }

    const one = { firstName: 'Al', externalId: ext('perm-1', 'member') }

    it('answers 401, 403 and 404 as the players route does', async function () {
      expect(
        (await adults(hawks, [one], null as unknown as string)).status
      ).equals(401)
      expect((await adults(hawks, [one], MEMBER)).status).equals(403)
      expect((await adults(hawks, [one], STRANGER)).status).equals(404)
      expect((await adults('tem_nothere', [one])).status).equals(404)
    })

    it('lets an administrator of the team who is not a site administrator in', async function () {
      const answer = await adults(hawks, [one], TEAM_ADMIN)
      expect(answer.status).equals(200)
      expect(answer.body.results[0].result).equals('created')
    })

    it('lets an administrator of the team’s season or league in', async function () {
      const teamId = await newTeam('Adults by season and league')
      for (const [token, id] of [
        [SEASON_ADMIN, 'by-season-admin'],
        [LEAGUE_ADMIN, 'by-league-admin']
      ]) {
        const answer = await adults(
          teamId,
          [{ firstName: 'Ad', externalId: ext(id, 'member') }],
          token
        )
        expect(answer.status, token).equals(200)
        expect(answer.body.results[0].result, token).equals('created')
      }
    })

    it('answers 400 naming the field', async function () {
      const cases: Array<[unknown, string]> = [
        [{ adults: [] }, 'adults must hold at least one adult'],
        [
          { adults: new Array(201).fill(one) },
          'adults holds at most 200 adults per call'
        ],
        [
          { adults: [{ externalId: { ...ext('x'), system: '9lives' } }] },
          'adults[0].externalId.system'
        ],
        [
          { adults: [{ externalId: { ...ext('x'), kind: '' } }] },
          'adults[0].externalId.kind'
        ],
        [
          { adults: [{ externalId: { ...ext('x'), id: '' } }] },
          'adults[0].externalId.id'
        ],
        [
          { adults: [{ ...one, email: 'parent.example.test' }] },
          'adults[0].email'
        ]
      ]
      for (const [body, field] of cases) {
        const answer = await ask('POST', `/teams/${hawks}/adults`, ADMIN, body)
        expect(answer.status, field).equals(400)
        expect(answer.body.message).includes(field)
      }
    })

    it('makes a new parent who may sign in, with their address, on the team and linked to their children', async function () {
      const { teamId, players } = await teamWithPlayers('Parents', 'kid', 2)
      const answer = await adults(teamId, [
        {
          firstName: 'Pat',
          lastName: 'Lee',
          email: ' Pat.Lee@Example.TEST ',
          externalId: ext('parent-1', 'member'),
          guardianOf: [ext('kid-1'), ext('kid-2')],
          staff: false
        }
      ])
      expect(answer.status).equals(200)
      const [row] = answer.body.results
      expect(row).deep.include({
        index: 0,
        result: 'created',
        joined: true,
        guardianLinks: 2,
        guardiansMissing: 0,
        rolesAdded: []
      })
      expect(row).not.to.have.property('emailHeldElsewhere')
      expect(answer.body.counts).deep.equals({
        created: 1,
        matched: 0,
        unchanged: 0,
        error: 0,
        guardianLinks: 2,
        staff: 0
      })

      const user = await database()
        .selectFrom('users')
        .selectAll()
        .where('id', '=', row.userId)
        .executeTakeFirstOrThrow()
      expect(user).deep.include({
        display_name: 'Pat Lee',
        first_name: 'Pat',
        last_name: 'Lee',
        login_enabled: true
      })
      expect(await emailsOf(row.userId)).deep.equals([
        {
          email: 'pat.lee@example.test',
          is_primary: true,
          source: 'import',
          verified_at: null
        }
      ])
      const held = await database()
        .selectFrom('external_ids')
        .select(['entity_type', 'entity_id', 'system', 'kind'])
        .where('external_id', '=', 'parent-1')
        .executeTakeFirstOrThrow()
      expect(held).deep.equals({
        entity_type: 'user',
        entity_id: String(row.userId),
        system: 'otherLeague',
        kind: 'member'
      })
      expect(await membershipOf(teamId, row.userId)).deep.include({
        is_spectator: true,
        is_player: false,
        role: 'member'
      })
      expect(await linksOf(row.userId)).deep.equals(
        [...players]
          .sort((a, b) => a - b)
          .map(id => ({
            related_user_id: id,
            kind: 'guardian',
            can_manage: true
          }))
      )
      signIns.push({
        email: 'pat.lee@example.test',
        userId: row.userId,
        teamId
      })
    })

    it('makes an adult without an address one who cannot sign in, with no address', async function () {
      const teamId = await newTeam('No address')
      const answer = await adults(teamId, [
        { firstName: '', lastName: '', externalId: ext('no-address', 'member') }
      ])
      const { userId } = answer.body.results[0]
      const user = await database()
        .selectFrom('users')
        .select(['display_name', 'login_enabled'])
        .where('id', '=', userId)
        .executeTakeFirstOrThrow()
      expect(user).deep.equals({
        display_name: 'Unknown adult',
        login_enabled: false
      })
      expect(await emailsOf(userId)).deep.equals([])
    })

    it('attaches an address to somebody found by external id, as primary when they had none', async function () {
      const teamId = await newTeam('Attach')
      const known = await existingUser('attach-1', {}, 'member')
      const answer = await adults(teamId, [
        {
          firstName: 'Quin',
          email: 'quin@example.test',
          externalId: ext('attach-1', 'member')
        }
      ])
      expect(answer.body.results[0]).deep.include({
        result: 'matched',
        userId: known,
        joined: true
      })
      expect(await emailsOf(known)).deep.equals([
        {
          email: 'quin@example.test',
          is_primary: true,
          source: 'import',
          verified_at: null
        }
      ])
      const user = await database()
        .selectFrom('users')
        .select(['login_enabled'])
        .where('id', '=', known)
        .executeTakeFirstOrThrow()
      // Never changed for somebody already here.
      expect(user.login_enabled).equals(false)
      signIns.push({ email: 'quin@example.test', userId: known, teamId })
    })

    it('never gives an account that has an address a second one', async function () {
      const teamId = await newTeam('Second address')
      const known = await existingUser('second-1', {}, 'member')
      await giveEmail(known, 'first@example.test', true)
      for (const token of [ADMIN, SEASON_ADMIN]) {
        const answer = await adults(
          teamId,
          [
            {
              email: 'second@example.test',
              externalId: ext('second-1', 'member')
            }
          ],
          token
        )
        expect(answer.body.results[0], token).deep.include({
          userId: known,
          emailNotAttached: true
        })
        expect(answer.body.results[0]).not.to.have.property(
          'emailHeldElsewhere'
        )
      }
      expect(
        (await emailsOf(known)).map(row => [row.email, row.is_primary])
      ).deep.equals([['first@example.test', true]])
    })

    it('attaches no address to an account already here when a team administrator imports it', async function () {
      const teamId = await newTeam('Team admin addresses')
      const known = await existingUser('no-address-1', {}, 'member')
      const row = {
        firstName: 'Nia',
        email: 'nia@example.test',
        externalId: ext('no-address-1', 'member')
      }
      const first = await adults(teamId, [row], SEASON_ADMIN)
      expect(first.body.results[0]).deep.include({
        result: 'matched',
        userId: known,
        joined: true,
        emailNotAttached: true
      })
      expect(await emailsOf(known)).deep.equals([])

      // Gaining nothing else, they are unchanged.
      const again = await adults(teamId, [row], SEASON_ADMIN)
      expect(again.body.results[0]).deep.include({
        result: 'unchanged',
        emailNotAttached: true
      })
      expect(await emailsOf(known)).deep.equals([])

      // A site administrator may give the account its first address.
      const byAdmin = await adults(teamId, [row])
      expect(byAdmin.body.results[0]).deep.include({ result: 'matched' })
      expect(byAdmin.body.results[0]).not.to.have.property('emailNotAttached')
      expect(await emailsOf(known)).deep.equals([
        {
          email: 'nia@example.test',
          is_primary: true,
          source: 'import',
          verified_at: null
        }
      ])
    })

    it('attaches the address to an account a team administrator’s import makes', async function () {
      const teamId = await newTeam('Team admin new parents')
      const answer = await adults(
        teamId,
        [
          {
            firstName: 'Ola',
            email: 'ola@example.test',
            externalId: ext('new-with-address', 'member')
          }
        ],
        SEASON_ADMIN
      )
      const [row] = answer.body.results
      expect(row.result).equals('created')
      expect(row).not.to.have.property('emailNotAttached')
      expect((await emailsOf(row.userId)).map(one => one.email)).deep.equals([
        'ola@example.test'
      ])
    })

    it('gives a parent who is also staff their links, coach and scorekeeper, and a spectator membership', async function () {
      const { teamId } = await teamWithPlayers('Coach parents', 'cp', 1)
      const answer = await adults(teamId, [
        {
          firstName: 'Ro',
          lastName: 'Bin',
          externalId: ext('coach-parent', 'member'),
          guardianOf: [ext('cp-1')],
          staff: true
        }
      ])
      const [row] = answer.body.results
      expect(row).deep.include({
        result: 'created',
        guardianLinks: 1,
        rolesAdded: ['coach', 'scorekeeper']
      })
      expect(answer.body.counts.staff).equals(1)
      expect(await rolesOf(row.userId, teamId)).deep.equals([
        'coach',
        'scorekeeper'
      ])
      expect((await membershipOf(teamId, row.userId))?.is_spectator).equals(
        true
      )
    })

    it('finds the user holding the address when nobody holds the id, and records the id on them', async function () {
      const teamId = await newTeam('By address')
      const known = await existingUser(null, { loginEnabled: true })
      await giveEmail(known, 'held@example.test', true)
      const users = await count('users')
      const answer = await adults(teamId, [
        {
          firstName: 'Held',
          email: 'HELD@example.test',
          externalId: ext('by-address-1', 'member')
        }
      ])
      expect(answer.body.results[0]).deep.include({
        result: 'matched',
        userId: known
      })
      expect(answer.body.results[0]).not.to.have.property(
        'externalIdNotAttached'
      )
      expect(await count('users')).equals(users)
      const held = await database()
        .selectFrom('external_ids')
        .select(['entity_id'])
        .where('external_id', '=', 'by-address-1')
        .executeTakeFirstOrThrow()
      expect(held.entity_id).equals(String(known))
    })

    it('records no id on an account found by address when a team administrator imports it', async function () {
      const teamId = await newTeam('By address, team admin')
      const known = await existingUser(null, { loginEnabled: true })
      await giveEmail(known, 'kept@example.test', true)
      const answer = await adults(
        teamId,
        [
          {
            firstName: 'Kept',
            email: 'kept@example.test',
            externalId: ext('by-address-2', 'member')
          }
        ],
        SEASON_ADMIN
      )
      expect(answer.body.results[0]).deep.include({
        result: 'matched',
        userId: known,
        joined: true,
        externalIdNotAttached: true
      })
      expect(answer.body.results[0]).not.to.have.property('emailNotAttached')
      const held = await database()
        .selectFrom('external_ids')
        .select('id')
        .where('external_id', '=', 'by-address-2')
        .execute()
      expect(held).deep.equals([])

      // So the id finds nobody: posted as a player, it makes a new one.
      const player = await ask('POST', `/teams/${teamId}/players`, ADMIN, {
        players: [
          { firstName: 'Kept', externalId: ext('by-address-2', 'member') }
        ]
      })
      expect(player.body.results[0].result).equals('created')
      expect(player.body.results[0].userId).not.equals(known)
    })

    it('finds the account an address’s merged-away holder became, and makes nobody', async function () {
      const teamId = await newTeam('Merged address')
      const survivor = await existingUser(null)
      const closed = await existingUser(null, { mergedInto: survivor })
      await giveEmail(closed, 'merged@example.test', true)
      const users = await count('users')
      const answer = await adults(teamId, [
        {
          firstName: 'Mer',
          email: 'merged@example.test',
          externalId: ext('merged-address-1', 'member')
        }
      ])
      expect(answer.body.results[0]).deep.include({
        result: 'matched',
        userId: survivor,
        joined: true
      })
      expect(answer.body.results[0]).not.to.have.property('emailHeldElsewhere')
      expect(answer.body.results[0]).not.to.have.property('emailNotAttached')
      expect(await count('users')).equals(users)
    })

    it('answers conflict, and makes nobody, when a writer that took no lock records the id first', async function () {
      const teamId = await newTeam('Raced adults')
      const users = await count('users')
      const answer = await whileHeldElsewhere(
        'raced-adult',
        async () =>
          await adults(teamId, [
            {
              firstName: 'Ray',
              email: 'ray@example.test',
              externalId: ext('raced-adult', 'member')
            }
          ]),
        'member'
      )
      expect(answer.body.results[0]).deep.equals({
        index: 0,
        result: 'error',
        error: {
          code: 'conflict',
          message:
            'otherLeague member raced-adult is already held by something else'
        },
        joined: false,
        guardianLinks: 0,
        guardiansMissing: 0,
        rolesAdded: []
      })
      expect(await count('users')).equals(users)

      // The same for an account a site administrator found by its address.
      const known = await existingUser(null)
      await giveEmail(known, 'raced@example.test', true)
      const found = await whileHeldElsewhere(
        'raced-adult-2',
        async () =>
          await adults(teamId, [
            {
              email: 'raced@example.test',
              externalId: ext('raced-adult-2', 'member')
            }
          ]),
        'member'
      )
      expect(found.body.results[0]).deep.include({ result: 'error' })
      expect(await membershipOf(teamId, known)).equals(undefined)
    })

    it('leaves an address another sign-in commits while the row waits, and applies the rest', async function () {
      const teamId = await newTeam('Raced address')
      const other = await existingUser(null)
      const answer = await whileUncommitted(
        {
          text: `insert into user_emails (id, user_id, email, is_primary)
                 values ($1, $2, 'race@example.test', true)`,
          values: [makeId('userEmail'), other]
        },
        async () =>
          await adults(teamId, [
            {
              firstName: 'Rae',
              email: 'race@example.test',
              externalId: ext('raced-address-1', 'member')
            },
            { firstName: 'Next', externalId: ext('raced-address-2', 'member') }
          ])
      )
      expect(answer.status).equals(200)
      const [raced, next] = answer.body.results
      expect(raced).deep.include({
        result: 'created',
        joined: true,
        emailHeldElsewhere: true
      })
      expect(next).deep.include({ result: 'created', joined: true })
      expect(await emailsOf(raced.userId)).deep.equals([])
      expect((await emailsOf(other)).map(row => row.email)).deep.equals([
        'race@example.test'
      ])
    })

    it('keeps what addEmail answers when the address is taken after the check', async function () {
      const userId = await existingUser(null)
      const other = await existingUser(null)
      const merged = await existingUser(null, { mergedInto: userId })
      const attach = async (heldBy: number | undefined): Promise<string> =>
        await database()
          .transaction()
          .execute(
            async trx =>
              await attachEmail(
                trx,
                userId,
                'late@example.test',
                { created: true, callerIsAdmin: false },
                async () =>
                  heldBy == null ? { added: false } : { added: false, heldBy }
              )
          )
      expect(await attach(other)).equals('heldElsewhere')
      expect(await attach(undefined)).equals('theirs')
      expect(await attach(userId)).equals('theirs')
      expect(await attach(merged)).equals('theirs')
      expect(await emailsOf(userId)).deep.equals([])
    })

    it('keeps the user holding the id when somebody else holds the address', async function () {
      const teamId = await newTeam('Elsewhere')
      const holder = await existingUser('elsewhere-1', {}, 'member')
      const other = await existingUser(null)
      await giveEmail(other, 'other@example.test', true)
      const answer = await adults(teamId, [
        {
          email: 'other@example.test',
          externalId: ext('elsewhere-1', 'member')
        }
      ])
      expect(answer.body.results[0]).deep.include({
        result: 'matched',
        userId: holder,
        emailHeldElsewhere: true
      })
      expect(answer.body.results[0]).not.to.have.property('emailNotAttached')
      expect(await emailsOf(holder)).deep.equals([])
      expect((await emailsOf(other)).map(row => row.email)).deep.equals([
        'other@example.test'
      ])
    })

    it('adds coach and scorekeeper to staff, keeps their other roles, never adds admin, and adds nothing twice', async function () {
      const teamId = await newTeam('Staff')
      const singer = await existingUser('staff-1', {}, 'member')
      await database()
        .insertInto('scope_roles')
        .values({
          id: makeId('scopeRole'),
          user_id: singer,
          scope_type: 'team',
          scope_id: teamId,
          role: 'songkeeper',
          granted_at: new Date()
        })
        .execute()
      const body = [
        {
          firstName: 'Sing',
          externalId: ext('staff-1', 'member'),
          staff: true
        },
        { firstName: 'Only', externalId: ext('staff-2', 'member'), staff: true }
      ]
      const first = await adults(teamId, body)
      expect(first.body.results.map((row: any) => row.rolesAdded)).deep.equals([
        ['coach', 'scorekeeper'],
        ['coach', 'scorekeeper']
      ])
      expect(first.body.counts.staff).equals(2)
      expect(await rolesOf(singer, teamId)).deep.equals([
        'coach',
        'scorekeeper',
        'songkeeper'
      ])
      const staffOnly = first.body.results[1].userId
      // Staff who guard nobody are not spectators.
      expect(await membershipOf(teamId, staffOnly)).deep.include({
        is_spectator: false,
        role: 'member'
      })

      const again = await adults(teamId, body)
      expect(again.body.results.map((row: any) => row.result)).deep.equals([
        'unchanged',
        'unchanged'
      ])
      expect(again.body.counts).deep.include({ staff: 0, guardianLinks: 0 })
      const admins = await database()
        .selectFrom('scope_roles')
        .select(['id'])
        .where('scope_id', '=', teamId)
        .where('role', '=', 'admin')
        .execute()
      expect(admins).deep.equals([])
    })

    it('counts a guardian of somebody who is not a player here as missing, and links nobody', async function () {
      const { teamId } = await teamWithPlayers('Missing', 'miss', 1)
      const elsewhere = await teamWithPlayers('Elsewhere team', 'away', 1)
      const answer = await adults(teamId, [
        {
          externalId: ext('missing-parent', 'member'),
          guardianOf: [ext('away-1'), ext('nobody-at-all')]
        }
      ])
      expect(answer.body.results[0]).deep.include({
        guardianLinks: 0,
        guardiansMissing: 2
      })
      expect(await linksOf(answer.body.results[0].userId)).deep.equals([])
      expect(elsewhere.players).to.have.length(1)
    })

    it('makes a follower a spectator with no links and no roles', async function () {
      const teamId = await newTeam('Followers')
      const answer = await adults(teamId, [
        { firstName: 'Fan', externalId: ext('follower-1', 'member') }
      ])
      const [row] = answer.body.results
      expect(row).deep.include({
        result: 'created',
        joined: true,
        guardianLinks: 0,
        rolesAdded: []
      })
      expect(await membershipOf(teamId, row.userId)).deep.include({
        is_spectator: true,
        is_player: false
      })
      expect(await linksOf(row.userId)).deep.equals([])
      expect(await rolesOf(row.userId, teamId)).deep.equals([])
    })

    it('keeps a player a player, and makes them a spectator too', async function () {
      const { teamId, players } = await teamWithPlayers('Both', 'both', 1)
      const answer = await adults(teamId, [
        { firstName: 'Kid1', externalId: ext('both-1') }
      ])
      expect(answer.body.results[0]).deep.include({
        result: 'matched',
        userId: players[0],
        joined: false
      })
      expect(await membershipOf(teamId, players[0])).deep.include({
        is_player: true,
        is_spectator: true
      })
    })

    it('adds nothing twice when the same adults come again', async function () {
      const { teamId } = await teamWithPlayers('Twice', 'twice', 2)
      const body = [
        {
          firstName: 'Mo',
          email: 'mo@example.test',
          externalId: ext('twice-parent', 'member'),
          guardianOf: [ext('twice-1'), ext('twice-2')]
        },
        { firstName: 'Fo', externalId: ext('twice-follower', 'member') },
        {
          firstName: 'Co',
          externalId: ext('twice-coach', 'member'),
          staff: true
        }
      ]
      const first = await adults(teamId, body)
      expect(first.body.counts).deep.equals({
        created: 3,
        matched: 0,
        unchanged: 0,
        error: 0,
        guardianLinks: 2,
        staff: 1
      })
      const tables = async (): Promise<number[]> => [
        await count('users'),
        await count('memberships'),
        await count('external_ids'),
        Number(
          (
            await database()
              .selectFrom('user_links')
              .select(eb => eb.fn.countAll<string>().as('n'))
              .executeTakeFirstOrThrow()
          ).n
        )
      ]
      const before = await tables()
      const again = await adults(teamId, body)
      expect(again.body.counts).deep.equals({
        created: 0,
        matched: 0,
        unchanged: 3,
        error: 0,
        guardianLinks: 0,
        staff: 0
      })
      expect(await tables()).deep.equals(before)
    })

    it('refuses only the row whose id is not a person’s', async function () {
      const teamId = await newTeam('Adult conflicts')
      const answer = await adults(teamId, [
        { externalId: ext('held-by-a-game') },
        { externalId: ext('fine-adult', 'member') }
      ])
      expect(answer.body.results[0]).deep.equals({
        index: 0,
        result: 'error',
        error: {
          code: 'conflict',
          message: 'otherLeague player held-by-a-game is already on a game'
        },
        joined: false,
        guardianLinks: 0,
        guardiansMissing: 0,
        rolesAdded: []
      })
      expect(answer.body.counts).deep.include({ created: 1, error: 1 })
    })

    it('sends no mail to anybody', function () {
      expect(mail).deep.equals([])
    })

    it('signs each attached address in by e-mail code, to an account already on the team', async function () {
      expect(signIns).to.have.length(2)
      for (const one of signIns) {
        const asked = await ask('POST', '/auth/email-code', null, {
          email: one.email
        })
        expect(asked.status).equals(202)
        const sent = mail.find(entry => entry.to === one.email)
        expect(sent?.code, one.email).to.be.a('string')
        const session = await ask('POST', '/auth/email-code/verify', null, {
          email: one.email,
          code: sent?.code
        })
        expect(session.status, one.email).equals(200)
        expect(session.body.user.id).equals(one.userId)
        const teams = await ask('GET', '/teams', session.body.token)
        expect(teams.body.map((team: any) => team.id)).includes(one.teamId)
      }
    })
  })

  describe('PUT /teams/:teamId/logo and /teams/:teamId/players/:userId/avatar', function () {
    let dir = ''
    let red = ''
    let blue = ''
    let green = ''
    let jpeg = ''

    before(async function () {
      dir = await mkdtemp(join(tmpdir(), 'tsTeamPictures-'))
      red = await picture('red', 'png', 320, 180)
      blue = await picture('blue', 'png', 200, 200)
      green = await picture('green', 'png', 64, 64)
      jpeg = await picture('orange', 'jpg', 300, 300)
    })

    after(async function () {
      await rm(dir, { recursive: true, force: true })
    })

    /** A flat square of one colour, as base64. */
    async function picture(
      colour: string,
      extension: 'png' | 'jpg',
      width: number,
      height: number
    ): Promise<string> {
      const path = join(dir, `${colour}.${extension}`)
      await run(FFMPEG, [
        '-hide_banner',
        '-loglevel',
        'error',
        '-y',
        '-f',
        'lavfi',
        '-i',
        `color=c=${colour}:size=${width}x${height}`,
        '-frames:v',
        '1',
        path
      ])
      return (await readFile(path)).toString('base64')
    }

    const body = (
      base64: string,
      source: 'import' | 'upload' = 'import',
      contentType = 'image/png'
    ): unknown => ({ image: { contentType, base64 }, source })

    const logo = async (
      teamId: string,
      sent: unknown,
      token: string | null = ADMIN
    ): Promise<Answer> => await ask('PUT', `/teams/${teamId}/logo`, token, sent)

    const avatar = async (
      teamId: string,
      userId: number | string,
      sent: unknown,
      token: string | null = ADMIN
    ): Promise<Answer> =>
      await ask('PUT', `/teams/${teamId}/players/${userId}/avatar`, token, sent)

    /** A team with one player on it, by external id. */
    async function teamWithPlayer(
      name: string
    ): Promise<{ teamId: string; userId: number }> {
      const teamId = await newTeam(name)
      const answer = await ask('POST', `/teams/${teamId}/players`, ADMIN, {
        players: [
          { firstName: 'Pic', lastName: name, externalId: ext(`pic-${teamId}`) }
        ]
      })
      return { teamId, userId: answer.body.results[0].userId }
    }

    /** Width and height, read back out of the PNG header. */
    const pngSize = (bytes: Buffer): { width: number; height: number } => ({
      width: bytes.readUInt32BE(16),
      height: bytes.readUInt32BE(20)
    })

    it('stores a logo at both sizes and writes its row', async function () {
      const teamId = await newTeam('Logo')
      const before = puts.length
      const answer = await logo(teamId, body(red))
      expect(answer.status).equals(200)
      expect(answer.body.stored).equals(true)
      const row = await database()
        .selectFrom('teams')
        .select(['logo_path', 'logo_sha256', 'logo_source', 'logo_updated_at'])
        .where('id', '=', teamId)
        .executeTakeFirstOrThrow()
      expect(row.logo_path).matches(
        new RegExp(`^images/team/${teamId}/[0-9a-f]{8}$`)
      )
      expect(row.logo_sha256).matches(/^[0-9a-f]{64}$/)
      expect(row.logo_source).equals('import')
      expect(row.logo_updated_at).not.equals(null)
      expect(puts.slice(before).sort((a, b) => a.localeCompare(b))).deep.equals(
        [
          `/${BUCKET}/${row.logo_path}-192.png`,
          `/${BUCKET}/${row.logo_path}-96.png`
        ]
      )

      // The URL is the signed 192 px rendition, and it is one.
      expect(answer.body.url).includes(`${row.logo_path}-192.png`)
      expect(answer.body.url).includes('X-Amz-Signature=')
      const drawn = await fetch(answer.body.url)
      expect(drawn.status).equals(200)
      expect(pngSize(Buffer.from(await drawn.arrayBuffer()))).deep.equals({
        width: 192,
        height: 192
      })

      const teams = await ask('GET', '/teams', ADMIN)
      const listed = teams.body.find((team: any) => team.id === teamId)
      expect(listed.logoUrl).to.be.a('string')
    })

    it('stores a headshot and the roster shows it', async function () {
      const { teamId, userId } = await teamWithPlayer('Avatar')
      const answer = await avatar(
        teamId,
        userId,
        body(jpeg, 'import', 'image/jpeg')
      )
      expect(answer.status).equals(200)
      expect(answer.body.stored).equals(true)
      const row = await database()
        .selectFrom('users')
        .select([
          'avatar_path',
          'avatar_sha256',
          'avatar_source',
          'avatar_updated_at'
        ])
        .where('id', '=', userId)
        .executeTakeFirstOrThrow()
      expect(row.avatar_path).matches(
        new RegExp(`^images/user/${userId}/[0-9a-f]{8}$`)
      )
      expect(row.avatar_sha256).matches(/^[0-9a-f]{64}$/)
      expect(row.avatar_source).equals('import')
      expect(row.avatar_updated_at).not.equals(null)
      expect(answer.body.url).includes(`${row.avatar_path}-192.png`)
      const roster = await ask('GET', `/teams/${teamId}/roster`, ADMIN)
      expect(roster.body[0].avatarUrl).to.be.a('string')
    })

    it('uploads nothing for the picture it already holds', async function () {
      const { teamId, userId } = await teamWithPlayer('Same')
      expect((await logo(teamId, body(blue))).body.stored).equals(true)
      expect((await avatar(teamId, userId, body(blue))).body.stored).equals(
        true
      )
      const before = puts.length
      expect((await logo(teamId, body(blue))).body).deep.equals({
        stored: false
      })
      expect((await avatar(teamId, userId, body(blue))).body).deep.equals({
        stored: false
      })
      expect(puts.length).equals(before)
    })

    it('never lets an import replace an upload, and lets an upload replace an import', async function () {
      const uploaded = await newTeam('Uploaded')
      expect((await logo(uploaded, body(red, 'upload'))).body.stored).equals(
        true
      )
      expect((await logo(uploaded, body(blue, 'import'))).body).deep.equals({
        stored: false,
        kept: 'upload'
      })

      const imported = await newTeam('Imported')
      expect((await logo(imported, body(red, 'import'))).body.stored).equals(
        true
      )
      expect((await logo(imported, body(blue, 'upload'))).body.stored).equals(
        true
      )
      const row = await database()
        .selectFrom('teams')
        .select(['logo_source'])
        .where('id', '=', imported)
        .executeTakeFirstOrThrow()
      expect(row.logo_source).equals('upload')
    })

    it('lets only a site administrator upload over an uploaded headshot, and any administrator over an uploaded logo', async function () {
      const { teamId, userId } = await teamWithPlayer('Uploaded faces')
      expect(
        (await avatar(teamId, userId, body(red, 'upload'), SEASON_ADMIN)).body
          .stored
      ).equals(true)
      expect(
        (await avatar(teamId, userId, body(blue, 'upload'), SEASON_ADMIN)).body
      ).deep.equals({ stored: false, kept: 'upload' })
      const kept = await database()
        .selectFrom('users')
        .select(['avatar_sha256'])
        .where('id', '=', userId)
        .executeTakeFirstOrThrow()
      expect(
        (await avatar(teamId, userId, body(blue, 'upload'))).body.stored
      ).equals(true)
      const replaced = await database()
        .selectFrom('users')
        .select(['avatar_sha256'])
        .where('id', '=', userId)
        .executeTakeFirstOrThrow()
      expect(replaced.avatar_sha256).not.equals(kept.avatar_sha256)

      expect(
        (await logo(teamId, body(red, 'upload'), SEASON_ADMIN)).body.stored
      ).equals(true)
      expect(
        (await logo(teamId, body(blue, 'upload'), SEASON_ADMIN)).body.stored
      ).equals(true)
    })

    it('keeps an upload that lands while an import is being stored', async function () {
      const { teamId, userId } = await teamWithPlayer('Raced pictures')
      const cases = [
        {
          send: async (sent: unknown) => await logo(teamId, sent),
          source: async () =>
            await database()
              .selectFrom('teams')
              .select(['logo_source as source', 'logo_sha256 as sha256'])
              .where('id', '=', teamId)
              .executeTakeFirstOrThrow()
        },
        {
          send: async (sent: unknown) => await avatar(teamId, userId, sent),
          source: async () =>
            await database()
              .selectFrom('users')
              .select(['avatar_source as source', 'avatar_sha256 as sha256'])
              .where('id', '=', userId)
              .executeTakeFirstOrThrow()
        }
      ]
      for (const { send, source } of cases) {
        let release = (): void => {}
        let arrived = (): void => {}
        const waiting = new Promise<void>(resolve => {
          arrived = resolve
        })
        holdNext = {
          arrived,
          release: new Promise<void>(resolve => {
            release = resolve
          })
        }
        // The import has read the row and is storing its picture...
        const importing = send(body(red, 'import'))
        await waiting
        // ...when an upload lands.
        const uploaded = await send(body(blue, 'upload'))
        expect(uploaded.body.stored).equals(true)
        const after = await source()
        release()
        expect((await importing).body).deep.equals({
          stored: false,
          kept: 'upload'
        })
        expect(await source()).deep.equals(after)
        expect(after.source).equals('upload')
      }
    })

    it('makes an import its uploader’s own when the same picture is uploaded', async function () {
      const { teamId, userId } = await teamWithPlayer('Claimed')
      await avatar(teamId, userId, body(green, 'import'))
      expect(
        (await avatar(teamId, userId, body(green, 'upload'))).body
      ).deep.equals({
        stored: false
      })
      expect(
        (await avatar(teamId, userId, body(red, 'import'))).body
      ).deep.equals({
        stored: false,
        kept: 'upload'
      })
    })

    it('refuses what is not a picture it can take', async function () {
      const teamId = await newTeam('Refusals')
      const gif = await logo(teamId, body(red, 'import', 'image/gif'))
      expect(gif.status).equals(415)
      expect(gif.body.code).equals('unsupportedMedia')

      // Ten MiB and three bytes of zeros, as base64.
      const over = 'A'.repeat(4 * Math.ceil((10 * 1024 * 1024 + 3) / 3))
      const heavy = await logo(teamId, body(over))
      expect(heavy.status).equals(413)
      expect(heavy.body.code).equals('tooLarge')
      // Exactly ten MiB: read to the end and handed to FFmpeg, which finds
      // no picture behind a PNG signature and zeros. Never a 500 for the
      // length of the string.
      const under = Buffer.alloc(10 * 1024 * 1024)
      PNG_SIGNATURE.copy(under)
      const zeros = await logo(teamId, body(under.toString('base64')))
      expect(zeros.status).equals(415)
      expect(zeros.body.message).equals(
        'That is not a picture TeamStation can read'
      )

      for (const base64 of [
        '',
        'not base64!',
        'abcde',
        'ab=c',
        '====',
        'a==='
      ]) {
        const answer = await logo(teamId, body(base64))
        expect(answer.status, base64).equals(400)
        expect(answer.body.message).equals('image.base64 is not base64')
      }

      const text = Buffer.from('this is a text file, not a picture')
      const untyped = await logo(teamId, body(text.toString('base64')))
      expect(untyped.status).equals(415)
      expect(untyped.body.message).equals(
        'The picture is not the type it says it is'
      )
      const unreadable = await logo(
        teamId,
        body(Buffer.concat([PNG_SIGNATURE, text]).toString('base64'))
      )
      expect(unreadable.status).equals(415)
      expect(unreadable.body).deep.equals({
        code: 'unsupportedMedia',
        message: 'That is not a picture TeamStation can read'
      })

      expect((await logo(teamId, { image: body(red) })).status).equals(400)
      expect(
        (await logo(teamId, { source: 'import', image: 'x' })).status
      ).equals(400)
      expect((await logo(teamId, null)).status).equals(400)
    })

    it('refuses a picture that is not the type it says it is', async function () {
      const teamId = await newTeam('Mislabelled')
      for (const [base64, contentType] of [
        [red, 'image/jpeg'],
        [red, 'image/webp'],
        [jpeg, 'image/png'],
        [WEBP, 'image/png'],
        // RIFF, but not WebP inside it.
        [
          Buffer.from('RIFF\x10\x00\x00\x00WAVEfmt ').toString('base64'),
          'image/webp'
        ]
      ]) {
        const answer = await logo(teamId, body(base64, 'import', contentType))
        expect(answer.status, contentType).equals(415)
        expect(answer.body).deep.equals({
          code: 'unsupportedMedia',
          message: 'The picture is not the type it says it is'
        })
      }
      const row = await database()
        .selectFrom('teams')
        .select(['logo_path'])
        .where('id', '=', teamId)
        .executeTakeFirstOrThrow()
      expect(row.logo_path).equals(null)
    })

    it('takes a JPEG, a PNG and a WebP that are what they say', async function () {
      for (const [base64, contentType] of [
        [jpeg, 'image/jpeg'],
        [red, 'image/png'],
        [WEBP, 'image/webp']
      ]) {
        const teamId = await newTeam(`Typed ${contentType}`)
        const answer = await logo(teamId, body(base64, 'import', contentType))
        expect(answer.status, contentType).equals(200)
        expect(answer.body.stored, contentType).equals(true)
      }
    })

    it('answers 404 for a headshot of somebody who does not play for the team', async function () {
      const { teamId } = await teamWithPlayer('Not a player')
      expect((await avatar(teamId, member.userId, body(red))).status).equals(
        404
      )
      expect((await avatar(teamId, 'nobody', body(red))).status).equals(404)
    })

    it('answers 503 with no Space, and when the Space refuses the upload', async function () {
      const { teamId, userId } = await teamWithPlayer('Unavailable')
      const bare = await ask(
        'PUT',
        `/teams/${teamId}/logo`,
        ADMIN,
        body(red),
        '/bare/api/v1'
      )
      expect(bare.status).equals(503)
      expect(bare.body.code).equals('unavailable')

      refusing = true
      try {
        const refused = await avatar(teamId, userId, body(red))
        expect(refused.status).equals(503)
        expect(refused.body).deep.equals({
          code: 'unavailable',
          message: 'The picture store did not answer'
        })
      } finally {
        refusing = false
      }
    })

    it('answers 401, 403 and 404 as the roster routes do', async function () {
      const { userId } = await teamWithPlayer('Guarded')
      expect((await logo(hawks, body(red), null)).status).equals(401)
      expect((await logo(hawks, body(red), MEMBER)).status).equals(403)
      expect((await logo(hawks, body(red), STRANGER)).status).equals(404)
      expect((await avatar(hawks, userId, body(red), MEMBER)).status).equals(
        403
      )
      expect((await avatar(hawks, userId, body(red), STRANGER)).status).equals(
        404
      )
      expect((await logo('tem_nothere', body(red))).status).equals(404)
    })

    it('lets an administrator of the team’s season or league store its pictures', async function () {
      const { teamId, userId } = await teamWithPlayer('Season pictures')
      const bySeason = await logo(teamId, body(blue), SEASON_ADMIN)
      expect(bySeason.status).equals(200)
      expect(bySeason.body.stored).equals(true)
      const byLeague = await avatar(teamId, userId, body(blue), LEAGUE_ADMIN)
      expect(byLeague.status).equals(200)
      expect(byLeague.body.stored).equals(true)
    })

    it('parses a 2 MB picture body, and answers 413 to one anywhere else', async function () {
      const teamId = await newTeam('Big bodies')
      const twoMegabytes = 'A'.repeat(2_100_000)
      // Parsed and read: zeros are no PNG.
      const parsed = await logo(teamId, body(twoMegabytes))
      expect(parsed.status).equals(415)
      const elsewhere = await ask(
        'PUT',
        `/teams/${teamId}/roster`,
        ADMIN,
        body(twoMegabytes)
      )
      expect(elsewhere.status).equals(413)
      expect(elsewhere.body.code).equals('tooLarge')
      const posted = await ask(
        'POST',
        `/teams/${teamId}/logo`,
        ADMIN,
        body(twoMegabytes)
      )
      expect(posted.status).equals(413)
    })
  })
})
