import { execFileSync } from 'node:child_process'
import { randomBytes } from 'node:crypto'

import { expect } from 'chai'
import { after, before, describe, it } from 'mocha'
import { Client, Pool } from 'pg'

import type { Migration } from './runner'
import {
  createMigratedDatabase,
  testDatabaseUrl,
  testDatabaseUrlOf
} from './testDatabase'

describe('migrated scratch databases from a template', function () {
  this.timeout(30000)
  let admin: Pool
  const run = `${Date.now()}_${randomBytes(3).toString('hex')}`
  const made: string[] = []
  const schema = (label: string): Migration[] => [
    {
      name: `001demo_${run}_${label}`,
      up: 'create table demo_rows (id int primary key, label text)',
      down: 'drop table demo_rows'
    },
    {
      name: `002demo_${run}_${label}`,
      up: "insert into demo_rows values (1, 'seeded')",
      down: 'delete from demo_rows'
    }
  ]
  const databases = async (pattern: string): Promise<string[]> =>
    (
      await admin.query<{ datname: string }>(
        'select datname from pg_database where datname like $1 order by 1',
        [pattern]
      )
    ).rows.map(row => row.datname)
  const ownTemplates = async (): Promise<string[]> =>
    await databases(`teamstation\\_template\\_%\\_${process.pid}`)
  const create = async (
    label: string,
    migrations: Migration[]
  ): Promise<string> => {
    const name = `teamstation_tpltest_${run}_${label.toLowerCase()}`
    const existing = new Set(await ownTemplates())
    await createMigratedDatabase(admin, name, migrations)
    // Only the templates these tests made: later files share the others.
    for (const template of await ownTemplates())
      if (!existing.has(template)) made.push(template)
    made.push(name)
    return name
  }
  const read = async (
    name: string
  ): Promise<{ rows: unknown[]; applied: string[] }> => {
    const client = new Client({ connectionString: testDatabaseUrlOf(name) })
    await client.connect()
    try {
      const rows = (await client.query('select id, label from demo_rows')).rows
      const applied = (
        await client.query<{ name: string }>(
          'select name from schema_migrations order by name'
        )
      ).rows.map(row => row.name)
      return { rows, applied }
    } finally {
      await client.end()
    }
  }

  before(async function () {
    admin = new Pool({ connectionString: testDatabaseUrl })
    try {
      await admin.query('select 1')
    } catch {
      await admin.end()
      this.skip()
    }
  })
  after(async function () {
    if (admin.ended) return
    for (const name of made)
      await admin.query(`drop database if exists ${name} with (force)`)
    await admin.end()
  })

  it('gives each copy the migrated schema, its rows and its history', async () => {
    const migrations = schema('copies')
    const first = await create('first', migrations)
    const second = await create('second', migrations)
    for (const name of [first, second])
      expect(await read(name)).deep.equals({
        rows: [{ id: 1, label: 'seeded' }],
        applied: migrations.map(m => m.name)
      })
    // A copy is its own database: writing one leaves the other as it was.
    const client = new Client({ connectionString: testDatabaseUrlOf(first) })
    await client.connect()
    await client.query("update demo_rows set label = 'changed'")
    await client.end()
    expect((await read(second)).rows).deep.equals([{ id: 1, label: 'seeded' }])
  })

  it('migrates one template per schema and reuses it', async () => {
    const before = (await ownTemplates()).length
    const migrations = schema('reuse')
    await create('reuseA', migrations)
    await create('reuseB', migrations)
    expect((await ownTemplates()).length).equals(before + 1)
    const changed = schema('reuse')
    changed[1] = { ...changed[1], up: "insert into demo_rows values (2, 'x')" }
    const other = await create('reuseChanged', changed)
    expect((await ownTemplates()).length).equals(before + 2)
    expect((await read(other)).rows).deep.equals([{ id: 2, label: 'x' }])
  })

  it("drops this host's templates whose process has exited, and keeps the rest", async () => {
    await create('hostProbe', schema('hostProbe'))
    const own = await ownTemplates()
    const host = /_([0-9a-f]{6})_\d+$/.exec(own[0])![1]
    const otherHost = host === 'ffffff' ? 'eeeeee' : 'ffffff'
    const exited = Number(
      execFileSync(process.execPath, ['-p', 'process.pid'], {
        encoding: 'utf8'
      })
    )
    const orphan = `teamstation_template_${run.slice(-6)}aaaaaa_${host}_${exited}`
    const elsewhere = `teamstation_template_${run.slice(-6)}bbbbbb_${otherHost}_${exited}`
    for (const name of [orphan, elsewhere])
      await admin.query(`create database ${name}`)
    made.push(elsewhere)
    // A schema this process has not seen makes a template, which sweeps first.
    await create('sweep', schema('sweep'))
    expect(await databases(orphan)).deep.equals([])
    expect(await databases(elsewhere)).deep.equals([elsewhere])
  })
})
