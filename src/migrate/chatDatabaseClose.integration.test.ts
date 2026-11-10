import { expect } from 'chai'
import { after, before, describe, it } from 'mocha'
import { Client, Pool } from 'pg'

import { dropScratchDatabase, testDatabaseUrl } from './testDatabase'

describe('scratch database graceful cleanup', function () {
  this.timeout(30000)
  let admin: Pool
  const prefix = `teamstation_cleanup_${Date.now()}_${process.pid}`
  const url = (name: string): string =>
    testDatabaseUrl.replace(/\/[^/]*$/, `/${name}`)
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
    if (!admin.ended) await admin.end()
  })

  it('waits behind a real held client and drops only after its graceful release', async function () {
    const name = `${prefix}_held`
    await admin.query(`create database "${name}"`)
    const client = new Client({ connectionString: url(name) })
    await client.connect()
    let observed!: () => void
    const waiting = new Promise<void>(resolve => {
      observed = resolve
    })
    const drop = dropScratchDatabase(admin, name, {
      onWait: sessions => {
        expect(sessions).greaterThan(0)
        observed()
      }
    })
    try {
      await waiting
      expect((await client.query('select 1 as alive')).rows).length(1)
      expect(
        (
          await admin.query('select 1 from pg_database where datname=$1', [
            name
          ])
        ).rows
      ).length(1)
      await client.end()
      await drop
      expect(
        (
          await admin.query('select 1 from pg_database where datname=$1', [
            name
          ])
        ).rows
      ).length(0)
    } finally {
      await client.end()
      await dropScratchDatabase(admin, name)
    }
  })

  it('fails a leaked-session deadline without terminating or dropping the database', async function () {
    const name = `${prefix}_leaked`
    await admin.query(`create database "${name}"`)
    const client = new Client({ connectionString: url(name) })
    await client.connect()
    try {
      let failure: unknown
      await dropScratchDatabase(admin, name, { timeoutMs: 25 }).catch(
        (error: unknown) => {
          failure = error
        }
      )
      expect(String(failure)).contains('still has open sessions')
      expect((await client.query('select 1 as alive')).rows).length(1)
      expect(
        (
          await admin.query('select 1 from pg_database where datname=$1', [
            name
          ])
        ).rows
      ).length(1)
    } finally {
      await client.end()
      await dropScratchDatabase(admin, name)
    }
  })

  it('rejects non-scratch and unsafe identifiers before issuing a database command', async function () {
    for (const name of ['shared_database', 'teamstation_invalid"name']) {
      let failure: unknown
      await dropScratchDatabase(admin, name).catch((error: unknown) => {
        failure = error
      })
      expect(String(failure)).contains('generated scratch database name')
    }
  })
})
