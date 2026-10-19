import { expect } from 'chai'
import { type Kysely, type Selectable, sql } from 'kysely'
import { after, before, describe, it } from 'mocha'
import { Pool } from 'pg'

import type { CurrentPlay, GumboPlay } from '../../common/gumboPlay'
import { makeId } from '../../common/ids'
import { asNewRosterPlayer } from '../../common/playerSettings'
import { currentDocumentOf } from '../../common/scoring/document'
import { ScoringSession } from '../../common/scoring/session'
import { setupOf } from '../../common/scoring/state'
import type { Unrostered } from '../../common/unroster'
import { migrations } from '../../migrate/migrations'
import { migrateUp } from '../../migrate/runner'
import { testDatabaseUrl } from '../../migrate/testDatabase'
import { after as score, game as fixture } from '../../test/scoringGames'
import { closeInto } from '../admin/people'
import type { Actor } from '../auth/sessions'
import { type Database, makeDatabase } from '../db/database'
import { readPlays } from '../events/postPlays'
import { createGuestPlayer } from './guestPlayers'
import { gameAvailability } from './rosterAvailability'
import { setRostered } from './unroster'

describe('atomic game availability', function () {
  this.timeout(60000)
  const name = `teamstation_unroster_api_${process.pid}_${Date.now()}`
  let admin: Pool
  let db: Kysely<Database>
  const actor: Actor = { userId: 123, isAdmin: false, scopes: [] }
  before(async () => {
    admin = new Pool({ connectionString: testDatabaseUrl })
    await admin.query(`create database ${name}`)
    const url = testDatabaseUrl.replace(/\/[^/]*$/, `/${name}`)
    const pool = new Pool({ connectionString: url })
    await migrateUp(pool, migrations)
    await pool.end()
    db = makeDatabase(url)
    await db
      .insertInto('users')
      .values(
        [
          ...Array.from({ length: 18 }, (_, i) => i + 1),
          123,
          124,
          125,
          126,
          127,
          128,
          129
        ].map(id => ({
          id,
          legacyId: makeId('user'),
          display_name: 'Hank Aaron'
        }))
      )
      .execute()
    await db
      .insertInto('teams')
      .values([
        { id: 'team-away', name: 'Visitors' },
        { id: 'team-home', name: 'Hosts' }
      ])
      .execute()
    await db
      .insertInto('games')
      .values(
        [
          'gam_empty',
          'gam_saved',
          'gam_pending',
          'gam_final',
          'gam_cancelled'
        ].map(id => ({
          id,
          home_team_id: 'team-home',
          away_team_id: 'team-away',
          start_at: new Date()
        }))
      )
      .execute()
    await db
      .insertInto('memberships')
      .values(
        Array.from({ length: 18 }, (_, i) => ({
          id: makeId('membership'),
          user_id: i + 1,
          team_id: i < 9 ? 'team-away' : 'team-home',
          role: 'member' as const,
          is_player: true,
          jersey: String(i + 1)
        }))
      )
      .execute()
    await db
      .insertInto('scope_roles')
      .values([
        {
          id: makeId('scopeRole'),
          user_id: 123,
          scope_type: 'team' as const,
          scope_id: 'team-away',
          role: 'coach' as const
        },
        ...(
          ['assistant', 'scorekeeper', 'songkeeper', 'videographer'] as const
        ).map((role, i) => ({
          id: makeId('scopeRole'),
          user_id: 124 + i,
          scope_type: 'team' as const,
          scope_id: 'team-away',
          role
        })),
        {
          id: makeId('scopeRole'),
          user_id: 128,
          scope_type: 'team' as const,
          scope_id: 'team-home',
          role: 'coach' as const
        }
      ])
      .execute()
    await db
      .updateTable('games')
      .set({ status: 'final' })
      .where('id', '=', 'gam_final')
      .execute()
    await db
      .updateTable('games')
      .set({ status: 'cancelled' })
      .where('id', '=', 'gam_cancelled')
      .execute()
  })
  after(async () => {
    await db?.destroy()
    await admin.query(`drop database if exists ${name}`)
    await admin.end()
  })
  const row = async (id: string): Promise<Selectable<Database['games']>> =>
    await db
      .selectFrom('games')
      .selectAll()
      .where('id', '=', id)
      .executeTakeFirstOrThrow()
  const toggle = async (
    id: string,
    userId: number,
    rostered: boolean,
    caller = actor
  ): Promise<Unrostered> =>
    await setRostered(db, caller, id, { side: 'away', userId, rostered })
  const rejected = async (
    run: () => Promise<unknown>,
    code: string
  ): Promise<void> => {
    let failure: unknown
    try {
      await run()
    } catch (error) {
      failure = error
    }
    expect(failure).property('code', code)
  }
  const open = async (id: string): Promise<ScoringSession> =>
    await ScoringSession.open(
      {
        load: async () => ({
          plays: (await readPlays(db, id)).map(row => row.gumbo as GumboPlay),
          currentPlay: (await row(id)).currentPlay as CurrentPlay | null
        }),
        save: async () => {
          throw new Error('Read only')
        }
      },
      id,
      {
        gamePk: id,
        teams: fixture().gameData.teams,
        setup: setupOf(fixture())
      },
      { setTimer: () => null, clearTimer: () => undefined }
    )
  it('changes only this game and side, is idempotent, and does not start a new game', async () => {
    expect(await toggle('gam_empty', 1, false)).deep.equals({
      away: [1],
      home: []
    })
    const before = await row('gam_empty')
    expect(before.currentPlay).equals(null)
    expect(before.status).equals('scheduled')
    expect(await toggle('gam_empty', 1, false)).deep.equals({
      away: [1],
      home: []
    })
    expect(await row('gam_empty')).deep.equals(before)
    expect((await row('gam_saved')).unrostered).deep.equals({
      away: [],
      home: []
    })
    expect(await toggle('gam_empty', 1, true)).deep.equals({
      away: [],
      home: []
    })
  })
  it('refuses every non-head-coach role, the other team, missing users, nonplayers and guests', async () => {
    for (const userId of [124, 125, 126, 127, 128, 129])
      await rejected(
        async () => await toggle('gam_empty', 1, false, { ...actor, userId }),
        'forbidden'
      )
    await rejected(
      async () => await toggle('gam_missing', 1, false),
      'notFound'
    )
    for (const id of ['gam_final', 'gam_cancelled'])
      await rejected(async () => await toggle(id, 1, false), 'conflict')
    for (const id of [129, 10, 900000])
      await rejected(
        async () => await toggle('gam_empty', id, false),
        'badRequest'
      )
    const guest = await createGuestPlayer(
      db,
      actor,
      'gam_empty',
      'away',
      asNewRosterPlayer({
        firstName: 'Babe',
        lastName: 'Ruth',
        jersey: '00',
        positions: ['P'],
        bats: 'left',
        throws: 'right'
      })
    )
    await rejected(
      async () => await toggle('gam_empty', guest.userId, false),
      'badRequest'
    )
    const availability = await gameAvailability(db, await row('gam_empty'))
    expect(availability.guestPlayers.away[0]).includes({
      userId: guest.userId,
      jersey: '00',
      bats: 'left'
    })
    expect(availability.guestPlayers.away[0].positions).deep.equals(['P'])
    expect(availability.guests.away).deep.equals([guest.userId])
    await closeInto(db, guest.userId, 2)
    const merged = await gameAvailability(db, await row('gam_empty'))
    expect(merged.guests.away).deep.equals([2])
    expect(merged.guestPlayers.away[0].userId).equals(2)
  })
  it('removes a placed player, keeps teammates and the guest, and appends him unplaced on return', async () => {
    const initial = fixture()
    initial.liveData.boxscore.teams.away.battingOrder =
      initial.liveData.boxscore.teams.away.battingOrder.slice(0, 8)
    const setup = setupOf(initial)
    await db
      .updateTable('games')
      .set({
        currentPlay: currentDocumentOf(
          initial,
          initial.liveData.plays.currentPlay,
          {
            setupBefore: setup,
            actions: []
          }
        )
      })
      .where('id', '=', 'gam_saved')
      .execute()
    const guest = await createGuestPlayer(
      db,
      actor,
      'gam_saved',
      'away',
      asNewRosterPlayer({
        firstName: 'Willie',
        lastName: 'Mays',
        jersey: '24',
        positions: ['CF'],
        bats: 'right',
        throws: 'right'
      })
    )
    const before = await open('gam_saved')
    await toggle('gam_saved', 1, false)
    const removed = (await open('gam_saved')).state.liveData.boxscore.teams
    expect(removed.away.players).not.includes(1)
    expect(removed.away.players).includes(guest.userId)
    expect(removed.away.battingOrder).deep.equals(
      before.state.liveData.boxscore.teams.away.battingOrder.filter(
        id => id !== 1
      )
    )
    expect(removed.away.defense.P).equals(null)
    expect(removed.home).deep.equals(before.state.liveData.boxscore.teams.home)
    await toggle('gam_saved', 1, true)
    const returned = (await open('gam_saved')).state.liveData.boxscore.teams
      .away
    expect(returned.players).includes(1)
    expect(returned.battingOrder).deep.equals(removed.away.battingOrder)
    expect(returned.defense).deep.equals(removed.away.defense)
    await toggle('gam_saved', 9, false)
    const benched = (await open('gam_saved')).state.liveData.boxscore.teams.away
    expect(benched.players).not.includes(9)
    expect(benched.battingOrder).deep.equals(returned.battingOrder)
    await toggle('gam_saved', 9, true)
    expect(
      (await open('gam_saved')).state.liveData.boxscore.teams.away.battingOrder
    ).deep.equals(returned.battingOrder)
  })
  it('rolls the switch and setup back while a play needs its result', async () => {
    const action = {
      type: 'ballInPlay' as const,
      contact: 'swing' as const,
      fielder: 14
    }
    const pending = score(fixture(), action)
    await db
      .updateTable('games')
      .set({
        currentPlay: currentDocumentOf(
          pending,
          pending.liveData.plays.currentPlay,
          {
            setupBefore: setupOf(fixture()),
            actions: [action]
          }
        )
      })
      .where('id', '=', 'gam_pending')
      .execute()
    const before = await row('gam_pending')
    await rejected(
      async () => await toggle('gam_pending', 1, false),
      'conflict'
    )
    expect(await row('gam_pending')).deep.equals(before)
  })
  it('rolls back the switch when persistence fails and refuses unreadable history', async () => {
    const before = await row('gam_saved')
    await sql`create function reject_test_lineup() returns trigger language plpgsql as $$ begin if new."currentPlay" is distinct from old."currentPlay" then raise exception 'Test lineup write refused'; end if; return new; end $$`.execute(
      db
    )
    await sql`create trigger reject_test_lineup before update on games for each row execute function reject_test_lineup()`.execute(
      db
    )
    try {
      let failure: unknown
      try {
        await toggle('gam_saved', 1, false)
      } catch (error) {
        failure = error
      }
      expect(String(failure)).includes('Test lineup write refused')
      expect(await row('gam_saved')).deep.equals(before)
    } finally {
      await sql`drop trigger reject_test_lineup on games`.execute(db)
      await sql`drop function reject_test_lineup()`.execute(db)
    }
    await db
      .updateTable('games')
      .set({ currentPlay: { teamStation: { version: 2 } } })
      .where('id', '=', 'gam_empty')
      .execute()
    const unread = await row('gam_empty')
    await rejected(async () => await toggle('gam_empty', 1, false), 'conflict')
    expect(await row('gam_empty')).deep.equals(unread)
  })
  it('accepts the account ID but stores and compares its distinct scoring ID', async () => {
    await db
      .updateTable('gumbo_ids')
      .set({ gumbo_id: 3129 })
      .where('user_id', '=', 129)
      .execute()
    await db
      .insertInto('memberships')
      .values({
        id: makeId('membership'),
        user_id: 129,
        team_id: 'team-away',
        role: 'member',
        is_player: true
      })
      .execute()
    const id = 'gam_distinct'
    await db
      .insertInto('games')
      .values({
        id,
        home_team_id: 'team-home',
        away_team_id: 'team-away',
        start_at: new Date()
      })
      .execute()
    expect((await toggle(id, 129, false)).away).deep.equals([3129])
    expect((await row(id)).unrostered).deep.equals({ away: [3129], home: [] })
    const available = await gameAvailability(db, await row(id))
    expect(
      available.roster.away.find(player => player.userId === 129)?.gumboId
    ).equals(3129)
    expect((await toggle(id, 129, true)).away).deep.equals([])
    await rejected(async () => await toggle(id, 3129, false), 'badRequest')
  })
})
