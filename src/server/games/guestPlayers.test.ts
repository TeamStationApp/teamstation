import { expect } from 'chai'
import type { Kysely } from 'kysely'
import { after, before, describe, it } from 'mocha'
import { Pool } from 'pg'

import { makeId } from '../../common/ids'
import { asNewRosterPlayer } from '../../common/playerSettings'
import { currentDocumentOf } from '../../common/scoring/document'
import { setupOf } from '../../common/scoring/state'
import { userIdOfGumbo } from '../../common/userId'
import { migrations } from '../../migrate/migrations'
import { migrateUp } from '../../migrate/runner'
import { testDatabaseUrl } from '../../migrate/testDatabase'
import { insertFixtureUsers } from '../../test/insertFixtureUsers'
import { after as score, game as fixture } from '../../test/scoringGames'
import type { Actor } from '../auth/sessions'
import { type Database, makeDatabase } from '../db/database'
import { createGuestPlayer } from './guestPlayers'

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
      .select('guests')
      .where('id', '=', 'gam_guests')
      .executeTakeFirstOrThrow()
    expect(
      (game.guests as { away: number[] }).away.sort((a, b) => a - b)
    ).deep.equals(entries.map(entry => entry.gumboId!).sort((a, b) => a - b))
    expect((game.guests as { home: number[] }).home).deep.equals([])
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
  it('requires the side roster permission and an open game', async function () {
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
