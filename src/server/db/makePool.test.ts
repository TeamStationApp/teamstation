import { expect } from 'chai'
import { after, before, describe, it } from 'mocha'
import { Pool } from 'pg'

import { testDatabaseUrl } from '../../migrate/testDatabase'
import { makePool } from './database'

describe('the database pool', () => {
  let admin: Pool

  before(() => {
    admin = new Pool({ connectionString: testDatabaseUrl })
  })

  after(async () => {
    await admin.end()
  })

  it('hears an idle connection lost to a restart instead of crashing', async () => {
    const logged: string[] = []
    const pool = makePool(testDatabaseUrl, message => logged.push(message))
    const client = await pool.connect()
    const { rows } = await client.query<{ pid: number }>(
      'select pg_backend_pid() as pid'
    )
    client.release()
    expect(pool.idleCount).to.equal(1)

    await admin.query('select pg_terminate_backend($1)', [rows[0].pid])
    await waitFor(() => pool.totalCount === 0)

    expect(logged).to.have.length(1)
    expect(logged[0]).to.match(/^database: connection lost: /)
    const again = await pool.query<{ one: number }>('select 1 as one')
    expect(again.rows[0].one).to.equal(1)
    await pool.end()
  })

  it('hears a checked-out connection lost mid-query: the query rejects and the process stays up', async () => {
    const logged: string[] = []
    const pool = makePool(testDatabaseUrl, message => logged.push(message))
    const client = await pool.connect()
    const { rows } = await client.query<{ pid: number }>(
      'select pg_backend_pid() as pid'
    )
    // Unheard, the 'error' this connection raises below would be thrown out of
    // the socket's event handler, and mocha would fail the run as uncaught.
    const running = client.query('select pg_sleep(30)')
    await admin.query('select pg_terminate_backend($1)', [rows[0].pid])

    let failure: unknown
    try {
      await running
    } catch (error) {
      failure = error
    }
    expect(String(failure)).to.match(/terminat/)
    await waitFor(() => logged.length > 0)
    expect(logged[0]).to.match(/^database: connection lost: /)

    client.release()
    expect(pool.totalCount).to.equal(0)
    const again = await pool.query<{ one: number }>('select 1 as one')
    expect(again.rows[0].one).to.equal(1)
    await pool.end()
  })
})

async function waitFor(done: () => boolean): Promise<void> {
  const deadline = Date.now() + 5000
  while (!done()) {
    if (Date.now() > deadline) throw new Error('timed out')
    await new Promise(resolve => setTimeout(resolve, 10))
  }
}
