import { expect } from 'chai'
import { after, before, describe, it } from 'mocha'
import { Pool } from 'pg'

import { seedFixture, type TokensFile } from './fixture'
import {
  measure,
  probeLongGame,
  renderProbes,
  runProbes,
  socketSubscribe
} from './probe'
import { TEST_AMOUNTS } from './testAmounts'
import {
  fakeStatementsView,
  openScratch,
  type Scratch,
  startTestServer,
  type TestServer
} from './testSupport'

describe('the probes', function () {
  this.timeout(120_000)

  let scratch: Scratch
  let server: TestServer
  let tokens: TokensFile

  before(async function () {
    scratch = await openScratch('probes')
    tokens = await seedFixture(scratch.db, {
      runId: 'probes',
      scale: 'small',
      overrides: TEST_AMOUNTS
    })
    await fakeStatementsView(scratch)
    server = await startTestServer(scratch)
  })
  after(async function () {
    await server.close()
    await scratch.drop()
  })

  it('reports statements, time and rows of what each thing cost', async function () {
    const pool = new Pool({ connectionString: scratch.url })
    const result = await measure(scratch.db, 'someone', 'a read', async () => {
      await pool.query(
        `update pg_stat_statements set calls = calls + 7, rows = rows + 3`
      )
    })
    await pool.end()
    expect(result.statements).equals(7)
    expect(result.rows).equals(3)
    expect(result.ms).above(0)
    expect(result.error).equals(undefined)
  })

  it('reports a failed step rather than a figure that looks fine', async function () {
    const result = await measure(scratch.db, 'someone', 'a read', async () => {
      throw new Error('refused')
    })
    expect(result.error).equals('refused')
    expect(renderProbes([result])).contains('failed: refused')
  })

  it('walks every worst-case account, and the long game', async function () {
    const results = await runProbes(scratch.db, server.base, tokens)
    const worst = tokens.accounts.filter(row => row.kind === 'worstCase')
    expect(new Set(results.map(row => row.account)).size).equals(
      worst.length + 1
    )
    const subscribes = results.filter(row => row.probe === 'socket subscribe')
    expect(subscribes.length).equals(worst.length)
    for (const row of subscribes)
      expect(row.error, row.account).equals(undefined)
    const pitch = results[results.length - 1]
    expect(pitch.probe).equals('score one pitch in the long game')
    expect(pitch.error).equals(undefined)
    expect(renderProbes(results)).contains('statements')
  })

  it('fails without a scorekeeper for the long game', async function () {
    let message = ''
    await probeLongGame(scratch.db, server.base, {
      accounts: [],
      games: tokens.games
    }).catch((error: Error) => {
      message = error.message
    })
    expect(message).equals('The long game has no scorekeeper')
  })

  it('answers a subscribe refused, unanswered or unreachable', async function () {
    const person = tokens.accounts.find(row => row.label === 'person.stranger')
    let message = ''
    await socketSubscribe(server.base, person!.token, 'gam_none').catch(
      (error: Error) => {
        message = error.message
      }
    )
    expect(message).not.equals('')
    message = ''
    await socketSubscribe(
      'http://127.0.0.1:1',
      person!.token,
      'gam_none'
    ).catch((error: Error) => {
      message = error.message
    })
    expect(message).contains('ECONNREFUSED')
    message = ''
    await socketSubscribe(
      server.base,
      person!.token,
      tokens.games[0].id,
      0
    ).catch((error: Error) => {
      message = error.message
    })
    expect(message).contains('did not answer in time')
  })
})
