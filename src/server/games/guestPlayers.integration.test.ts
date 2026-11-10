import { expect } from 'chai'
import { type Kysely, sql } from 'kysely'
import { after, before, describe, it } from 'mocha'
import { Pool } from 'pg'

import { storedGuests } from '../../common/guests'
import { makeId } from '../../common/ids'
import { asNewRosterPlayer } from '../../common/playerSettings'
import { currentDocumentOf } from '../../common/scoring/document'
import { setupOf } from '../../common/scoring/state'
import { teamsOfRow } from '../../common/teamLists'
import { userIdOfGumbo } from '../../common/userId'
import { migrations } from '../../migrate/migrations'
import { migrateUp } from '../../migrate/runner'
import { testDatabaseUrl } from '../../migrate/testDatabase'
import { insertFixtureUsers } from '../../test/insertFixtureUsers'
import { after as score, game as fixture } from '../../test/scoringGames'
import type { Actor } from '../auth/sessions'
import { type Database, makeDatabase } from '../db/database'
import { createGuestPlayer, renameGuestPlayer } from './guestPlayers'

describe('persistent game guests', function () {
  this.timeout(60000)
  const name = `teamstation_guest_api_${process.pid}_${Date.now()}`
  let admin: Pool
  let db: Kysely<Database>
  const actor: Actor = {
    userId: userIdOfGumbo(123),
    isAdmin: false,
    scopes: []
  }
  const player = asNewRosterPlayer({
    firstName: 'Babe',
    lastName: 'Ruth',
    jersey: '00',
    bats: 'left',
    throws: 'right',
    positions: ['P']
  })
  before(async function () {
    admin = new Pool({ connectionString: testDatabaseUrl })
    await admin.query(`create database ${name}`)
    const url = testDatabaseUrl.replace(/\/[^/]*$/, `/${name}`)
    const pool = new Pool({ connectionString: url })
    await migrateUp(pool, migrations)
    await pool.end()
    db = makeDatabase(url)
    await insertFixtureUsers(db, {
      id: userIdOfGumbo(123),
      legacyId: 'usr_AAAAAAAAAAAAAAAA',
      display_name: 'Hank Aaron'
    })
    await db
      .insertInto('teams')
      .values([
        { id: 'team-away', name: 'Visitors' },
        { id: 'team-home', name: 'Hosts' }
      ])
      .execute()
    await db
      .insertInto('games')
      .values({
        id: 'gam_guests',
        home_team_id: 'team-home',
        away_team_id: 'team-away',
        start_at: new Date()
      })
      .execute()
    await db
      .insertInto('scope_roles')
      .values({
        id: 'rol_guest_coach',
        user_id: userIdOfGumbo(123),
        scope_type: 'team',
        scope_id: 'team-away',
        role: 'coach'
      })
      .execute()
  })
  after(async function () {
    await db?.destroy()
    await admin.query(`drop database if exists ${name}`)
    await admin.end()
  })
  async function refused(
    run: () => Promise<unknown>,
    code: string
  ): Promise<void> {
    const before = await db
      .selectFrom('users')
      .select('id')
      .orderBy('id')
      .execute()
    let error: unknown
    try {
      await run()
    } catch (caught) {
      error = caught
    }
    expect(error).property('code', code)
    expect(
      await db.selectFrom('users').select('id').orderBy('id').execute()
    ).deep.equals(before)
  }
  it('serializes concurrent mints, persists both guests and creates no memberships or logins', async function () {
    const entries = await Promise.all([
      createGuestPlayer(db, actor, 'gam_guests', 'away', player),
      createGuestPlayer(db, actor, 'gam_guests', 'away', player)
    ])
    const ids = entries.map(entry => entry.userId)
    expect(new Set(ids).size).equals(2)
    for (const entry of entries)
      expect(entry).includes({
        shortName: 'Babe Ruth',
        jersey: '00',
        bats: 'left'
      })
    const game = await db
      .selectFrom('games')
      .select(['guests', 'home_team_id', 'away_team_id'])
      .where('id', '=', 'gam_guests')
      .executeTakeFirstOrThrow()
    expect(
      storedGuests(game.guests, teamsOfRow(game)).away.sort((a, b) => a - b)
    ).deep.equals(entries.map(entry => entry.gumboId!).sort((a, b) => a - b))
    expect(storedGuests(game.guests, teamsOfRow(game)).home).deep.equals([])
    const users = await db
      .selectFrom('users')
      .select(['login_enabled', 'bats_source', 'first_name', 'last_name'])
      .where('id', 'in', ids)
      .execute()
    for (const user of users)
      expect(user).deep.equals({
        login_enabled: false,
        bats_source: 'manual',
        first_name: 'Babe',
        last_name: 'Ruth'
      })
    expect(
      await db
        .selectFrom('user_emails')
        .selectAll()
        .where('user_id', 'in', ids)
        .execute()
    ).deep.equals([])
    expect(
      await db
        .selectFrom('memberships')
        .selectAll()
        .where('user_id', 'in', ids)
        .execute()
    ).deep.equals([])
  })
  it('allows either side for a game scorekeeper, but keeps coaches side-specific and requires an open game', async function () {
    await refused(
      async () => await createGuestPlayer(db, actor, 'missing', 'away', player),
      'notFound'
    )
    await refused(
      async () =>
        await createGuestPlayer(db, actor, 'gam_guests', 'home', player),
      'forbidden'
    )
    for (const status of ['final', 'cancelled'] as const) {
      await db
        .updateTable('games')
        .set({ status })
        .where('id', '=', 'gam_guests')
        .execute()
      await refused(
        async () =>
          await createGuestPlayer(db, actor, 'gam_guests', 'away', player),
        'conflict'
      )
    }
    await db
      .updateTable('games')
      .set({ status: 'scheduled' })
      .where('id', '=', 'gam_guests')
      .execute()
    for (const role of ['assistant', 'scorekeeper'] as const) {
      await db
        .updateTable('scope_roles')
        .set({ role })
        .where('id', '=', 'rol_guest_coach')
        .execute()
      await createGuestPlayer(db, actor, 'gam_guests', 'away', {
        ...player,
        firstName: '',
        lastName: 'Mays',
        bats: null,
        throws: null
      })
      if (role === 'assistant') {
        await refused(
          async () =>
            await createGuestPlayer(db, actor, 'gam_guests', 'home', player),
          'forbidden'
        )
      } else {
        const guest = await createGuestPlayer(
          db,
          actor,
          'gam_guests',
          'home',
          player
        )
        expect(
          await db
            .selectFrom('memberships')
            .selectAll()
            .where('user_id', '=', guest.userId)
            .execute()
        ).deep.equals([])
        const game = await db
          .selectFrom('games')
          .select(['guests', 'home_team_id', 'away_team_id'])
          .where('id', '=', 'gam_guests')
          .executeTakeFirstOrThrow()
        expect(storedGuests(game.guests, teamsOfRow(game)).home).deep.equals([
          guest.gumboId
        ])
      }
    }
    await db
      .updateTable('scope_roles')
      .set({ scope_id: 'team-home' })
      .where('id', '=', 'rol_guest_coach')
      .execute()
    await createGuestPlayer(db, actor, 'gam_guests', 'away', player)
    await db
      .updateTable('scope_roles')
      .set({ scope_id: 'team-unrelated' })
      .where('id', '=', 'rol_guest_coach')
      .execute()
    await refused(
      async () =>
        await createGuestPlayer(db, actor, 'gam_guests', 'away', player),
      'forbidden'
    )
    await db
      .updateTable('scope_roles')
      .set({ scope_id: 'team-away' })
      .where('id', '=', 'rol_guest_coach')
      .execute()
  })
  it('rolls back the guest account, details and game list after five failed scoring allocations', async () => {
    const before = await db
      .selectFrom('games')
      .select(['guests', 'home_team_id', 'away_team_id'])
      .where('id', '=', 'gam_guests')
      .executeTakeFirstOrThrow()
    const details = await db
      .selectFrom('game_guest_details')
      .selectAll()
      .orderBy('user_id')
      .execute()
    const users = await db
      .selectFrom('users')
      .select('id')
      .orderBy('id')
      .execute()
    await sql`alter function ts_ensure_gumbo_id(text,bigint[]) rename to fixture_ensure_gumbo_id`.execute(
      db
    )
    try {
      await sql`create function ts_ensure_gumbo_id(value text, draws bigint[] default null) returns bigint
        language sql as 'select fixture_ensure_gumbo_id(value,array[0,0,0,0,0]::bigint[])'`.execute(
        db
      )
      let failure: any
      try {
        await createGuestPlayer(db, actor, 'gam_guests', 'away', player)
      } catch (error) {
        failure = error
      }
      expect(failure?.code).equals('TSG01')
      expect(
        await db.selectFrom('users').select('id').orderBy('id').execute()
      ).deep.equals(users)
      expect(
        await db
          .selectFrom('game_guest_details')
          .selectAll()
          .orderBy('user_id')
          .execute()
      ).deep.equals(details)
      expect(
        await db
          .selectFrom('games')
          .select(['guests', 'home_team_id', 'away_team_id'])
          .where('id', '=', 'gam_guests')
          .executeTakeFirstOrThrow()
      ).deep.equals(before)
    } finally {
      await sql`drop function if exists ts_ensure_gumbo_id(text,bigint[])`.execute(
        db
      )
      await sql`alter function fixture_ensure_gumbo_id(text,bigint[]) rename to ts_ensure_gumbo_id`.execute(
        db
      )
    }
  })
  it('rejects an unreadable game or an unfinished ball in play without minting', async function () {
    await db
      .updateTable('games')
      .set({ currentPlay: { teamStation: { version: 1 } } })
      .where('id', '=', 'gam_guests')
      .execute()
    await refused(
      async () =>
        await createGuestPlayer(db, actor, 'gam_guests', 'away', player),
      'conflict'
    )
    await insertFixtureUsers(
      db,
      Array.from({ length: 18 }, (_, index) => ({
        id: index + 1,
        legacyId: makeId('user'),
        display_name: `Player ${index + 1}`
      }))
    )
    const state = fixture()
    const action = {
      type: 'ballInPlay' as const,
      contact: 'swing' as const,
      fielder: 14
    }
    const pending = score(state, action)
    const doc = currentDocumentOf(pending, pending.liveData.plays.currentPlay, {
      setupBefore: setupOf(state),
      actions: [action]
    })
    await db
      .updateTable('games')
      .set({ currentPlay: doc })
      .where('id', '=', 'gam_guests')
      .execute()
    await refused(
      async () =>
        await createGuestPlayer(db, actor, 'gam_guests', 'away', player),
      'conflict'
    )
  })
})

describe("correcting a game-only player's name", function () {
  this.timeout(60000)
  const name = `teamstation_guest_rename_${process.pid}_${Date.now()}`
  let admin: Pool
  let db: Kysely<Database>
  const as = (gumboId: number): Actor => ({
    userId: userIdOfGumbo(gumboId),
    isAdmin: false,
    scopes: []
  })
  const SCORER = 201
  const HOME_COACH = 202
  const AWAY_COACH = 203
  const VIEWER = 204
  const ROSTERED = 205
  const babe = asNewRosterPlayer({
    firstName: 'Babe',
    lastName: 'Ruth',
    jersey: '3',
    bats: 'left',
    throws: 'left',
    positions: ['RF']
  })
  let homeGuest = ''
  let awayGuest = ''
  let otherGuest = ''

  before(async function () {
    admin = new Pool({ connectionString: testDatabaseUrl })
    await admin.query(`create database ${name}`)
    const url = testDatabaseUrl.replace(/\/[^/]*$/, `/${name}`)
    const pool = new Pool({ connectionString: url })
    await migrateUp(pool, migrations)
    await pool.end()
    db = makeDatabase(url)
    await insertFixtureUsers(
      db,
      [
        [SCORER, 'Yogi Berra'],
        [HOME_COACH, 'Casey Stengel'],
        [AWAY_COACH, 'Connie Mack'],
        [VIEWER, 'Lou Gehrig'],
        [ROSTERED, 'Mickey Mantle']
      ].map(([id, display]) => ({
        id: id as number,
        legacyId: makeId('user'),
        display_name: display as string
      }))
    )
    await db
      .insertInto('teams')
      .values([
        { id: 'team-r-away', name: 'Visitors' },
        { id: 'team-r-home', name: 'Hosts' }
      ])
      .execute()
    await db
      .insertInto('games')
      .values([
        {
          id: 'gam_rename',
          home_team_id: 'team-r-home',
          away_team_id: 'team-r-away',
          start_at: new Date()
        },
        {
          id: 'gam_rename_other',
          home_team_id: 'team-r-home',
          away_team_id: 'team-r-away',
          start_at: new Date()
        }
      ])
      .execute()
    await db
      .insertInto('scope_roles')
      .values(
        [
          [SCORER, 'team-r-away', 'scorekeeper'],
          [HOME_COACH, 'team-r-home', 'coach'],
          [AWAY_COACH, 'team-r-away', 'coach'],
          [VIEWER, 'team-r-home', 'videographer']
        ].map(([user, team, role]) => ({
          id: makeId('scopeRole'),
          user_id: userIdOfGumbo(user as number),
          scope_type: 'team',
          scope_id: team as string,
          role: role as 'coach'
        }))
      )
      .execute()
    const make = async (
      gameId: string,
      side: 'away' | 'home'
    ): Promise<string> =>
      (await createGuestPlayer(db, as(SCORER), gameId, side, babe)).userId
    homeGuest = await make('gam_rename', 'home')
    awayGuest = await make('gam_rename', 'away')
    otherGuest = await make('gam_rename_other', 'home')
  })
  after(async function () {
    await db?.destroy()
    await admin.query(`drop database if exists ${name}`)
    await admin.end()
  })

  async function nameOf(userId: string): Promise<unknown> {
    return await db
      .selectFrom('users')
      .select(['first_name', 'last_name', 'display_name'])
      .where('id', '=', userId)
      .executeTakeFirstOrThrow()
  }

  async function refusal(run: () => Promise<unknown>): Promise<unknown> {
    try {
      await run()
    } catch (error) {
      return (error as { code?: unknown }).code
    }
    return undefined
  }

  it("renames the guest's account for a scorekeeper and for his team's head coach", async function () {
    const renamed = await renameGuestPlayer(
      db,
      as(SCORER),
      'gam_rename',
      homeGuest,
      { firstName: 'George', lastName: 'Ruth' }
    )
    expect(renamed.before).deep.equals({
      firstName: 'Babe',
      lastName: 'Ruth',
      displayName: 'Babe Ruth'
    })
    expect(renamed.entry).deep.include({
      userId: homeGuest,
      shortName: 'George Ruth',
      jersey: '3',
      positions: ['RF'],
      bats: 'left'
    })
    expect(await nameOf(homeGuest)).deep.equals({
      first_name: 'George',
      last_name: 'Ruth',
      display_name: 'George Ruth'
    })
    await renameGuestPlayer(db, as(HOME_COACH), 'gam_rename', homeGuest, {
      firstName: '',
      lastName: 'Ruth'
    })
    expect(await nameOf(homeGuest)).deep.equals({
      first_name: null,
      last_name: 'Ruth',
      display_name: 'Ruth'
    })
    expect(renamed.changed).equals(true)
  })

  it('writes nothing for the name the account already has', async function () {
    const stamp = async (): Promise<unknown> =>
      (
        await db
          .selectFrom('users')
          .select('updated_at')
          .where('id', '=', otherGuest)
          .executeTakeFirstOrThrow()
      ).updated_at
    const was = await stamp()
    const kept = await renameGuestPlayer(
      db,
      as(SCORER),
      'gam_rename_other',
      otherGuest,
      { firstName: 'Babe', lastName: 'Ruth' }
    )
    expect(kept.changed).equals(false)
    expect(kept.entry).deep.include({
      userId: otherGuest,
      shortName: 'Babe Ruth'
    })
    expect(kept.before).deep.equals({
      firstName: 'Babe',
      lastName: 'Ruth',
      displayName: 'Babe Ruth'
    })
    expect(await stamp()).deep.equals(was)
    expect(await nameOf(otherGuest)).deep.equals({
      first_name: 'Babe',
      last_name: 'Ruth',
      display_name: 'Babe Ruth'
    })
  })

  it('refuses everybody else, and anybody who is not a guest of this game', async function () {
    const before = await nameOf(homeGuest)
    const rename = async (
      actor: number,
      userId: string,
      gameId = 'gam_rename'
    ): Promise<unknown> =>
      await refusal(
        async () =>
          await renameGuestPlayer(db, as(actor), gameId, userId, {
            firstName: 'Ty',
            lastName: 'Cobb'
          })
      )
    // Another team's coach, and somebody who only sees the game.
    expect(await rename(AWAY_COACH, homeGuest)).equals('forbidden')
    expect(await rename(VIEWER, homeGuest)).equals('forbidden')
    // The away team's head coach may correct his own side's guest.
    expect(await rename(HOME_COACH, awayGuest)).equals('forbidden')
    // A rostered player, a guest of another game, a game that is not there.
    expect(await rename(SCORER, userIdOfGumbo(ROSTERED))).equals('notFound')
    expect(await rename(SCORER, otherGuest)).equals('notFound')
    expect(await rename(SCORER, homeGuest, 'gam_missing')).equals('notFound')
    expect(await nameOf(homeGuest)).deep.equals(before)
    expect(await nameOf(otherGuest)).deep.equals({
      first_name: 'Babe',
      last_name: 'Ruth',
      display_name: 'Babe Ruth'
    })
  })

  it('refuses a pool player, an existing player added for this game only', async function () {
    const before = await nameOf(homeGuest)
    const pool = async (value: boolean): Promise<void> => {
      await db
        .updateTable('game_guest_details')
        .set({ pool: value })
        .where('game_id', '=', 'gam_rename')
        .where('user_id', '=', homeGuest)
        .executeTakeFirstOrThrow()
    }
    await pool(true)
    try {
      expect(
        await refusal(
          async () =>
            await renameGuestPlayer(db, as(SCORER), 'gam_rename', homeGuest, {
              firstName: 'Ty',
              lastName: 'Cobb'
            })
        )
      ).equals('forbidden')
    } finally {
      await pool(false)
    }
    expect(await nameOf(homeGuest)).deep.equals(before)
  })

  it('refuses a guest who signs in, and one whose account was deleted', async function () {
    await db
      .updateTable('users')
      .set({ login_enabled: true })
      .where('id', '=', awayGuest)
      .execute()
    expect(
      await refusal(
        async () =>
          await renameGuestPlayer(db, as(SCORER), 'gam_rename', awayGuest, {
            firstName: 'Ty',
            lastName: 'Cobb'
          })
      )
    ).equals('forbidden')
    await db
      .updateTable('users')
      .set({
        login_enabled: false,
        disabled_at: new Date(),
        deleted_at: new Date()
      })
      .where('id', '=', awayGuest)
      .execute()
    expect(
      await refusal(
        async () =>
          await renameGuestPlayer(db, as(SCORER), 'gam_rename', awayGuest, {
            firstName: 'Ty',
            lastName: 'Cobb'
          })
      )
    ).equals('notFound')
    expect(await nameOf(awayGuest)).deep.equals({
      first_name: 'Babe',
      last_name: 'Ruth',
      display_name: 'Babe Ruth'
    })
  })
})
