import { expect } from 'chai'
import { after, before, describe, it } from 'mocha'
import { Client } from 'pg'

import {
  backendState,
  parseActivity,
  Sampler,
  sequentialScans,
  statementDeltas
} from './sampler'
import { openScratch, type Scratch } from './testSupport'

describe('the sampler', function () {
  this.timeout(60_000)

  it('reads every pg_stat_activity state', function () {
    for (const state of [
      'active',
      'idle',
      'idle in transaction',
      'idle in transaction (aborted)',
      'fastpath function call',
      'disabled'
    ])
      expect(backendState(state)).equals(state)
    expect(backendState(null)).equals('unknown')
    expect(backendState('something new')).equals('unknown')
  })

  it('classes a backend as pooled by the address it came from', function () {
    const counts = parseActivity(
      [
        {
          application_name: 'teamstation-worker',
          state: 'idle',
          client_addr: '192.168.0.5',
          count: '4'
        },
        {
          application_name: 'teamstation-worker',
          state: 'idle',
          client_addr: '192.168.0.9',
          count: '1'
        },
        {
          application_name: 'teamstation-worker',
          state: 'idle',
          client_addr: '192.168.0.10',
          count: 2
        },
        { application_name: null, state: null, client_addr: null, count: 1 }
      ],
      '192.168.0.5'
    )
    expect(counts).deep.equals([
      {
        applicationName: 'teamstation-worker',
        state: 'idle',
        pooled: true,
        count: 4
      },
      {
        applicationName: 'teamstation-worker',
        state: 'idle',
        pooled: false,
        count: 3
      },
      { applicationName: '', state: 'unknown', pooled: false, count: 1 }
    ])
    expect(
      parseActivity([
        {
          application_name: 'a',
          state: 'idle',
          client_addr: '192.168.0.5',
          count: 1
        }
      ])[0].pooled
    ).equals(false)
  })

  it('takes statement deltas, biggest first, leaving out the unchanged', function () {
    const before_ = [
      {
        queryid: '1',
        query: 'a',
        calls: '10',
        total_exec_time: '5',
        rows: '1'
      },
      { queryid: '2', query: 'b', calls: '10', total_exec_time: '5', rows: '1' }
    ]
    const after_ = [
      {
        queryid: '1',
        query: 'a',
        calls: '12',
        total_exec_time: '6',
        rows: '3'
      },
      {
        queryid: '2',
        query: 'b',
        calls: '10',
        total_exec_time: '5',
        rows: '1'
      },
      { queryid: '3', query: 'c', calls: 3, total_exec_time: 30, rows: 4 }
    ]
    expect(statementDeltas(before_, after_)).deep.equals([
      { queryId: '3', query: 'c', calls: 3, totalMs: 30, rows: 4 },
      { queryId: '1', query: 'a', calls: 2, totalMs: 1, rows: 2 }
    ])
  })

  it('names large tables read by sequential scan, not small ones', function () {
    expect(
      sequentialScans(
        [
          { relname: 'events', seq_scan: '5', n_live_tup: '90000' },
          { relname: 'leagues', seq_scan: '5', n_live_tup: '2' },
          { relname: 'games', seq_scan: '9', n_live_tup: '8000' }
        ],
        [
          { relname: 'events', seq_scan: '7', n_live_tup: '90000' },
          { relname: 'leagues', seq_scan: '50', n_live_tup: '2' },
          { relname: 'games', seq_scan: '9', n_live_tup: '8000' },
          { relname: 'new_one', seq_scan: 1, n_live_tup: 2000 }
        ]
      )
    ).deep.equals([
      { table: 'events', scans: 2, rows: 90000 },
      { table: 'new_one', scans: 1, rows: 2000 }
    ])
  })

  describe('against a database', function () {
    let scratch: Scratch
    let client: Client

    before(async function () {
      scratch = await openScratch('sampler')
      client = new Client({
        connectionString: scratch.url,
        application_name: 'dbload-sampler'
      })
      await client.connect()
    })
    after(async function () {
      await client.end()
      await scratch.drop()
    })

    it('samples connections and waits, and no statements without the extension', async function () {
      const holder = new Client({
        connectionString: scratch.url,
        application_name: 'held-open'
      })
      await holder.connect()
      await holder.query('begin')
      await holder.query('select 1')
      const sampler = new Sampler({ client, intervalMs: 10 })
      await sampler.start()
      await new Promise(resolve => {
        setTimeout(resolve, 60)
      })
      await sampler.stop()
      await holder.query('rollback')
      await holder.end()
      expect(sampler.hasStatements).equals(false)
      const last = sampler.samples[sampler.samples.length - 1]
      expect(sampler.samples.length).at.least(2)
      expect(last.statements).equals(null)
      expect(last.backends).deep.include({
        applicationName: 'held-open',
        state: 'idle in transaction',
        pooled: false,
        count: 1
      })
      expect(last.oldestTransactionSeconds).above(0)
      expect(sampler.statements()).deep.equals([])
    })

    it('fails a run that requires statements when the extension is absent', async function () {
      const sampler = new Sampler({ client, requireStatements: true })
      let message = ''
      await sampler.start().catch((error: Error) => {
        message = error.message
      })
      expect(message).contains('no pg_stat_statements')
    })
  })

  it('reads statements where the extension exists, and survives a failed read', async function () {
    let calls = 100
    const errors: string[] = []
    let failing = false
    const client = {
      query: async (text: string) => {
        if (failing) throw new Error('connection lost')
        if (text.includes('pg_extension')) return { rows: [{ '?column?': 1 }] }
        if (text.includes('sum(calls)'))
          return { rows: [{ calls: String(calls), total: '12.5' }] }
        if (text.includes('from pg_stat_statements')) {
          calls += 50
          return {
            rows: [
              {
                queryid: '1',
                query: 'select 1',
                calls: String(calls),
                total_exec_time: '9',
                rows: '1'
              }
            ]
          }
        }
        if (text.includes('pg_stat_user_tables'))
          return {
            rows: [{ relname: 'events', seq_scan: 1, n_live_tup: 5000 }]
          }
        if (text.includes('group by'))
          return {
            rows: [
              {
                application_name: 'a',
                state: 'active',
                client_addr: null,
                count: 1
              }
            ]
          }
        return { rows: [{ waiters: '2', object_waiters: '1', oldest: null }] }
      }
    } as unknown as Pick<Client, 'query'>
    const sampler = new Sampler({
      client,
      requireStatements: true,
      onError: error => errors.push(error.message)
    })
    await sampler.start()
    expect(sampler.samples[0].statements).deep.equals({
      calls: 150,
      totalMs: 12.5
    })
    expect(sampler.samples[0].lockWaiters).equals(2)
    expect(sampler.samples[0].objectLockWaiters).equals(1)
    expect(sampler.samples[0].oldestTransactionSeconds).equals(0)
    failing = true
    await sampler.sample()
    expect(errors).deep.equals(['connection lost'])
    failing = false
    await sampler.stop()
    expect(sampler.statements()[0].calls).equals(50)
    expect(sampler.sequentialScans()).deep.equals([])
  })
})
