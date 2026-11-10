import { expect } from 'chai'
import express from 'express'
import { Kysely, PostgresDialect, sql } from 'kysely'
import { after, before, beforeEach, describe, it } from 'mocha'
import { Pool } from 'pg'

import { userIdOfGumbo } from '../common/userId'
import { migrations } from '../migrate/migrations'
import { migrateUp } from '../migrate/runner'
import { dropScratchDatabase, testDatabaseUrl } from '../migrate/testDatabase'
import { insertFixtureUsers } from '../test/insertFixtureUsers'
import type { Database } from './db/database'
import { attachInt8Parser } from './db/int8'
import { currentFormats, lentPlayers } from './groups/playerNamePrivacy'
import type { MediaContext } from './media/mediaContext'
import { errorHandler } from './middleware/withErrors'
import { openAddsOf, openAddTeams } from './openAdds'
import { teamRoutes } from './routes/teams'
import { teamRoster } from './teams/teamRoster'

/**
 * A team's open holds and lent players, read for more ids than a statement
 * has parameters (65535): each statement binds one array however many ids it
 * is given.
 */

const media: MediaContext = {
  ffmpegPath: 'ffmpeg',
  mediaRoot: '/tmp',
  mediaSecret: 'synthetic',
  publicUrl: 'http://example.com',
  space: {
    endpoint: '',
    region: '',
    bucket: '',
    accessKeyId: '',
    secretAccessKey: '',
    pathStyle: false
  }
}

/** More than a statement's 65535 parameters. */
const MANY = 70_000
const FIRST_GUMBO = 5_000_000

const ADMIN = userIdOfGumbo(4_000_001)
const OWN = userIdOfGumbo(4_000_002)
/** The lent players: held by an open add and guests of the team's game. */
const bulk = Array.from({ length: MANY }, (_, i) =>
  userIdOfGumbo(FIRST_GUMBO + i)
)
/** Ids nobody has, to make a small set many. */
const padding = (count: number, prefix: string): string[] =>
  Array.from({ length: count }, (_, i) => `${prefix}_${i}`)

describe('open holds over more ids than a statement has parameters', function () {
  this.timeout(120_000)
  const name = `teamstation_openaddslimit_${Date.now()}`
  const scratchUrl = testDatabaseUrl.replace(/\/[^/]*$/, `/${name}`)
  let admin: Pool
  let db: Kysely<Database>
  /** Each statement's bound parameters, since the last `beforeEach`. */
  let bound: number[] = []
  const most = (): number => Math.max(...bound)

  before(async function () {
    attachInt8Parser()
    admin = new Pool({ connectionString: testDatabaseUrl })
    await admin.query(`create database ${name}`)
    const pool = new Pool({ connectionString: scratchUrl })
    await migrateUp(pool, migrations)
    db = new Kysely<Database>({
      dialect: new PostgresDialect({ pool }),
      log: event => {
        bound.push(event.query.parameters.length)
      }
    })
    await insertFixtureUsers(db, [
      { id: ADMIN, display_name: 'Site Admin', is_admin: true },
      { id: OWN, display_name: 'Own Player' }
    ])
    await db
      .insertInto('teams')
      .values([
        { id: 'tem_home', name: 'Bulk Hawks' },
        { id: 'tem_away', name: 'Bulk Owls' }
      ])
      .execute()
    await db
      .insertInto('games')
      .values({
        id: 'gam_bulk',
        start_at: new Date('2026-01-01T00:00:00Z'),
        home_team_id: 'tem_home',
        away_team_id: 'tem_away'
      })
      .execute()
    await db
      .insertInto('memberships')
      .values({
        id: 'mem_own',
        user_id: OWN,
        team_id: 'tem_away',
        is_player: true,
        joined_at: new Date()
      })
      .execute()
    // Each bulk player: an account, a spectator's place on the home team, a
    // line in its game, a pool guest there, and an open add to it. Their
    // names differ, so no collision is broken across them all.
    await sql`
      insert into users (id, display_name, first_name, last_name)
      select id, 'Player' || n || ' Bulk', 'Player' || n, 'Bulk'
      from unnest(${bulk}::text[]) with ordinality as asked(id, n)
    `.execute(db)
    await sql`
      insert into gumbo_ids (user_id, gumbo_id)
      select id, ${FIRST_GUMBO} + n - 1
      from unnest(${bulk}::text[]) with ordinality as asked(id, n)
    `.execute(db)
    await sql`
      insert into memberships (id, user_id, team_id, is_player, joined_at)
      select 'mem_bulk_' || n, id, 'tem_home', false, now()
      from unnest(${bulk}::text[]) with ordinality as asked(id, n)
    `.execute(db)
    await sql`
      insert into game_player_stats (id, game_id, team_id, gumbo_id, pa, ab, h)
      select 'gps_bulk_' || n, 'gam_bulk', 'tem_home', ${FIRST_GUMBO} + n - 1,
        1, 1, 1
      from generate_series(1, ${MANY}) as n
    `.execute(db)
    await sql`
      insert into game_guest_details (game_id, user_id, jersey, positions, pool)
      select 'gam_bulk', id, null, '{}', true
      from unnest(${bulk}::text[]) as asked(id)
    `.execute(db)
    await sql`
      insert into group_requests (id, kind, sender_id, sender_scope_type,
        sender_scope_id, terms, status, sent_at, expires_at,
        initiating_team_id)
      select 'grq_bulk_' || n, 'playerAdd', ${ADMIN}, 'team', 'tem_home',
        jsonb_build_object('mode', 'roster', 'userId', id), 'applied',
        now() - interval '1 hour', now() + interval '1 day', 'tem_home'
      from unnest(${bulk}::text[]) with ordinality as asked(id, n)
    `.execute(db)
    // Their side accepted a later add of the first: that hold is over.
    await db
      .insertInto('group_requests')
      .values({
        id: 'grq_accepted',
        kind: 'playerAdd',
        sender_id: ADMIN,
        sender_scope_type: 'team',
        sender_scope_id: 'tem_home',
        terms: JSON.stringify({ mode: 'roster', userId: bulk[0] }),
        status: 'accepted',
        sent_at: new Date(),
        expires_at: new Date(Date.now() + 86_400_000),
        initiating_team_id: 'tem_home'
      })
      .execute()
  })

  after(async function () {
    if (db != null) await db.destroy()
    if (admin != null) {
      await dropScratchDatabase(admin, name)
      await admin.end()
    }
  })

  beforeEach(function () {
    bound = []
  })

  it('reads open holds by team, for 70,000 team ids, binding a fixed number of parameters', async function () {
    const small = await openAddsOf(db, ['tem_home', 'tem_away'])
    const smallMost = most()
    bound = []
    const many = await openAddsOf(db, [
      'tem_home',
      'tem_away',
      ...padding(MANY, 'tem_none')
    ])
    console.log(
      `      openAddsOf, ${MANY + 2} team ids: at most ${most()} bound parameters per statement`
    )
    expect(most()).equals(smallMost)
    expect(many.get('tem_home')).deep.equals(small.get('tem_home'))
    expect(many.get('tem_away')).deep.equals(small.get('tem_away'))
    expect(small.get('tem_home')!.size).equals(MANY - 1)
    expect(small.get('tem_home')!.has(bulk[0])).equals(false)
    expect(many.get('tem_none_0')).deep.equals(new Set())
  })

  it('reads open holds by user, for 70,000 user ids, binding a fixed number of parameters', async function () {
    const small = await openAddTeams(db, [bulk[1], OWN])
    const smallMost = most()
    bound = []
    const many = await openAddTeams(db, [OWN, ...bulk])
    console.log(
      `      openAddTeams, ${MANY + 1} user ids: at most ${most()} bound parameters per statement`
    )
    expect(most()).equals(smallMost)
    expect(many).deep.equals(small)
    expect(many).deep.equals(['tem_home'])
    expect(await openAddTeams(db, [bulk[0], OWN])).deep.equals([])
  })

  it('reads lent players, for 70,000 pairs, binding a fixed number of parameters', async function () {
    const pairs = (
      userIds: string[]
    ): Array<{
      userId: string
      teamId: string
    }> => userIds.map(userId => ({ userId, teamId: 'tem_home' }))
    const few = [bulk[0], bulk[1], OWN]
    const small = await lentPlayers(db, [
      ...pairs(few),
      { userId: OWN, teamId: 'tem_away' }
    ])
    const smallMost = most()
    bound = []
    const many = await lentPlayers(db, [
      ...pairs([OWN, ...bulk]),
      { userId: OWN, teamId: 'tem_away' }
    ])
    console.log(
      `      lentPlayers, ${MANY + 2} pairs: at most ${most()} bound parameters per statement`
    )
    expect(most()).equals(smallMost)
    expect(small).deep.equals(
      new Set([`tem_home ${bulk[0]}`, `tem_home ${bulk[1]}`])
    )
    expect(many.size).equals(MANY)
    for (const key of small) expect(many.has(key)).equals(true)
    expect(many.has(`tem_home ${OWN}`)).equals(false)
    expect(many.has(`tem_away ${OWN}`)).equals(false)
  })

  it('reads current formats, for 70,000 user ids, binding a fixed number of parameters', async function () {
    const small = await currentFormats(db, [OWN, bulk[1]])
    const smallMost = most()
    bound = []
    const many = await currentFormats(db, [OWN, ...bulk])
    console.log(
      `      currentFormats, ${MANY + 1} user ids: at most ${most()} bound parameters per statement`
    )
    expect(most()).equals(smallMost)
    expect(many.size).equals(MANY + 1)
    expect(many.get(OWN)).deep.equals(small.get(OWN))
    expect(many.get(bulk[1])).deep.equals(small.get(bulk[1]))
  })

  it('reads a roster of 70,000 members', async function () {
    const roster = await teamRoster(db, undefined, 'tem_home')
    console.log(
      `      teamRoster, ${roster.length} entries: at most ${most()} bound parameters per statement`
    )
    expect(most()).lessThan(20)
    expect(roster.length).equals(MANY)
  })

  it('answers GET /teams/:id/stats for a team whose lent players are more than 65,535', async function () {
    const app = express()
    app.use((req, _res, next) => {
      req.actor = { userId: ADMIN, isAdmin: true, scopes: [] }
      next()
    })
    app.use(teamRoutes(db, media))
    app.use(errorHandler)
    const server = app.listen(0, '127.0.0.1')
    await new Promise<void>(resolve => server.once('listening', resolve))
    try {
      const address = server.address()
      if (address == null || typeof address === 'string')
        throw new Error('Expected port')
      const response = await fetch(
        `http://127.0.0.1:${address.port}/teams/tem_home/stats`
      )
      const body = (await response.json()) as unknown
      console.log(
        `      GET /teams/tem_home/stats: ${response.status}, at most ${most()} bound parameters per statement`
      )
      expect(response.status, JSON.stringify(body).slice(0, 500)).equals(200)
      expect(body).to.be.an('array').with.length(MANY)
      expect(most()).lessThan(20)
    } finally {
      server.close()
    }
  })
})
