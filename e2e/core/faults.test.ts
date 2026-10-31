import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { createServer, request, type Server } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { expect } from 'chai'
import { WebSocket, WebSocketServer } from 'ws'

import { killApp, refuseUnreachable, styleScript } from '../faults/apply'
import { faultProblems, FAULTS } from '../faults/catalogue'
import { corruptShown, startFaultProxy } from '../faults/proxy'
import { caughtByLayer, detectFault } from './detect'
import { INVARIANTS } from './invariants'
import { appendLedger, type DetectRow, ledgerPath, readLedger } from './ledger'
import { BlockedError } from './result'
import { buildScorecard } from './scorecard'

interface Reply {
  status: number
  body: string
}

async function ask(
  url: string,
  method = 'GET',
  timeoutMs = 2000
): Promise<Reply | 'hung'> {
  return await new Promise((resolve, reject) => {
    const req = request(url, { method }, res => {
      let body = ''
      res.on('data', chunk => (body += chunk))
      res.on('end', () => {
        resolve({ status: res.statusCode ?? 0, body })
      })
    })
    req.setTimeout(timeoutMs, () => {
      req.destroy()
      resolve('hung')
    })
    req.on('error', reject)
    req.end()
  })
}

describe('the fault proxy', function () {
  let server: Server
  let target = ''
  let writes = 0
  let sockets: WebSocketServer

  before(async function () {
    server = createServer((req, res) => {
      if (req.method !== 'GET') writes++
      if (req.url === '/api/v1/broken') {
        res.writeHead(503)
        res.end()
        return
      }
      if (req.url === '/page') {
        res.writeHead(200, { 'content-type': 'text/html' })
        res.end('<p>page</p>')
        return
      }
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ id: 'gam_1', name: 'Sox', score: 3 }))
    })
    sockets = new WebSocketServer({ server, path: '/socket' })
    sockets.on('connection', socket => {
      socket.send('hello')
    })
    await new Promise<void>(resolve => {
      server.listen(0, '127.0.0.1', resolve)
    })
    target = `http://127.0.0.1:${(server.address() as { port: number }).port}`
  })

  after(function () {
    sockets.close()
    server.closeAllConnections()
    server.close()
  })

  it('passes everything through with no fault, and records a real 5xx', async function () {
    const proxy = await startFaultProxy({ target })
    expect(await ask(`${proxy.url}/api/v1/game`)).deep.equals({
      status: 200,
      body: '{"id":"gam_1","name":"Sox","score":3}'
    })
    expect(((await ask(`${proxy.url}/api/v1/broken`)) as Reply).status).equals(
      503
    )
    expect(proxy.errors.map(row => row.status)).deep.equals([503])
    expect(proxy.injections).deep.equals([])
    await proxy.close()
  })

  it('leaves sign-in up by default, so a fault reaches the screens', async function () {
    const proxy = await startFaultProxy({ target, fault: 'api-500' })
    expect(((await ask(`${proxy.url}/api/v1/auth/me`)) as Reply).status).equals(
      200
    )
    expect(((await ask(`${proxy.url}/api/v1/authors`)) as Reply).status).equals(
      500
    )
    await proxy.close()
    const all = await startFaultProxy({
      target,
      fault: 'api-500',
      match: /^\/api\//
    })
    expect(((await ask(`${all.url}/api/v1/auth/me`)) as Reply).status).equals(
      500
    )
    await all.close()
  })

  it('applies a 500 to the matched route only, and records it', async function () {
    const proxy = await startFaultProxy({ target, fault: 'api-500' })
    expect(((await ask(`${proxy.url}/api/v1/game`)) as Reply).status).equals(
      500
    )
    expect(((await ask(`${proxy.url}/page`)) as Reply).status).equals(200)
    expect(proxy.errors.map(row => row.path)).deep.equals(['/api/v1/game'])
    expect(proxy.injections[0].fault).equals('api-500')
    await proxy.close()
  })

  it('hangs a matched route, and lets the rest through', async function () {
    const proxy = await startFaultProxy({ target, fault: 'api-hang' })
    expect(await ask(`${proxy.url}/api/v1/game`, 'GET', 100)).equals('hung')
    expect(((await ask(`${proxy.url}/page`)) as Reply).status).equals(200)
    await proxy.close()
  })

  it('answers garbage on a matched route', async function () {
    const proxy = await startFaultProxy({ target, fault: 'api-garbage' })
    expect(((await ask(`${proxy.url}/api/v1/game`)) as Reply).body).equals(
      '<<<not json>>>'
    )
    expect(((await ask(`${proxy.url}/page`)) as Reply).body).includes('page')
    await proxy.close()
  })

  it('alters what is shown, and only in JSON on a matched route', async function () {
    const proxy = await startFaultProxy({ target, fault: 'wrong-data' })
    const altered = JSON.parse(
      ((await ask(`${proxy.url}/api/v1/game`)) as Reply).body
    )
    expect(altered).deep.equals({
      id: 'gam_1',
      name: 'Corrupted',
      score: 4
    })
    expect(((await ask(`${proxy.url}/page`)) as Reply).body).includes('page')
    expect(proxy.injections.length).equals(1)
    await proxy.close()
    expect(corruptShown({ rows: [{ title: 'A' }], ok: true })).deep.equals({
      rows: [{ title: 'Corrupted' }],
      ok: true
    })
  })

  it('discards a write and answers success, leaving reads alone', async function () {
    const proxy = await startFaultProxy({ target, fault: 'not-saved' })
    const before = writes
    expect(
      ((await ask(`${proxy.url}/api/v1/game`, 'PUT')) as Reply).status
    ).equals(200)
    expect(writes).equals(before)
    expect(((await ask(`${proxy.url}/api/v1/game`)) as Reply).body).includes(
      'Sox'
    )
    await proxy.close()
    const clean = await startFaultProxy({ target })
    await ask(`${clean.url}/api/v1/game`, 'PUT')
    expect(writes).equals(before + 1)
    await clean.close()
  })

  it('carries a socket, and drops it under socket-drop', async function () {
    const message = async (url: string): Promise<string> =>
      await new Promise(resolve => {
        const socket = new WebSocket(`${url.replace('http', 'ws')}/socket`)
        socket.on('message', data => {
          socket.close()
          resolve((data as Buffer).toString())
        })
        socket.on('error', () => {
          resolve('dropped')
        })
      })
    const clean = await startFaultProxy({ target })
    expect(await message(clean.url)).equals('hello')
    await clean.close()
    const dropping = await startFaultProxy({ target, fault: 'socket-drop' })
    expect(await message(dropping.url)).equals('dropped')
    expect(dropping.injections.length).equals(1)
    await dropping.close()
  })

  it('reports a dead server as a 502', async function () {
    const proxy = await startFaultProxy({ target: 'http://127.0.0.1:9' })
    expect(((await ask(`${proxy.url}/api/v1/game`)) as Reply).status).equals(
      502
    )
    expect(proxy.errors[0].status).equals(502)
    await proxy.close()
  })
})

describe('applying faults', function () {
  it('writes a style only for a style fault', function () {
    expect(styleScript('layout-shift')).includes('translateY(40px)')
    expect(styleScript('api-500')).equals(undefined)
  })

  it('blocks where a fault cannot run, rather than counting a survivor', function () {
    expect(() => {
      refuseUnreachable('layout-shift', 'ios-app')
    }).to.throw(BlockedError)
    expect(() => {
      refuseUnreachable('app-crash', 'web-chromium')
    }).to.throw(BlockedError)
    expect(() => {
      refuseUnreachable('nonsense', 'web-chromium')
    }).to.throw('Unknown fault')
    refuseUnreachable('layout-shift', 'web-chromium')
    refuseUnreachable('app-crash', 'android-app')
    refuseUnreachable('api-500', 'ios-app')
  })

  it('kills the app the way each platform does', function () {
    const calls: Array<[string, string[]]> = []
    const exec = (file: string, args: string[]): void => {
      calls.push([file, args])
    }
    killApp('ios-app', 'sim', 'app.test', exec)
    killApp('android-app', 'emu', 'app.test', exec)
    expect(calls).deep.equals([
      ['xcrun', ['simctl', 'terminate', 'sim', 'app.test']],
      ['adb', ['-s', 'emu', 'shell', 'am', 'force-stop', 'app.test']]
    ])
  })
})

describe('the catalogue', function () {
  const all = Object.keys(FAULTS)

  it('passes a fully converted category that names or excuses every fault', function () {
    expect(faultProblems({ tess: all }, [])).deep.equals([])
    const rest = all.filter(name => name !== 'frozen-video')
    expect(
      faultProblems({ tess: rest }, [], {
        tess: { 'frozen-video': 'No video in this category' }
      })
    ).deep.equals([])
  })

  it('fails when a converted category leaves a fault unnamed and unexcused', function () {
    const problems = faultProblems({ tess: all.slice(1) }, [])
    expect(problems).length(1)
    expect(problems[0]).includes(`no spec names "${all[0]}"`)
  })

  it('passes while the category still has legacy entries, but not an unknown name', function () {
    expect(faultProblems({ tess: [] }, ['tess'])).deep.equals([])
    expect(faultProblems({ tess: ['nonsense'] }, ['tess'])[0]).includes(
      'unknown fault'
    )
  })
})

function row(over: Partial<DetectRow>): DetectRow {
  return {
    kind: 'detect',
    at: '2026-10-30T00:00:00.000Z',
    scenario: 'app-shell/lists/list-screens#a',
    surface: 'web-chromium',
    fault: 'layout-shift',
    ref: 'abc',
    caught: true,
    caughtBy: 'golden',
    expectedLayer: true,
    status: 'failed',
    ...over
  }
}

describe('the scorecard', function () {
  const now = Date.parse('2026-10-31T00:00:00.000Z')

  it('aggregates by category and layer, with each result’s age', function () {
    const card = buildScorecard(
      [
        row({}),
        row({ fault: 'blank-screen', caughtBy: 'invariant' }),
        row({
          scenario: 'schedule/rsvp/eligibility#roster-removal',
          fault: 'wrong-data',
          caughtBy: 'expect'
        }),
        row({
          scenario: 'schedule/rsvp/eligibility#roster-removal',
          fault: 'api-hang',
          caught: false,
          caughtBy: 'none'
        })
      ],
      now
    )
    expect(card.categories.map(c => c.category)).deep.equals([
      'app-shell',
      'schedule'
    ])
    const [shell, schedule] = card.categories
    expect(shell.rate).equals(1)
    expect(shell.layers).deep.equals({ golden: 1, invariant: 1 })
    expect(shell.faults[0].ageDays).equals(1)
    expect(schedule.rate).equals(0.5)
    expect(schedule.survivors).deep.equals(['api-hang'])
    expect(card.layers).deep.equals({ golden: 1, invariant: 1, expect: 1 })
    expect(card.caught).equals(3)
    expect(card.proven).equals(4)
  })

  it('uses a scenario’s latest proof, and a catch from any scenario in the category', function () {
    const older = row({ at: '2026-10-29T00:00:00.000Z' })
    const newer = row({ caught: false, caughtBy: 'none' })
    expect(buildScorecard([older, newer], now).caught).equals(0)
    expect(buildScorecard([newer, older], now).caught).equals(0)
    const other = row({ scenario: 'app-shell/lists/list-screens#b' })
    const card = buildScorecard([newer, other], now)
    expect(card.categories[0].survivors).deep.equals([])
    expect(card.caught).equals(1)
  })

  it('is empty with no results, and skips a fault it no longer knows', function () {
    expect(buildScorecard([], now).rate).equals(0)
    expect(buildScorecard([row({ fault: 'gone' })], now).proven).equals(0)
  })
})

describe('e2e detect', function () {
  function project(body: string, extra = ''): string {
    const root = mkdtempSync(join(tmpdir(), 'detect-'))
    mkdirSync(join(root, 'e2e/tests/area/feature'), { recursive: true })
    writeFileSync(
      join(root, 'e2e/tests/area/feature/thing.e2e.ts'),
      `export default {
  id: 'area/feature/thing', title: 'A thing', kind: 'e2e', covers: ['src/**'],
  stack: 'none', fixtures: [], exclusive: false,
  surfaces: { 'web-chromium': { devices: [] }, 'ios-app': { devices: [] } },
  services: [], apps: [], secrets: [], costUsd: 0, minutes: 1, guards: [],
  faults: [], manual: false, ${extra}
  scenarios: { main: async ctx => { ${body} } }
}
`
    )
    return root
  }

  const device = `const device = {
    hierarchy: async () => ({ children: [{ text: 'Sox' }] }),
    screenshot: async () => Buffer.from('x'),
    getConsoleLogs: async () => ({ data: '[]' }),
    evalBrowserScript: async options => { applied.push(options.script) },
    assertVisible: async () => {
      if (applied.length > 0) throw new Error('gone')
    }
  }
  const applied = []
  ctx.watch(device, { deviceClass: 'x' })`

  async function detect(
    root: string,
    fault = 'layout-shift',
    surface = 'web-chromium'
  ): Promise<{
    row: DetectRow
    exitCode: number
    ledger: DetectRow[]
  }> {
    const path = join(root, 'ledger.jsonl')
    const outcome = await detectFault(
      {
        id: 'area/feature/thing#main',
        surface,
        fault,
        settings: {},
        root,
        runDir: join(root, 'run')
      },
      path
    )
    return { ...outcome, ledger: readLedger(path) }
  }

  it('passes when the scenario goes red, and appends to the ledger', async function () {
    const root = project(
      `${device}; await ctx.checkpoint('screen', { expect: [{ text: 'Sox' }] })`
    )
    const { row: found, exitCode, ledger } = await detect(root)
    expect(exitCode).equals(0)
    expect(found.caught).equals(true)
    expect(found.caughtBy).equals('expect')
    expect(found.expectedLayer).equals(false)
    expect(ledger).deep.equals([found])
    const result = JSON.parse(
      readFileSync(join(root, 'run', 'result.json'), 'utf8')
    )
    expect(result.fault).equals('layout-shift')
  })

  it('fails when the scenario stays green, and records the survivor', async function () {
    const { exitCode, row: survivor, ledger } = await detect(project('return'))
    expect(exitCode).equals(1)
    expect(survivor.caught).equals(false)
    expect(survivor.caughtBy).equals('none')
    expect(ledger.length).equals(1)
  })

  it('counts neither a known failure nor an inconclusive run as caught', async function () {
    const known = await detect(
      project(
        'throw new Error("known")',
        'quarantine: { reason: "x", since: "y" },'
      )
    )
    expect(known.row.caught).equals(false)
    expect(known.exitCode).equals(1)
  })

  it('leaves the ledger alone when the fault could not run', async function () {
    const { exitCode, ledger } = await detect(
      project('return'),
      'layout-shift',
      'ios-app'
    )
    expect(exitCode).equals(2)
    expect(ledger).deep.equals([])
  })

  it('names the layer from what the run recorded', function () {
    const base = {
      id: 'x',
      basis: 'MEASURED',
      expect: 'pass',
      readBack: 'pass'
    }
    const result = (over: object, extra: object = {}): any => ({
      checkpoints: [{ ...base, ...over }],
      ...extra
    })
    const judged = (over: object): string => caughtByLayer(result(over))
    expect(judged({ expect: 'fail' })).equals('expect')
    expect(judged({ readBack: 'fail' })).equals('read-back')
    expect(judged({ visual: { verdict: 'fail' } })).equals('golden')
    expect(judged({ ask: { verdict: 'fail' } })).equals('ai')
    expect(
      judged({
        invariants: Object.fromEntries(
          INVARIANTS.map(name => [
            name,
            { verdict: name === 'errorText' ? 'fail' : 'pass' }
          ])
        )
      })
    ).equals('invariant')
    // Nothing recorded a failure, so what stopped the scenario decides.
    expect(caughtByLayer(result({}))).equals('expect')
    const errors = { serverErrors: [{ status: 500 }] }
    expect(caughtByLayer(result({}, errors), 'api-500')).equals('invariant')
    // A wrong value makes no 5xx, so one seen after the scenario stopped is not why.
    expect(caughtByLayer(result({}, errors), 'wrong-data')).equals('expect')
    expect(caughtByLayer(result({}, errors))).equals('expect')
    expect(caughtByLayer(result({}, { failureKind: 'crash' }))).equals(
      'test-crash'
    )
    expect(
      caughtByLayer(
        result({}, { failureKind: 'crash', serverErrors: [{ status: 500 }] })
      )
    ).equals('test-crash')
  })

  it('never counts a crash as the layer the catalogue expects', async function () {
    const root = project(`throw new TypeError('Invalid URL')`)
    const { row: crashed, exitCode } = await detect(root, 'api-500')
    expect(crashed.caught).equals(true)
    expect(crashed.caughtBy).equals('test-crash')
    expect(crashed.expectedLayer).equals(false)
    expect(exitCode).equals(0)
  })

  it('keeps a failure’s server errors and kind in the result', async function () {
    const root = project(
      `throw Object.assign(new Error('no'), { name: 'AssertionError' })`
    )
    await detect(root, 'api-500')
    const result = JSON.parse(
      readFileSync(join(root, 'run', 'result.json'), 'utf8')
    )
    expect(result.failureKind).equals('assertion')
    expect(result.status).equals('failed')
  })
})

describe('the ledger', function () {
  it('appends rows and reads them back, and an absent file is empty', function () {
    const path = join(mkdtempSync(join(tmpdir(), 'ledger-')), 'a', 'l.jsonl')
    expect(readLedger(path)).deep.equals([])
    appendLedger(path, row({}))
    appendLedger(path, row({ fault: 'api-500' }))
    expect(readLedger(path).map(r => r.fault)).deep.equals([
      'layout-shift',
      'api-500'
    ])
  })

  it('finds its file from the override, the settings, then the default', function () {
    expect(ledgerPath({ ledger: '/a' }, '/b')).equals('/b')
    expect(ledgerPath({ ledger: '/a' })).equals('/a')
    expect(ledgerPath({})).includes('teamstation-e2e')
  })
})
