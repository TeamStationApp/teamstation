import { mkdtempSync } from 'node:fs'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { expect } from 'chai'
import express from 'express'
import { Kysely, PostgresDialect } from 'kysely'
import { after, before, describe, it } from 'mocha'
import { Pool } from 'pg'

import { makeId } from '../../common/ids'
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
import { teamRoutes } from '../routes/teams'
import { teamRoster } from '../teams/teamRoster'
import { ensureGumboId, insertUser } from '../users/insertUser'
import { addExistingGuest, createGuestPlayer } from './guestPlayers'
import { gameAvailability } from './rosterAvailability'

/**
 * `GET /games/:gameId` answers the game's guests, unrostered players and
 * guest lines without building either team's roster; the lineup writers still
 * ask for both rosters and get them.
 *
 * The Herons visit the Falcons. Oliver Marmol scores for the Herons. Freddie
 * Freeman, an Owl, plays for the Herons as a pool player; a new guest plays
 * for the Falcons; Jordan Walker sits this one out.
 */
const adminUrl = testDatabaseUrl
const scratchName = `teamstation_availability_${process.pid}_${Date.now()}`
const scratchUrl = adminUrl.replace(/\/[^/]*$/, `/${scratchName}`)

const SCORER = 'tok_availability_scorer_000000000000'
const TEAM = {
  falcons: 'tem_availFalcons',
  herons: 'tem_availHerons',
  owls: 'tem_availOwls'
}
const GAME = 'gam_availGame'
/**
 * The member query `teamRoster` starts from: the route's own access reads
 * join the same tables, but none selects a member's jersey.
 */
const memberJoin = (text: string): boolean =>
  text.includes('from "memberships" inner join "users"') &&
  text.includes('"memberships"."jersey"')

describe('a game’s availability', function () {
  this.timeout(60000)

  let adminPool: Pool | undefined
  let db: Kysely<Database> | undefined
  const ids: Record<string, string> = {}
  const gumbo: Record<string, number> = {}
  let media: MediaContext | undefined

  async function person(
    name: string,
    teamId?: string,
    isPlayer = true
  ): Promise<string> {
    const [first, ...rest] = name.split(' ')
    const userId = await insertUser(db!, {
      display_name: name,
      first_name: first,
      last_name: rest.join(' '),
      bats: 'right',
      throws: 'right',
      login_enabled: true
    })
    gumbo[name] = await ensureGumboId(db!, userId)
    ids[name] = userId
    if (teamId != null)
      await db!
        .insertInto('memberships')
        .values({
          id: makeId('membership'),
          user_id: userId,
          team_id: teamId,
          role: 'member',
          is_player: isPlayer
        })
        .execute()
    return userId
  }

  /** The game read through its route, on a database that logs each statement. */
  async function readGame(): Promise<{
    status: number
    body: any
    statements: string[]
  }> {
    const statements: string[] = []
    const pool = new Pool({ connectionString: scratchUrl })
    const logged = new Kysely<Database>({
      dialect: new PostgresDialect({ pool }),
      log: event => {
        if (event.level === 'query') statements.push(event.query.sql)
      }
    })
    const app = express()
    app.use(jsonBody)
    app.use(withActor(logged))
    app.use('/api/v1', teamRoutes(logged, media!))
    app.use(errorHandler)
    const server = app.listen(0, '127.0.0.1')
    await new Promise<void>(resolve => server.once('listening', resolve))
    try {
      const { port } = server.address() as AddressInfo
      const response = await fetch(
        `http://127.0.0.1:${port}/api/v1/games/${GAME}`,
        { headers: { authorization: `Bearer ${SCORER}` } }
      )
      return {
        status: response.status,
        body: await response.json(),
        statements
      }
    } finally {
      await new Promise(resolve => server.close(resolve))
      await logged.destroy()
    }
  }

  async function gameRow(): Promise<Parameters<typeof gameAvailability>[1]> {
    return await db!
      .selectFrom('games')
      .selectAll()
      .where('id', '=', GAME)
      .executeTakeFirstOrThrow()
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
    try {
      await migrateUp(pool, migrations)
    } finally {
      await pool.end()
    }
    db = makeDatabase(scratchUrl)
    await db
      .insertInto('teams')
      .values([
        { id: TEAM.falcons, name: 'Ridgeview Falcons' },
        { id: TEAM.herons, name: 'Lakeside Herons' },
        { id: TEAM.owls, name: 'Ridgeview Owls' }
      ])
      .execute()
    // An Owls parent too, so Freeman is somebody he knows: his add applies at
    // once, with a notice.
    const scorer = await person('Oliver Marmol', TEAM.owls, false)
    await db
      .insertInto('scope_roles')
      .values({
        id: makeId('scopeRole'),
        user_id: scorer,
        scope_type: 'team',
        scope_id: TEAM.herons,
        role: 'scorekeeper'
      })
      .execute()
    await db
      .insertInto('auth_sessions')
      .values({
        id: makeId('authSession'),
        user_id: scorer,
        token_hash: hashToken(SCORER),
        created_at: new Date(),
        expires_at: new Date(Date.now() + 3_600_000)
      })
      .execute()
    await person('Ryan Helsley', TEAM.herons)
    await person('Jordan Walker', TEAM.herons)
    await person('Heron Parent', TEAM.herons, false)
    await person('Paul Goldschmidt', TEAM.falcons)
    await person('Freddie Freeman', TEAM.owls)
    await db
      .insertInto('games')
      .values({
        id: GAME,
        home_team_id: TEAM.falcons,
        away_team_id: TEAM.herons,
        start_at: new Date(),
        status: 'scheduled',
        unrostered: { [TEAM.herons]: [gumbo['Jordan Walker']] }
      })
      .execute()
    const actor = { userId: scorer, isAdmin: false, scopes: [] }
    const freddie = await addExistingGuest(db, actor, GAME, 'away', {
      userId: ids['Freddie Freeman'],
      jersey: '5',
      positions: ['1B']
    })
    if (freddie.kind !== 'added') throw new Error('Freddie was not added')
    expect(freddie.entry).not.have.property('publicName')
    const guest = await createGuestPlayer(db, actor, GAME, 'home', {
      firstName: 'Nolan',
      lastName: 'Arenado',
      jersey: '28',
      positions: ['3B'],
      bats: 'right',
      throws: 'right'
    })
    gumbo['Nolan Arenado'] = guest.gumboId!

    media = {
      mediaRoot: mkdtempSync(join(tmpdir(), 'tsAvailability-')),
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
  })

  after(async function () {
    if (db != null) await db.destroy()
    if (adminPool != null) {
      await adminPool.query(
        `drop database if exists ${scratchName} with (force)`
      )
      await adminPool.end()
    }
  })

  it('answers GET /games/:gameId without reading either roster', async function () {
    const { status, body, statements } = await readGame()
    expect(status).equals(200)
    // The statement log is live: the game itself was read through it.
    expect(statements.some(text => text.includes('from "games"'))).equals(true)
    expect(statements.filter(memberJoin)).deep.equals([])
    expect(body.guests).deep.equals({
      away: [gumbo['Freddie Freeman']],
      home: [gumbo['Nolan Arenado']]
    })
    expect(body.unrostered).deep.equals({
      away: [gumbo['Jordan Walker']],
      home: []
    })
    expect(
      (['away', 'home'] as const).map(side =>
        body.guestPlayers[side].map((row: any) => [
          row.shortName,
          row.jersey,
          row.positions,
          row.pool ?? false
        ])
      )
    ).deep.equals([
      [['Freddie F', '5', ['1B'], true]],
      [['Nolan A', '28', ['3B'], false]]
    ])
    // The same lists the roster-building read gives the lineup writers.
    const rostered = await gameAvailability(db!, await gameRow(), {
      roster: true
    })
    expect(body.guests).deep.equals(rostered.guests)
    expect(body.unrostered).deep.equals(rostered.unrostered)
    // As sent: the entries' unset fields are not in the body.
    expect(body.guestPlayers).deep.equals(
      JSON.parse(JSON.stringify(rostered.guestPlayers))
    )
  })

  it('builds both rosters only when asked', async function () {
    const game = await gameRow()
    const statements: string[] = []
    const logged = new Kysely<Database>({
      dialect: new PostgresDialect({
        pool: new Pool({ connectionString: scratchUrl })
      }),
      log: event => {
        if (event.level === 'query') statements.push(event.query.sql)
      }
    })
    let bare: Awaited<ReturnType<typeof gameAvailability<false>>>
    let rostered: Awaited<ReturnType<typeof gameAvailability<true>>>
    try {
      bare = await gameAvailability(logged, game, { roster: false })
      expect(statements.filter(memberJoin)).length(0)
      rostered = await gameAvailability(logged, game, { roster: true })
      // One member read for each team.
      expect(statements.filter(memberJoin)).length(2)
    } finally {
      await logged.destroy()
    }
    expect(bare.roster).equals(null)
    expect(rostered.roster).deep.equals({
      away: await teamRoster(db!, undefined, TEAM.herons),
      home: await teamRoster(db!, undefined, TEAM.falcons)
    })
    expect(
      rostered.roster.away.filter(row => row.isPlayer).map(row => row.gumboId)
    ).to.have.members([gumbo['Ryan Helsley'], gumbo['Jordan Walker']])
    expect(rostered.roster.home.map(row => row.gumboId)).includes(
      gumbo['Paul Goldschmidt']
    )
    // Everything but the roster is the same either way.
    const { roster: _, ...rest } = rostered
    expect({ ...bare, roster: undefined }).deep.equals({
      ...rest,
      roster: undefined
    })
  })
})
