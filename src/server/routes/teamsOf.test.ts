import { expect } from 'chai'
import { Kysely, PostgresDialect } from 'kysely'
import { after, before, describe, it } from 'mocha'
import { Pool } from 'pg'

import { makeId } from '../../common/ids'
import { mintUserId } from '../../common/mintUserId'
import { migrations } from '../../migrate/migrations'
import { migrateUp } from '../../migrate/runner'
import { testDatabaseUrl } from '../../migrate/testDatabase'
import type { Database } from '../db/database'
import { attachInt8Parser } from '../db/int8'
import { teamsOf } from './players'

const adminUrl = testDatabaseUrl
const scratchName = `teamstation_teamsof_${Date.now()}`
const scratchUrl = adminUrl.replace(/\/[^/]*$/, `/${scratchName}`)

const spring = makeId('season')
const fall = makeId('season')
const bandits = makeId('team')
const comets = makeId('team')
const closed = makeId('team')
const survivor = makeId('team')
const loose = makeId('team')
const held = new Set<number>()
const legacies = new Map<number, string>()
function mint(): number {
  const made = mintUserId(id => held.has(id))
  held.add(made.userId)
  legacies.set(made.userId, made.legacyId)
  return made.userId
}
const child = mint()

describe('the teams and seasons a player has played in', function () {
  this.timeout(60000)

  let admin: Pool | undefined
  let pool: Pool | undefined
  let db: Kysely<Database> | undefined
  let day = 0

  /** A game on this team in this season, with a stat line for the child. */
  async function line(teamId: string, seasonId: string | null): Promise<void> {
    const gameId = makeId('game')
    day += 1
    await db!
      .insertInto('games')
      .values({
        id: gameId,
        home_team_id: teamId,
        away_team_id: loose,
        season_id: seasonId,
        start_at: new Date(Date.UTC(2026, 3, day)),
        status: 'final'
      })
      .execute()
    await db!
      .insertInto('game_player_stats')
      .values({
        id: makeId('gamePlayerStats'),
        game_id: gameId,
        user_id: child,
        team_id: teamId,
        pa: 3,
        ab: 3,
        h: 1
      })
      .execute()
  }

  before(async function () {
    attachInt8Parser()
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

    const now = new Date()
    await db
      .insertInto('users')
      .values({
        id: child,
        legacyId: legacies.get(child)!,
        display_name: 'Jensen P',
        first_name: 'Jensen',
        last_name: 'P',
        created_at: now,
        updated_at: now
      })
      .execute()
    await db
      .insertInto('seasons')
      .values([
        { id: spring, name: 'Spring 2026', year: 2026 },
        { id: fall, name: 'Fall 2025', year: 2025 }
      ])
      .execute()
    await db
      .insertInto('teams')
      .values([
        { id: bandits, name: 'Bandits' },
        { id: comets, name: 'Comets' },
        { id: survivor, name: 'Survivor' },
        { id: loose, name: 'Opponent', kind: 'external' }
      ])
      .execute()
    await db
      .insertInto('teams')
      .values({ id: closed, name: 'Closed', merged_into: survivor })
      .execute()
  })

  after(async function () {
    if (db != null) await db.destroy()
    else if (pool != null) await pool.end()
    if (admin != null) {
      await admin.query(`drop database if exists ${scratchName}`)
      await admin.end()
    }
  })

  it('lists every team and season the player has a stat line for, newest first', async function () {
    await line(bandits, spring)
    await line(bandits, spring)
    await line(comets, fall)
    expect(await teamsOf(db!, [child])).deep.equals([
      {
        teamId: bandits,
        teamName: 'Bandits',
        seasonId: spring,
        seasonName: 'Spring 2026',
        seasonYear: 2026
      },
      {
        teamId: comets,
        teamName: 'Comets',
        seasonId: fall,
        seasonName: 'Fall 2025',
        seasonYear: 2025
      }
    ])
  })

  it('leaves out a team that has been merged into another', async function () {
    await line(closed, spring)
    const teams = await teamsOf(db!, [child])
    expect(teams.map(team => team.teamId)).not.include(closed)
  })

  it('lists a stat line in a game with no season after the seasons', async function () {
    await line(survivor, null)
    const teams = await teamsOf(db!, [child])
    expect(teams[teams.length - 1]).deep.equals({
      teamId: survivor,
      teamName: 'Survivor',
      seasonId: null,
      seasonName: null,
      seasonYear: null
    })
  })

  it('still lists a membership with no stat line, and a team from both sources once', async function () {
    const now = new Date()
    const spare = makeId('team')
    await db!.insertInto('teams').values({ id: spare, name: 'Spare' }).execute()
    await db!
      .insertInto('season_teams')
      .values([
        { season_id: spring, team_id: spare },
        { season_id: spring, team_id: bandits }
      ])
      .execute()
    await db!
      .insertInto('memberships')
      .values([
        {
          id: makeId('membership'),
          team_id: spare,
          user_id: child,
          role: 'member',
          is_player: true,
          joined_at: now
        },
        {
          id: makeId('membership'),
          team_id: bandits,
          user_id: child,
          role: 'member',
          is_player: true,
          joined_at: now
        }
      ])
      .execute()
    const teams = await teamsOf(db!, [child])
    expect(teams.filter(team => team.teamId === spare)).to.have.length(1)
    expect(
      teams.filter(team => team.teamId === bandits && team.seasonId === spring)
    ).to.have.length(1)
  })

  it('answers nobody for no ids', async function () {
    expect(await teamsOf(db!, [])).deep.equals([])
  })
})
