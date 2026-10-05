import { Kysely, PostgresDialect } from 'kysely'
import { after, before } from 'mocha'
import { Pool } from 'pg'

import { mintUserId } from '../common/mintUserId'
import { migrations } from '../migrate/migrations'
import { migrateUp } from '../migrate/runner'
import { testDatabaseUrl } from '../migrate/testDatabase'
import type { Database } from '../server/db/database'
import { attachInt8Parser } from '../server/db/int8'

/** Isolated synthetic data for database readers of expanded stat rows. */
export function statsDatabase(label: string): {
  readonly db: Kysely<Database>
  ids: number[]
} {
  const name = `teamstation_expandedstats_${label}_${Date.now()}`
  const users = [
    mintUserId(() => false),
    mintUserId(() => false),
    mintUserId(() => false)
  ]
  let db: Kysely<Database>
  let admin: Pool
  before(async function () {
    attachInt8Parser()
    admin = new Pool({ connectionString: testDatabaseUrl })
    await admin.query(`create database ${name}`)
    const pool = new Pool({
      connectionString: testDatabaseUrl.replace(/\/[^/]*$/, `/${name}`)
    })
    await migrateUp(pool, migrations)
    db = new Kysely({ dialect: new PostgresDialect({ pool }) })
    await db
      .insertInto('users')
      .values(
        users.map((user, i) => ({
          id: user.userId,
          legacyId: user.legacyId,
          display_name: `Demo Player ${i}`
        }))
      )
      .execute()
    await db
      .insertInto('teams')
      .values([
        { id: 'tem_home', name: 'Demo Hawks' },
        { id: 'tem_away', name: 'Demo Owls' }
      ])
      .execute()
    await db
      .insertInto('seasons')
      .values({ id: 'sea_demo', name: 'Demo Season', year: 2026 })
      .execute()
    await db
      .insertInto('games')
      .values({
        id: 'gam_demo',
        start_at: new Date('2026-01-01T00:00:00Z'),
        home_team_id: 'tem_home',
        away_team_id: 'tem_away',
        season_id: 'sea_demo'
      })
      .execute()
  })
  after(async function () {
    if (db != null) await db.destroy()
    if (admin != null) {
      await admin.query(`drop database if exists ${name}`)
      await admin.end()
    }
  })
  return {
    get db() {
      return db
    },
    ids: users.map(user => user.userId)
  }
}
