import { mkdtempSync } from 'node:fs'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { expect } from 'chai'
import express from 'express'
import type { Kysely } from 'kysely'
import { after, before, describe, it } from 'mocha'
import { Pool } from 'pg'

import { makeId } from '../../common/ids'
import { migrations } from '../../migrate/migrations'
import { migrateUp } from '../../migrate/runner'
import { testDatabaseUrl } from '../../migrate/testDatabase'
import { canSeePerson, openablePeople, visibleScopes } from '../access'
import { hashToken } from '../auth/tokens'
import type { Database } from '../db/database'
import { makeDatabase } from '../db/database'
import { jsonBody } from '../jsonBody'
import type { MediaContext } from '../media/mediaContext'
import { withActor } from '../middleware/withAuth'
import { errorHandler } from '../middleware/withErrors'
import { playerRoutes, teamsOf } from '../routes/players'
import { statsRoutes } from '../routes/stats'
import { teamRoutes } from '../routes/teams'
import { ensureGumboId, insertUser } from '../users/insertUser'
import { addExistingGuest } from './guestPlayers'

/**
 * Playing as a pool player shows on the team's figures and opens the
 * player's page to nobody who could not open it before.
 *
 * Freddie Freeman plays for the Owls. He plays one game for the Herons as a
 * pool player and gets a hit. A Heron cannot see him; an Owl can.
 */
const adminUrl = testDatabaseUrl
const scratchName = `teamstation_poolvis_${process.pid}_${Date.now()}`
const scratchUrl = adminUrl.replace(/\/[^/]*$/, `/${scratchName}`)

const HERON = 'tok_poolvis_heron_000000000000000000'
const OWL = 'tok_poolvis_owl_00000000000000000000'
const TEAM = {
  falcons: 'tem_poolFalcons',
  herons: 'tem_poolHerons',
  owls: 'tem_poolOwls'
}
const SEASON = 'sea_poolFall'
const GAME = 'gam_poolGame'

describe('a pool player and who may open their page', function () {
  this.timeout(60000)

  let adminPool: Pool | undefined
  let db: Kysely<Database> | undefined
  let server: ReturnType<express.Express['listen']> | undefined
  let base = ''
  const ids: Record<string, string> = {}

  async function person(name: string, login = false): Promise<string> {
    const [first, ...rest] = name.split(' ')
    const userId = await insertUser(db!, {
      display_name: name,
      first_name: first,
      last_name: rest.join(' '),
      login_enabled: login
    })
    await ensureGumboId(db!, userId)
    ids[name] = userId
    return userId
  }
  async function member(
    userId: string,
    teamId: string,
    isPlayer: boolean
  ): Promise<void> {
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
  }
  async function get(
    token: string,
    path: string
  ): Promise<{ status: number; body: any }> {
    const response = await fetch(`${base}${path}`, {
      headers: { authorization: `Bearer ${token}` }
    })
    return { status: response.status, body: await response.json() }
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
    const d = db
    await d
      .insertInto('leagues')
      .values({ id: 'lea_pool', name: 'Ridgeview' })
      .execute()
    await d
      .insertInto('seasons')
      .values({
        id: SEASON,
        league_id: 'lea_pool',
        name: 'Fall',
        year: 2026,
        starts_on: '2026-01-01',
        ends_on: '2099-12-31'
      })
      .execute()
    await d
      .insertInto('teams')
      .values([
        { id: TEAM.falcons, name: 'Ridgeview Falcons' },
        { id: TEAM.herons, name: 'Lakeside Herons' },
        { id: TEAM.owls, name: 'Ridgeview Owls' }
      ])
      .execute()
    await d
      .insertInto('season_teams')
      .values([
        { season_id: SEASON, team_id: TEAM.falcons },
        { season_id: SEASON, team_id: TEAM.herons }
      ])
      .execute()
    const scorer = await person('Oliver Marmol', true)
    await d
      .insertInto('scope_roles')
      .values({
        id: makeId('scopeRole'),
        user_id: scorer,
        scope_type: 'team',
        scope_id: TEAM.herons,
        role: 'scorekeeper'
      })
      .execute()
    const heron = await person('Heron Fan', true)
    await member(heron, TEAM.herons, false)
    await d
      .insertInto('season_members')
      .values({
        id: makeId('seasonMember'),
        user_id: heron,
        season_id: SEASON
      })
      .execute()
    const owl = await person('Owl Fan', true)
    await member(owl, TEAM.owls, false)
    const freeman = await person('Freddie Freeman', true)
    await member(freeman, TEAM.owls, true)
    const helsley = await person('Ryan Helsley')
    await member(helsley, TEAM.herons, true)
    await d
      .insertInto('games')
      .values({
        id: GAME,
        home_team_id: TEAM.falcons,
        away_team_id: TEAM.herons,
        season_id: SEASON,
        start_at: new Date(),
        status: 'scheduled'
      })
      .execute()
    // Freeman decides for himself (no guardian), and is told.
    await addExistingGuest(
      d,
      { userId: scorer, isAdmin: false, scopes: [] },
      GAME,
      'away',
      { userId: freeman, jersey: '5', positions: ['1B'] }
    )
    for (const name of ['Freddie Freeman', 'Ryan Helsley'])
      await d
        .insertInto('game_player_stats')
        .values({
          id: makeId('gamePlayerStats'),
          game_id: GAME,
          gumbo_id: await ensureGumboId(d, ids[name]),
          team_id: TEAM.herons,
          pa: 3,
          ab: 3,
          h: 1,
          singles: 1
        })
        .execute()
    await d
      .insertInto('auth_sessions')
      .values(
        [
          [HERON, heron],
          [OWL, owl]
        ].map(([token, userId]) => ({
          id: makeId('authSession'),
          user_id: userId,
          token_hash: hashToken(token),
          created_at: new Date(),
          expires_at: new Date(Date.now() + 3_600_000)
        }))
      )
      .execute()

    const media: MediaContext = {
      mediaRoot: mkdtempSync(join(tmpdir(), 'tsPoolVis-')),
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
    app.use('/api/v1', playerRoutes(db, media))
    app.use('/api/v1', teamRoutes(db, media))
    app.use('/api/v1', statsRoutes(db, media))
    app.use(errorHandler)
    server = app.listen(0, '127.0.0.1')
    await new Promise<void>(resolve => server?.once('listening', resolve))
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/v1`
  })

  after(async function () {
    const listening = server
    if (listening != null)
      await new Promise(resolve => listening.close(resolve))
    if (db != null) await db.destroy()
    if (adminPool != null) {
      await adminPool.query(
        `drop database if exists ${scratchName} with (force)`
      )
      await adminPool.end()
    }
  })

  it('counts the pool game for the team and opens the page to nobody new', async function () {
    const freeman = ids['Freddie Freeman']
    const teams = await teamsOf(db!, [freeman])
    expect(
      teams
        .map(team => [team.teamId, team.viaPool])
        .sort((a, b) => String(a[0]).localeCompare(String(b[0])))
    ).deep.equals([
      [TEAM.herons, true],
      [TEAM.owls, undefined]
    ])
    // A Heron cannot open him, an Owl still can.
    expect((await get(HERON, `/players/${freeman}`)).status).equals(404)
    expect((await get(OWL, `/players/${freeman}`)).status).equals(200)

    // His line shows and counts on the box score and the season's table,
    // and opens his page only where it could be opened anyway.
    const box = await get(HERON, `/games/${GAME}/box-score`)
    expect(
      box.body.batting
        .map((row: any) => [row.shortName, row.openable])
        .sort((a: any, b: any) => String(a[0]).localeCompare(String(b[0])))
    ).deep.equals([
      ['Freddie F', false],
      ['Ryan H', true]
    ])
    const season = await get(HERON, `/seasons/${SEASON}/stats`)
    const line = season.body.batting.find((row: any) => row.userId === freeman)
    expect(line).to.include({ h: 1, openable: false })
    // The team's own table carries his line too.
    const team = await get(HERON, `/teams/${TEAM.herons}/stats`)
    expect(team.body.map((row: any) => row.userId)).includes(freeman)
  })

  it('agrees with canSeePerson, and lets a player who joins the team be seen as before', async function () {
    const freeman = ids['Freddie Freeman']
    const heron = ids['Heron Fan']
    const scopes = await visibleScopes(db!, heron, false)
    const seen = await openablePeople(db!, scopes, heron, [
      freeman,
      ids['Ryan Helsley'],
      heron
    ])
    expect([...seen].sort()).deep.equals([ids['Ryan Helsley'], heron].sort())
    expect(canSeePerson(scopes, false, await teamsOf(db!, [freeman]))).equals(
      false
    )
    // Nobody to see: nothing to ask.
    expect([...(await openablePeople(db!, scopes, heron, []))]).deep.equals([])
    // A merged player's membership sits on the row merged into them.
    const closed = await person('Closed Row', true)
    await member(closed, TEAM.herons, true)
    const kept = await person('Kept Row', true)
    await db!
      .updateTable('users')
      .set({ merged_into: kept })
      .where('id', '=', closed)
      .execute()
    expect([...(await openablePeople(db!, scopes, heron, [kept]))]).deep.equals(
      [kept]
    )
    // A pool line under a closed row, with the details on the row it joined.
    const old_ = ids['Freddie Freeman']
    const survivor = await person('Freddie Kept', true)
    await db!
      .updateTable('users')
      .set({ merged_into: survivor })
      .where('id', '=', old_)
      .execute()
    await db!
      .updateTable('game_guest_details')
      .set({ user_id: survivor })
      .where('user_id', '=', old_)
      .execute()
    expect([
      ...(await openablePeople(db!, scopes, heron, [survivor]))
    ]).deep.equals([])
    await db!
      .updateTable('game_guest_details')
      .set({ user_id: old_ })
      .where('user_id', '=', survivor)
      .execute()
    await db!
      .updateTable('users')
      .set({ merged_into: null })
      .where('id', '=', old_)
      .execute()
    const outsider = await person('Out Sider', true)
    expect([
      ...(await openablePeople(
        db!,
        await visibleScopes(db!, outsider, false),
        outsider,
        [freeman, outsider]
      ))
    ]).deep.equals([outsider])
    // A parent on the Herons is no player there: a Heron does not open them
    // from a game they played, as their page would not open either.
    const other = await person('Heron Two', true)
    await member(other, TEAM.herons, false)
    expect([
      ...(await openablePeople(
        db!,
        await visibleScopes(db!, other, false),
        other,
        [ids['Heron Fan'], ids['Ryan Helsley']]
      ))
    ]).deep.equals([ids['Ryan Helsley']])
    expect((await get(HERON, `/players/${ids['Ryan Helsley']}`)).status).equals(
      200
    )
    // His guardian opens his line from any team, as his page lets them.
    const guardian = await person('Freeman Guardian', true)
    await db!
      .insertInto('user_links')
      .values({
        id: makeId('userLink'),
        user_id: guardian,
        related_user_id: freeman,
        kind: 'guardian',
        can_manage: true
      })
      .execute()
    expect([
      ...(await openablePeople(
        db!,
        await visibleScopes(db!, guardian, false),
        guardian,
        [freeman, ids['Ryan Helsley']]
      ))
    ]).deep.equals([freeman])
    await member(freeman, TEAM.herons, true)
    expect((await get(HERON, `/players/${freeman}`)).status).equals(200)
    expect(
      (await teamsOf(db!, [freeman])).find(team => team.teamId === TEAM.herons)
        ?.viaPool
    ).equals(undefined)
  })
})
