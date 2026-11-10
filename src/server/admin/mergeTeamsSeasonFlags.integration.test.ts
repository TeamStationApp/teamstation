import { expect } from 'chai'
import { Kysely, PostgresDialect } from 'kysely'
import { after, before, describe, it } from 'mocha'
import { Pool } from 'pg'

import { migrations } from '../../migrate/migrations'
import { migrateUp } from '../../migrate/runner'
import { testDatabaseUrl } from '../../migrate/testDatabase'
import type { Database } from '../db/database'
import { attachInt8Parser } from '../db/int8'
import { mergeTeams } from './mergeTeams'

const scratchName = `teamstation_mergeflags_${process.pid}_${Date.now()}`

/**
 * A merged team's exhibition flag, season by season: it stays a participant
 * if either side was one, and a flag in a season only the source took part
 * in moves with it.
 */
describe('merging teams’ exhibition flags', function () {
  this.timeout(60000)
  let admin: Pool | undefined
  let pool: Pool | undefined
  let db: Kysely<Database>

  before(async () => {
    attachInt8Parser()
    admin = new Pool({ connectionString: testDatabaseUrl })
    await admin.query(`create database ${scratchName}`)
    pool = new Pool({
      connectionString: testDatabaseUrl.replace(/\/[^/]*$/, `/${scratchName}`)
    })
    await migrateUp(pool, migrations)
    db = new Kysely<Database>({ dialect: new PostgresDialect({ pool }) })
    await db
      .insertInto('teams')
      .values([
        { id: 'tem_source', name: 'Demo Source', kind: 'full' },
        { id: 'tem_kept', name: 'Demo Kept', kind: 'full' }
      ])
      .execute()
    await db
      .insertInto('seasons')
      .values(
        ['one', 'two', 'three', 'four', 'five', 'six'].map(name => ({
          id: `sea_${name}`,
          name: `Demo ${name}`,
          year: 2027,
          starts_on: '2027-03-01',
          ends_on: '2027-05-31',
          created_at: new Date(),
          updated_at: new Date()
        }))
      )
      .execute()
    const active = (
      season: string,
      team: string
    ): { season_id: string; team_id: string; joined_at: Date } => ({
      season_id: `sea_${season}`,
      team_id: team,
      joined_at: new Date()
    })
    await db
      .insertInto('season_teams')
      .values([
        // one: an exhibition source into a participant with no flag row.
        active('one', 'tem_source'),
        active('one', 'tem_kept'),
        // two: a participant with no flag row into an exhibition team.
        active('two', 'tem_source'),
        active('two', 'tem_kept'),
        // four: both exhibition teams.
        active('four', 'tem_source'),
        active('four', 'tem_kept'),
        // five: only the kept team, flagged.
        active('five', 'tem_kept'),
        // six: only the source, unflagged, with a flag row left for the
        // kept team.
        active('six', 'tem_source')
      ])
      .execute()
    // three: the source alone, flagged, as a parent-managed team.
    await db
      .insertInto('season_team_parents')
      .values({
        season_id: 'sea_three',
        team_id: 'tem_source',
        created_at: new Date()
      })
      .execute()
    await db
      .insertInto('season_team_flags')
      .values([
        { season_id: 'sea_one', team_id: 'tem_source', exhibition: true },
        { season_id: 'sea_two', team_id: 'tem_kept', exhibition: true },
        { season_id: 'sea_three', team_id: 'tem_source', exhibition: true },
        { season_id: 'sea_four', team_id: 'tem_source', exhibition: true },
        { season_id: 'sea_four', team_id: 'tem_kept', exhibition: true },
        { season_id: 'sea_five', team_id: 'tem_kept', exhibition: true },
        { season_id: 'sea_six', team_id: 'tem_kept', exhibition: true }
      ])
      .execute()
  })
  after(async () => {
    await db?.destroy()
    if (admin != null) {
      await admin.query(`drop database if exists ${scratchName}`)
      await admin.end()
    }
  })

  it('keeps a participant a participant, and moves a flag the kept team lacks', async () => {
    const dry = await mergeTeams(db, {
      fromTeamId: 'tem_source',
      intoTeamId: 'tem_kept'
    })
    expect(dry.repointed['season_team_flags.team_id']).equals(3)
    await mergeTeams(db, {
      fromTeamId: 'tem_source',
      intoTeamId: 'tem_kept',
      apply: true
    })
    expect(
      await db
        .selectFrom('season_team_flags')
        .select(['season_id', 'team_id', 'exhibition'])
        .orderBy('season_id')
        .execute()
    ).deep.equals([
      { season_id: 'sea_five', team_id: 'tem_kept', exhibition: true },
      { season_id: 'sea_four', team_id: 'tem_kept', exhibition: true },
      { season_id: 'sea_one', team_id: 'tem_kept', exhibition: false },
      // Only the source took part, with no flag: the kept team's stays.
      { season_id: 'sea_six', team_id: 'tem_kept', exhibition: true },
      { season_id: 'sea_three', team_id: 'tem_kept', exhibition: true },
      { season_id: 'sea_two', team_id: 'tem_kept', exhibition: false }
    ])
    // The parent-managed season moved after the flag did.
    expect(
      await db
        .selectFrom('season_team_parents')
        .select(['season_id', 'team_id'])
        .execute()
    ).deep.equals([{ season_id: 'sea_three', team_id: 'tem_kept' }])
  })
})
