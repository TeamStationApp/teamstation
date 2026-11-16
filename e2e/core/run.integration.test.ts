import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

import { expect } from 'chai'
import { describe, it } from 'mocha'

import { Budget, type Judge } from './judge'
import { runScenario } from './run'

const CORE = resolve(__dirname)

/**
 * A repository holding one web scenario whose golden checkpoint differs on
 * the attempts listed in `differOn` (1 is the first) and matches otherwise.
 * A mismatch is recorded, not thrown, as a moved screen is.
 */
function goldenRoot(differOn: number[], checkpoint = '{ golden: {} }'): string {
  const root = mkdtempSync(join(tmpdir(), 'e2e-run-'))
  const dir = join(root, 'e2e', 'tests', 'area', 'feature')
  mkdirSync(dir, { recursive: true })
  writeFileSync(
    join(dir, 'thing.e2e.ts'),
    `const fs = require('fs')
const path = require('path')
require(${JSON.stringify(join(CORE, 'result'))})
const tries = path.join(__dirname, 'tries')
export default {
  id: 'area/feature/thing',
  title: 'A thing',
  kind: 'e2e',
  covers: ['src/**'],
  stack: 'none',
  fixtures: [],
  exclusive: false,
  surfaces: { 'web-chromium': { devices: [] } },
  services: [],
  apps: [],
  secrets: [],
  costUsd: 0,
  minutes: 1,
  guards: [],
  faults: [],
  manual: false,
  scenarios: {
    main: async ctx => {
      const attempt = (fs.existsSync(tries) ? Number(fs.readFileSync(tries, 'utf8')) : 0) + 1
      fs.writeFileSync(tries, String(attempt))
      const differs = ${JSON.stringify(differOn)}.includes(attempt)
      const device = {
        hierarchy: async () => ({ children: [{ text: 'Sox' }] }),
        screenshot: async () => Buffer.from('x'),
        getConsoleLogs: async () => ({ data: '[]' }),
        assertVisible: async () => ({}),
        assertScreenshot: async options => {
          fs.mkdirSync(path.dirname(options.captureOut), { recursive: true })
          fs.writeFileSync(options.captureOut, 'frame')
          if (!differs) return { data: {} }
          throw Object.assign(new Error('screens differ'), { code: 'COMMAND_FAILED', result: { data: { matchPercentage: 50 } } })
        }
      }
      ctx.watch(device, { deviceClass: 'class-1' })
      await ctx.checkpoint('screen', ${checkpoint})
    }
  }
}
`
  )
  return root
}

describe('run, with a golden checkpoint', function () {
  it('retries an attempt whose golden differed, and passes on a match', async function () {
    const root = goldenRoot([1])
    const { result } = await runScenario({
      id: 'area/feature/thing#main',
      surface: 'web-chromium',
      settings: {},
      root,
      runDir: join(root, 'run'),
      retries: 1
    })
    expect(result.status).equals('passed')
    expect(result.attempts).equals(2)
  })

  it('fails a golden that differs on every attempt as an assertion', async function () {
    const root = goldenRoot([1, 2])
    const { result } = await runScenario({
      id: 'area/feature/thing#main',
      surface: 'web-chromium',
      settings: {},
      root,
      runDir: join(root, 'run'),
      retries: 1
    })
    expect(result.status).equals('failed')
    expect(result.reason).includes('screens differ')
    expect(result.failureKind).equals('assertion')
    expect(result.attempts).equals(2)
  })

  it('reports what the judge cost on every attempt, not only the last', async function () {
    const root = goldenRoot([], "{ ask: 'The score reads 3' }")
    let asks = 0
    const judge: Judge = {
      id: 'fake',
      ask: async () => ({
        verdict: ++asks === 1 ? 'fail' : 'pass',
        confidence: 1,
        observed: 'seen',
        model: 'm',
        escalated: false,
        costUsd: 0.25,
        latencyMs: 1
      }),
      annotate: async () => undefined
    }
    const { result } = await runScenario({
      id: 'area/feature/thing#main',
      surface: 'web-chromium',
      settings: {},
      root,
      runDir: join(root, 'run'),
      retries: 1,
      judges: { judge, budget: new Budget(1), authoritative: true }
    })
    expect(result.status).equals('passed')
    expect(result.attempts).equals(2)
    expect(result.costUsd).equals(0.5)
  })

  it('makes one attempt at a blocked scenario, and calls it no crash', async function () {
    const root = goldenRoot([])
    const spec = join(root, 'e2e', 'tests', 'area', 'feature', 'thing.e2e.ts')
    writeFileSync(
      spec,
      readFileSync(spec, 'utf8').replace(
        "await ctx.checkpoint('screen',",
        'throw new (require(' +
          JSON.stringify(join(CORE, 'result')) +
          ").BlockedError)('no phone'); await ctx.checkpoint('screen',"
      )
    )
    const { result } = await runScenario({
      id: 'area/feature/thing#main',
      surface: 'web-chromium',
      settings: {},
      root,
      runDir: join(root, 'run'),
      retries: 2
    })
    expect(result.status).equals('blocked')
    expect(result.reason).equals('no phone')
    expect(result.attempts).equals(undefined)
    expect(result.failureKind).equals(undefined)
    expect(
      readFileSync(
        join(root, 'e2e', 'tests', 'area', 'feature', 'tries'),
        'utf8'
      )
    ).equals('1')
  })
})
