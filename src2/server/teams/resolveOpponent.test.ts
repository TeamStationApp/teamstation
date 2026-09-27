import { expect } from 'chai'
import type { Kysely } from 'kysely'
import { after, before, describe, it } from 'mocha'
import { Pool } from 'pg'

import { makeId } from '../../common/ids'
import { migrations } from '../../migrate/migrations'
import { migrateUp } from '../../migrate/runner'
import { testDatabaseUrl } from '../../migrate/testDatabase'
import type { Database } from '../db/database'
import { makeDatabase } from '../db/database'
import { resolveOpponent } from './resolveOpponent'

// The rule an import uses to name an opponent, so every run lands on the same
// team for the same schedule.

const adminUrl = testDatabaseUrl
const scratchName = `gamestation_opponent_${Date.now()}`
const scratchUrl = adminUrl.replace(/\/[^/]*$/, `/${scratchName}`)

describe('resolving an opponent by name', function () {
  this.timeout(60000)

  let admin: Pool | undefined
  let db: Kysely<Database> | undefined
  const boren = makeId('team')
  const hawks = makeId('team')
  const pueyers = makeId('team')

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
    const pool = new Pool({ connectionString: scratchUrl })
    await migrateUp(pool, migrations)
    await pool.end()
    db = makeDatabase(scratchUrl)
    await db
      .insertInto('teams')
      .values([
        { id: boren, name: 'Black Sox (Boren)' },
        { id: hawks, name: 'Hawks' },
        { id: pueyers, name: 'Pueyers', kind: 'external' }
      ])
      .execute()
  })

  after(async function () {
    if (db != null) await db.destroy()
    if (admin != null) {
      await admin.query(`drop database if exists ${scratchName}`)
      await admin.end()
    }
  })

  const season = [
    { id: hawks, name: 'Hawks' },
    { id: boren, name: 'Black Sox (Boren)' }
  ]

  it('finds a team of the season by its coach', async function () {
    const found = await resolveOpponent(db!, 'NP3 Boren', {
      seasonTeams: season,
      createdFrom: 'import'
    })
    expect(found).deep.equals({
      id: boren,
      name: 'Black Sox (Boren)',
      found: 'season'
    })
  })

  it('finds a team of the season by its normalised name', async function () {
    const found = await resolveOpponent(db!, 'hawks 2', {
      seasonTeams: season,
      createdFrom: 'import'
    })
    expect(found.id).equals(hawks)
    expect(found.found).equals('season')
  })

  it('finds an external team an earlier run made', async function () {
    const known = new Map<string, string>()
    const found = await resolveOpponent(db!, 'Pueyers - Livestream', {
      seasonTeams: season,
      createdFrom: 'import',
      known
    })
    expect(found).deep.equals({
      id: pueyers,
      name: 'Pueyers',
      found: 'external'
    })
    expect(known.get('pueyers')).equals(pueyers)

    const again = await resolveOpponent(db!, 'Pueyers', {
      seasonTeams: season,
      createdFrom: 'import',
      known
    })
    expect(again).deep.equals({ id: pueyers, name: 'Pueyers', found: 'known' })
  })

  it('makes an external team for a name nobody holds', async function () {
    const found = await resolveOpponent(db!, 'Tierrasanta', {
      seasonTeams: [],
      createdFrom: 'import'
    })
    expect(found.found).equals('created')
    const row = await db!
      .selectFrom('teams')
      .select(['name', 'kind', 'created_from'])
      .where('id', '=', found.id)
      .executeTakeFirstOrThrow()
    expect(row).deep.equals({
      name: 'Tierrasanta',
      kind: 'external',
      created_from: 'import'
    })

    const again = await resolveOpponent(db!, 'Tierrasanta', {
      seasonTeams: [],
      createdFrom: 'import'
    })
    expect(again).deep.equals({
      id: found.id,
      name: 'Tierrasanta',
      found: 'external'
    })
  })

  it('records where a team it makes came from', async function () {
    const found = await resolveOpponent(db!, 'Scheduled Rivals', {
      seasonTeams: [],
      createdFrom: 'api'
    })
    const row = await db!
      .selectFrom('teams')
      .select(['created_from'])
      .where('id', '=', found.id)
      .executeTakeFirstOrThrow()
    expect(row.created_from).equals('api')
  })

  it('writes nothing on a dry run', async function () {
    const found = await resolveOpponent(db!, 'Nobody Anywhere', {
      seasonTeams: [],
      createdFrom: 'import',
      dryRun: true
    })
    expect(found.found).equals('created')
    const row = await db!
      .selectFrom('teams')
      .select(['id'])
      .where('id', '=', found.id)
      .executeTakeFirst()
    expect(row).equals(undefined)
  })
})
