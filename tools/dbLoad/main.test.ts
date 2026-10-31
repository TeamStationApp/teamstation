import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { expect } from 'chai'
import { after, before, describe, it } from 'mocha'
import { Pool } from 'pg'

import { readTokens } from './fixture'
import { runMain } from './main'
import {
  fakeStatementsView,
  openScratch,
  type Scratch,
  startTestServer,
  type TestServer
} from './testSupport'

describe('the command line', function () {
  this.timeout(240_000)

  let scratch: Scratch
  let server: TestServer
  let dir: string
  let tokensPath: string
  const lines: string[] = []
  const io = {
    log: (message: string): void => {
      lines.push(message)
    }
  }
  const run = async (...args: string[]): Promise<number> => {
    lines.length = 0
    return await runMain(args, io)
  }
  const refusal = async (...args: string[]): Promise<string> => {
    let message = ''
    await run(...args).catch((error: Error) => {
      message = error.message
    })
    return message
  }

  before(async function () {
    scratch = await openScratch('main')
    dir = mkdtempSync(join(tmpdir(), 'dbload-main-'))
    tokensPath = join(dir, 'tokens.json')
    expect(
      await run(
        '--database',
        scratch.url,
        '--scale',
        'small',
        '--accounts',
        '30',
        '--crowded',
        '10',
        '--run-id',
        'cli',
        '--tokens',
        tokensPath
      )
    ).equals(0)
    expect(lines.join('\n')).contains('every shape present')
    server = await startTestServer(scratch)
  })
  after(async function () {
    await server.close()
    rmSync(dir, { recursive: true })
    await scratch.drop()
  })

  const load = [
    '--database',
    () => scratch.url,
    '--tokens',
    () => tokensPath
  ] as const
  const flags = (): string[] =>
    load.map(item => (typeof item === 'function' ? item() : item))

  it('drives a run at any small size and writes its report', async function () {
    const report = join(dir, 'load.log')
    const code = await run(
      ...flags(),
      '--server',
      server.base,
      '--users',
      '4',
      '--games',
      '2',
      '--pitch-seconds',
      '0.2',
      '--rest-rate',
      '20',
      '--minutes',
      '0.05',
      '--connect-rate',
      '100',
      '--scoreboards',
      '1',
      '--streams',
      '1',
      '--event-schedule',
      '--report',
      report
    )
    expect(code).equals(0)
    const text = readFileSync(report, 'utf8')
    expect(text).contains('4 users, 2 games, 1 server(s)')
    const data = JSON.parse(readFileSync(`${report}.json`, 'utf8'))
    expect(data.posts).above(0)
    expect(data.postP95Ms).above(0)
    expect(data.socketsOpened).at.least(4)
    expect(data.connections.peak).above(0)
    expect(data.streamsStarted).equals(1)
  })

  it('leaves the scoring to the first of two rigs, and classes the pooler', async function () {
    const code = await run(
      ...flags(),
      '--server',
      server.base,
      '--users',
      '4',
      '--shard',
      '1/2',
      '--minutes',
      '0.01',
      '--pooler-address',
      '192.0.2.1'
    )
    expect(code).equals(0)
    expect(lines.join('\n')).contains('POST /games/:id/events: 0 posts')
  })

  it('reports an unreachable server as an error, not as zeros, and exits 1', async function () {
    const report = join(dir, 'down.log')
    const code = await run(
      ...flags(),
      '--server',
      'http://127.0.0.1:1',
      '--users',
      '1',
      '--minutes',
      '0',
      '--report',
      report
    )
    expect(code).equals(1)
    const data = JSON.parse(readFileSync(`${report}.json`, 'utf8'))
    expect(data.errors.unreachable).equals(1)
    expect(data.postP95Ms).equals(null)
    expect(readFileSync(report, 'utf8')).contains('p95 no data')
  })

  it('fails a run that needs statements where the extension is absent', async function () {
    const message = await refusal(
      ...flags(),
      '--server',
      server.base,
      '--users',
      '1',
      '--require-statements'
    )
    expect(message).contains('no pg_stat_statements')
  })

  it('refuses what cannot be run, saying what', async function () {
    expect(await refusal('--tokens', tokensPath)).contains('--database')
    expect(await refusal('--database', scratch.url)).contains('--tokens')
    expect(await refusal(...flags())).contains('--server')
    expect(await refusal(...flags(), '--server', server.base)).contains(
      '--users'
    )
    expect(
      await refusal(...flags(), '--server', server.base, '--users', 'many')
    ).contains('--users takes a number')
    expect(
      await refusal(...flags(), '--server', server.base, '--users', '100000')
    ).contains('--users 100000 is above')
    expect(
      await refusal(
        ...flags(),
        '--server',
        server.base,
        '--users',
        '1',
        '--games',
        '500'
      )
    ).contains('--games 500 is above the 5')
    expect(
      await refusal('--database', scratch.url, '--scale', 'small')
    ).contains('--tokens')
  })

  it('refuses a database not marked for load testing, in every mode', async function () {
    const unmarked = await openScratch('mainunmarked', false)
    try {
      const flagsThere = ['--database', unmarked.url, '--tokens', tokensPath]
      for (const mode of [
        ['--scale', 'small', '--run-id', 'no'],
        ['--cleanup'],
        ['--event', 'teamMerge'],
        ['--probe', '--server', server.base],
        ['--server', server.base, '--users', '1']
      ])
        expect(await refusal(...flagsThere, ...mode), mode.join(' ')).contains(
          'not marked for load testing'
        )
    } finally {
      await unmarked.drop()
    }
  })

  it('runs one event, and says when its copies are gone', async function () {
    expect(await run(...flags(), '--event', 'signOut')).equals(0)
    expect(lines[0]).contains('signOut copy 0')
    expect(await refusal(...flags(), '--event', 'nothing')).contains(
      'Unknown --event'
    )
  })

  it('probes, exiting 1 when a probe failed and writing the figures', async function () {
    await fakeStatementsView(scratch)
    const report = join(dir, 'probe.log')
    const code = await run(
      ...flags(),
      '--server',
      server.base,
      '--probe',
      '--report',
      report
    )
    // This server does not carry the team and season routes.
    expect(code).equals(1)
    expect(readFileSync(report, 'utf8')).contains('socket subscribe')
    const pool = new Pool({ connectionString: scratch.url })
    await pool.query('drop table pg_stat_statements')
    await pool.end()
  })

  it('cleans up by the run the tokens name', async function () {
    expect(readTokens(tokensPath).runId).equals('cli')
    expect(await run(...flags(), '--cleanup')).equals(0)
    expect(lines[0]).contains('"users":')
    const users = await scratch.db.selectFrom('users').select('id').execute()
    expect(users).deep.equals([])
  })
})
