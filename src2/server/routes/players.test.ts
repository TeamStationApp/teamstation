import { expect } from 'chai'
import { Kysely, PostgresDialect } from 'kysely'
import { after, before, describe, it } from 'mocha'
import { Pool } from 'pg'

import { makeId } from '../../common/ids'
import { migrations } from '../../migrate/migrations'
import { migrateUp } from '../../migrate/runner'
import { mayEditName } from '../access'
import type { Database } from '../db/database'
import { teamsOf } from './players'

/**
 * Who may **change** a child's name, and which teams a player has played for.
 *
 * The app draws `Jordan P` on every screen for everybody; the surname appears
 * only in the field somebody types it into. So this is an editing right, and
 * it fails silently in the wrong direction — nobody complains that a name was
 * shortened, so a gate that had quietly opened would stay open.
 */
const adminUrl =
  process.env.GS_TEST_DATABASE_URL ?? 'postgres://localhost:5432/postgres'
const scratchName = `gamestation_players_${Date.now()}`
const scratchUrl = adminUrl.replace(/\/[^/]*$/, `/${scratchName}`)

describe('a player, and who may change their name', function () {
  this.timeout(60000)

  let admin: Pool | undefined
  let pool: Pool | undefined
  let db: Kysely<Database>

  const teamId = makeId('team')
  const otherTeamId = makeId('team')
  const seasonId = makeId('season')
  const childId = makeId('user')
  const parentId = makeId('user')
  const coachId = makeId('user')
  const strangerId = makeId('user')
  const seasonAdminId = makeId('user')

  before(async function () {
    admin = new Pool({ connectionString: adminUrl })
    try {
      await admin.query('select 1')
    } catch {
      await admin.end()
      admin = undefined
      this.skip()
      return
    }
    await admin.query(`create database ${scratchName}`)

    pool = new Pool({ connectionString: scratchUrl })
    await migrateUp(pool, migrations)
    db = new Kysely<Database>({ dialect: new PostgresDialect({ pool }) })

    await db
      .insertInto('seasons')
      .values({ id: seasonId, name: 'Spring 2026', year: 2026 })
      .execute()
    await db
      .insertInto('teams')
      .values([
        { id: teamId, name: 'Badgers' },
        { id: otherTeamId, name: 'Legends' }
      ])
      .execute()
    await db
      .insertInto('season_teams')
      .values({ season_id: seasonId, team_id: teamId })
      .execute()
    await db
      .insertInto('users')
      .values([
        { id: childId, display_name: 'Jordan Pujols', bats: 'left' },
        { id: parentId, display_name: 'A Parent' },
        { id: coachId, display_name: 'A Coach' },
        { id: strangerId, display_name: 'Somebody Else' },
        { id: seasonAdminId, display_name: 'A Season Admin' }
      ])
      .execute()
    await db
      .insertInto('memberships')
      .values([
        {
          id: makeId('membership'),
          user_id: childId,
          team_id: teamId,
          is_player: true,
          jersey: '12'
        },
        {
          id: makeId('membership'),
          user_id: coachId,
          team_id: teamId,
          role: 'manager'
        },
        {
          id: makeId('membership'),
          user_id: strangerId,
          team_id: teamId
        },
        {
          id: makeId('membership'),
          user_id: parentId,
          team_id: otherTeamId
        }
      ])
      .execute()
    await db
      .insertInto('user_links')
      .values({
        id: makeId('userLink'),
        user_id: parentId,
        related_user_id: childId,
        kind: 'guardian'
      })
      .execute()
    await db
      .insertInto('admin_roles')
      .values({
        id: makeId('adminRole'),
        user_id: seasonAdminId,
        scope_type: 'season',
        scope_id: seasonId
      })
      .execute()
  })

  after(async function () {
    await pool?.end()
    if (admin != null) {
      await admin.query(`drop database if exists ${scratchName}`)
      await admin.end()
    }
  })

  const about = { isAdmin: false }

  it('lets a parent change it', async function () {
    expect(await mayEditName(db, parentId, childId, about)).equals(true)
  })

  it('lets a site administrator change it', async function () {
    expect(
      await mayEditName(db, strangerId, childId, { isAdmin: true })
    ).equals(true)
  })

  it('lets a player change their own', async function () {
    expect(await mayEditName(db, childId, childId, about)).equals(true)
  })

  // Paul's rule, 2026-09-19: an administrator or a parent, and nobody else.
  // A coach runs the team and still has no business with the surname, and
  // neither does whoever administers the season above it.
  it('refuses a coach, a season administrator and a team-mate', async function () {
    expect(await mayEditName(db, coachId, childId, about)).equals(false)
    expect(await mayEditName(db, seasonAdminId, childId, about)).equals(false)
    expect(await mayEditName(db, strangerId, childId, about)).equals(false)
  })

  it('lists the teams a player has been on, with the season', async function () {
    const teams = await teamsOf(db, childId)
    expect(teams).deep.equals([
      {
        teamId,
        teamName: 'Badgers',
        seasonId,
        seasonName: 'Spring 2026',
        seasonYear: 2026
      }
    ])
  })

  // A membership that is not a playing one is not a team they played for. The
  // filter on their stats is built from this list, and a season nobody batted
  // in is an option that can only ever answer "nothing".
  it('leaves out a team they are only a spectator on', async function () {
    expect(await teamsOf(db, strangerId)).deep.equals([])
  })
})
