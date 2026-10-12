import { expect } from 'chai'
import { describe, it } from 'mocha'

import { makePool } from './database'

describe('the database pool', () => {
  it('logs an idle connection lost to a restart instead of crashing', async () => {
    const logged: string[] = []
    const pool = makePool('postgres://localhost:1/none', message =>
      logged.push(message)
    )
    expect(() =>
      pool.emit('error', new Error('terminating connection'))
    ).not.to.throw()
    expect(logged).to.deep.equal([
      'database: idle connection lost: terminating connection'
    ])
    await pool.end()
  })
})
