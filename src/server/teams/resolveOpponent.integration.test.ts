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
const scratchName = `teamstation_opponent_${Date.now()}`
const scratchUrl = adminUrl.replace(/\/[^/]*$/, `/${scratchName}`)

describe('resolving an opponent by name', function () {
  this.timeout(60000)

  let admin: Pool | undefined
  let db: Kysely<Database> | undefined
  const sealions = makeId('team')
  const herons = makeId('team')
  const gulls = makeId('team')

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
        { id: sealions, name: 'Sea Lions (Gehrig)' },
        { id: herons, name: 'Harbor Herons' },
        { id: gulls, name: 'Gulls - Livestream', kind: 'external' }
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
    { id: herons, name: 'Harbor Herons' },
    { id: sealions, name: 'Sea Lions (Gehrig)' }
  ]

  it('finds a team of the season by its name, in any case and spacing', async function () {
    const found = await resolveOpponent(db!, ' HARBOR  herons ', {
      seasonTeams: season,
      createdFrom: 'import',
      dryRun: true
    })
    expect(found).deep.equals({
      id: herons,
      name: 'Harbor Herons',
      found: 'season'
    })
  })

  it('finds no team of the season by a coach, a number or a bracket', async function () {
    for (const name of [
      'NP3 Gehrig',
      'Harbor Herons 2',
      'Sea Lions',
      'Sea Lions (Ruth)'
    ]) {
      const found = await resolveOpponent(db!, name, {
        seasonTeams: season,
        createdFrom: 'import',
        dryRun: true
      })
      expect(found.found, name).equals('created')
      expect(found.name, name).equals(name)
    }
  })

  it('finds an external team an earlier run made, by its own name only', async function () {
    const known = new Map<string, string>()
    // A looser spelling is another team.
    const loose = await resolveOpponent(db!, 'Gulls', {
      seasonTeams: season,
      createdFrom: 'import',
      dryRun: true
    })
    expect(loose.found).equals('created')

    const found = await resolveOpponent(db!, 'gulls -  livestream', {
      seasonTeams: season,
      createdFrom: 'import',
      known
    })
    expect(found).deep.equals({
      id: gulls,
      name: 'Gulls - Livestream',
      found: 'external'
    })
    expect(known.get('gulls - livestream')).equals(gulls)

    const again = await resolveOpponent(db!, 'Gulls - Livestream', {
      seasonTeams: season,
      createdFrom: 'import',
      known
    })
    expect(again).deep.equals({
      id: gulls,
      name: 'Gulls - Livestream',
      found: 'known'
    })
  })

  it('makes an external team for a name nobody holds', async function () {
    const found = await resolveOpponent(db!, 'Cormorant Cove', {
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
      name: 'Cormorant Cove',
      kind: 'external',
      created_from: 'import'
    })

    const again = await resolveOpponent(db!, 'Cormorant Cove', {
      seasonTeams: [],
      createdFrom: 'import'
    })
    expect(again).deep.equals({
      id: found.id,
      name: 'Cormorant Cove',
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

  it('finds the older of two external teams of one name, every time', async function () {
    const newer = makeId('team')
    const older = makeId('team')
    // Written newer first, so the table's own order would find it.
    await db!
      .insertInto('teams')
      .values([
        {
          id: newer,
          name: 'Demo Otters',
          kind: 'external',
          created_at: new Date('2026-02-02T00:00:00Z')
        },
        {
          id: older,
          name: 'DEMO OTTERS',
          kind: 'external',
          created_at: new Date('2026-01-01T00:00:00Z')
        }
      ])
      .execute()
    const found = await resolveOpponent(db!, 'demo otters', {
      seasonTeams: [],
      createdFrom: 'import'
    })
    expect(found).deep.equals({
      id: older,
      name: 'DEMO OTTERS',
      found: 'external'
    })
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
