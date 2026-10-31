import { execFileSync } from 'node:child_process'
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync
} from 'node:fs'
import { createServer, request } from 'node:http'
import { connect } from 'node:net'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

import { expect } from 'chai'
import { ESLint } from 'eslint'
import { describe, it } from 'mocha'

import { applyEmulation, clockScript } from './browserCdp'
import { main } from './cli'
import { goesToApi, startFront } from './front'
import { globToRegExp, matchesAny } from './glob'
import { legacyReport, readLegacy } from './legacy'
import { lintFile } from './lint'
import {
  attachDevice,
  connectDaemon,
  maestroBin,
  maestroClient
} from './maestro'
import {
  buildManifest,
  findScenario,
  readManifest,
  renderManifest,
  testFiles
} from './manifest'
import { PLACES_ANSWERS, placesAnswer, startPlacesStub } from './placesStub'
import { planScenarios } from './plan'
import { apiBaseFor, prepareApp } from './prepare'
import { BlockedError, exitCodeFor, HarnessError, type Status } from './result'
import { runScenario } from './run'
import { selectScenarios } from './select'
import { hasSecret, loadSettings, readSecret, settingsPath } from './settings'
import { defineE2e, type E2eSpec, specProblems } from './spec'
import { freePort, lanAddress, startStack } from './stack'
import { trackedFiles, validate } from './validate'

const CORE = resolve(__dirname)

function tempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'e2e-core-'))
  mkdirSync(join(root, 'e2e', 'tests', 'area', 'feature'), { recursive: true })
  return root
}

/** A spec file for a temporary repository; its scenario body is given as source. */
function writeSpec(root: string, body: string, extra = ''): void {
  writeFileSync(
    join(root, 'e2e/tests/area/feature/thing.e2e.ts'),
    `const fs = require('fs')
const { BlockedError, HarnessError } = require(${JSON.stringify(join(CORE, 'result'))})
export default {
  id: 'area/feature/thing',
  title: 'A thing',
  kind: 'e2e',
  covers: ['src/**'],
  stack: 'none',
  fixtures: [],
  exclusive: false,
  surfaces: { 'web-chromium': { devices: [] }, 'ios-app': { devices: [{ role: 'phone', needs: ['ios-phone'], hardware: 'none' }] } },
  services: [],
  apps: [],
  secrets: [],
  costUsd: 0,
  minutes: 1,
  guards: [],
  faults: [],
  manual: false,
  ${extra}
  scenarios: { main: async ctx => { ${body} } }
}
`
  )
}

const SPEC: E2eSpec = {
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
  scenarios: { main: async () => {} }
}

describe('the test contract', function () {
  it('accepts a good spec and names everything wrong with a bad one', function () {
    expect(defineE2e(SPEC)).equals(SPEC)
    expect(specProblems(SPEC)).deep.equals([])
    const problems = specProblems({
      ...SPEC,
      id: 'flat',
      title: ' ',
      covers: [],
      minutes: 0,
      // eslint-disable-next-line @typescript-eslint/consistent-type-assertions
      surfaces: { 'smoke-signals': { devices: [] } } as E2eSpec['surfaces'],
      scenarios: { 'Bad Name': async () => {} }
    })
    expect(problems.join('\n')).includes('category/feature/behaviour')
    expect(problems.join('\n')).includes('title is empty')
    expect(problems.join('\n')).includes('covers is empty')
    expect(problems.join('\n')).includes('unknown surface')
    expect(problems.join('\n')).includes('bad scenario name')
    expect(problems.join('\n')).includes('minutes')
    expect(
      specProblems({ ...SPEC, surfaces: {}, scenarios: {} }).join('\n')
    ).includes('no surfaces')
  })
})

describe('the manifest', function () {
  it('reads every real spec with no side effects, deterministically', function () {
    const before = { ...process.env }
    const first = renderManifest(buildManifest())
    expect(renderManifest(buildManifest())).equals(first)
    expect(process.env).deep.equals(before)
    expect(testFiles().length).greaterThan(1)
    expect(buildManifest().scenarios.map(row => row.id)).includes(
      'schedule/rsvp/eligibility#roster-removal'
    )
  })

  it('is what is committed, and the framework is tracked and linted', async function () {
    const report = validate()
    expect(report.problems).deep.equals([])
    expect(readManifest().scenarios.length).greaterThan(1)
    expect(trackedFiles()).includes('e2e/core/spec.ts')
    expect(await new ESLint().isPathIgnored(join(CORE, 'spec.ts'))).equals(
      false
    )
  })

  it('finds a scenario, and refuses an unknown one or a file with no default', function () {
    const root = tempRoot()
    writeSpec(root, 'return')
    expect(findScenario('area/feature/thing#main', root).entry.spec).equals(
      'area/feature/thing'
    )
    expect(() => findScenario('area/feature/thing#gone', root)).throws(
      HarnessError
    )
    writeFileSync(
      join(root, 'e2e/tests/area/feature/none.e2e.ts'),
      'export {}\n'
    )
    expect(() => buildManifest(root)).throws(HarnessError)
  })
})

describe('validate', function () {
  function repository(): string {
    const root = tempRoot()
    execFileSync('git', ['init', '-q'], { cwd: root })
    mkdirSync(join(root, 'src'))
    writeFileSync(join(root, 'src/app.ts'), '')
    return root
  }

  it('fails on a stale manifest, then passes once it is current', function () {
    const root = repository()
    writeSpec(root, 'expect(1)')
    expect(validate(root).problems.join('\n')).includes('stale')
    writeFileSync(
      join(root, 'e2e/manifest.json'),
      renderManifest(buildManifest(root))
    )
    expect(validate(root).problems).deep.equals([])
  })

  it('fails on a covers glob matching nothing and on a bad spec', function () {
    const root = repository()
    writeFileSync(
      join(root, 'e2e/tests/area/feature/thing.e2e.ts'),
      `export default ${JSON.stringify({ ...SPEC, covers: ['nope/**'], title: '' })}`.replace(
        '"scenarios":{}',
        '"scenarios":{"main":async()=>{expect(1)}}'
      )
    )
    const problems = validate(root).problems.join('\n')
    expect(problems).includes('covers "nope/**" matches no file')
    expect(problems).includes('title is empty')
  })

  it('reports legacy, additions and gone files, and strict mode rejects them', function () {
    const root = repository()
    writeSpec(root, 'expect(1)')
    writeFileSync(
      join(root, 'e2e/manifest.json'),
      renderManifest(buildManifest(root))
    )
    writeFileSync(join(root, 'src/old.e2e.ts'), '')
    writeFileSync(join(root, 'src/new.e2e.ts'), '')
    writeFileSync(join(root, 'src/parked.e2e.ts'), '')
    writeFileSync(
      join(root, 'e2e/legacy.json'),
      JSON.stringify({
        tests: ['src/old.e2e.ts', 'src/moved.e2e.ts'],
        helpers: [],
        parked: ['src/parked.e2e.ts']
      })
    )
    const report = validate(root)
    expect(report.problems).deep.equals([])
    expect(report.legacy).includes('src/old.e2e.ts')
    expect(report.additions).deep.equals(['src/new.e2e.ts'])
    expect(report.gone).deep.equals(['src/moved.e2e.ts'])
    const strict = validate(root, { strict: true }).problems.join('\n')
    expect(strict).includes('src/old.e2e.ts: tests belong under e2e/')
    expect(strict).includes('src/new.e2e.ts: tests belong under e2e/')
    expect(strict).not.includes('parked')
  })

  it('has no legacy list in a repository without one, and a helper move leaves the count', function () {
    expect(readLegacy(tempRoot())).deep.equals({
      tests: [],
      helpers: [],
      parked: []
    })
    const list = { tests: ['a.e2e.ts'], helpers: ['b.e2e.ts'], parked: [] }
    expect(legacyReport(list, ['a.e2e.ts', 'b.e2e.ts']).legacy.length).equals(1)
    expect(
      legacyReport(list, ['a.e2e.ts', 'e2e/rigs/b.ts']).legacy.length
    ).equals(1)
  })
})

describe('the lint', function () {
  const rules = (file: string, text: string): string[] =>
    lintFile(file, text).map(problem => problem.rule)
  const test = 'e2e/tests/a/b/thing.e2e.ts'

  it('passes clean code', function () {
    expect(rules(test, 'await ctx.checkpoint("x", {})')).deep.equals([])
  })

  it('fails each rule on code that breaks it', function () {
    expect(rules(test, 'expect(1); m.tapOn({ optional: true })')).includes(
      'no-optional'
    )
    expect(rules(test, 'expect(1); try { a() } catch {}')).includes(
      'no-empty-catch'
    )
    expect(rules(test, 'expect(1); "00008132-001234567890ABCD"')).includes(
      'no-device-id'
    )
    expect(
      rules(test, 'expect(1); "E8380536-54E2-4042-8FFF-0BC7EF6D3EC5"')
    ).includes('no-device-id')
    expect(
      rules(test, 'expect(1); "00000000-0000-4000-8000-000000000001"')
    ).not.includes('no-device-id')
    expect(rules('e2e/tests/a/b/ui-tweaks.e2e.ts', 'expect(1)')).includes(
      'no-project-name'
    )
    expect(rules('e2e/tests/a/b/thing2.e2e.ts', 'expect(1)')).includes(
      'no-project-name'
    )
    expect(rules(test, 'expect(1); m.assertScreenshot({})')).includes(
      'no-direct-screenshot'
    )
    expect(rules('e2e/core/visual.ts', 'm.assertScreenshot({})')).deep.equals(
      []
    )
    expect(rules(test, 'expect(1); m.assertWithAI("x")')).includes(
      'no-maestro-ai'
    )
    expect(rules(test, "expect(1); import p from 'puppeteer'")).includes(
      'no-puppeteer'
    )
    expect(
      rules('e2e/core/browserCdp.ts', "import p from 'puppeteer'")
    ).deep.equals([])
    expect(rules(test, 'const a = 1')).includes('needs-assertion')
  })
})

describe('select', function () {
  it('matches by glob, excludes the rest, and copes with a deleted file', function () {
    const manifest = {
      scenarios: [
        {
          ...SPEC,
          id: 'a#x',
          spec: 'a',
          file: 'a',
          covers: ['src/app/**', 'src/one.ts']
        },
        {
          ...SPEC,
          id: 'b#x',
          spec: 'b',
          file: 'b',
          covers: ['src/server/*.ts']
        }
      ]
    }
    const ids = (changed: string[]): string[] =>
      selectScenarios(manifest as never, changed).map(row => row.id)
    expect(ids(['src/app/deep/er.tsx'])).deep.equals(['a#x'])
    expect(ids(['src/one.ts'])).deep.equals(['a#x'])
    expect(ids(['src/server/x.ts'])).deep.equals(['b#x'])
    expect(ids(['src/server/deep/x.ts'])).deep.equals([])
    expect(ids(['README.md'])).deep.equals([])
    expect(ids(['src/app/deleted-from-disk.ts'])).deep.equals(['a#x'])
    expect(globToRegExp('**/x.ts').test('x.ts')).equals(true)
    expect(matchesAny('a.b', ['a?b'])).equals(false)
  })
})

const manifestOf = (entry: object): never =>
  // eslint-disable-next-line @typescript-eslint/consistent-type-assertions
  ({ scenarios: [entry] }) as never

describe('plan', function () {
  const entry = {
    ...SPEC,
    id: 'a/b/c#x',
    spec: 'a/b/c',
    file: 'f',
    surfaces: {
      'ios-app': {
        devices: [{ role: 'phone', needs: ['ios-phone'], hardware: 'required' }]
      }
    }
  }

  function row(
    overrides: object,
    resources = {},
    seat?: string
  ): { blockedBy: string[]; runnable: boolean } {
    return planScenarios(manifestOf({ ...entry, ...overrides }), {
      resources,
      seat,
      settings: {}
    })[0]
  }

  it('marks each reason, and orders nothing', function () {
    const free = { p: { available: true, capabilities: ['ios-phone'] } }
    expect(row({}, free).runnable).equals(true)
    expect(row({}, {}).blockedBy.join()).includes('no device can be phone')
    expect(
      row(
        {},
        {
          p: {
            available: false,
            capabilities: ['ios-phone'],
            borrower: 'x',
            expiry: 'soon'
          }
        }
      ).blockedBy.join()
    ).includes('held by x until soon')
    expect(row({ manual: true }, free).blockedBy.join()).includes('manual')
    expect(row({ secrets: ['k'] }, free).blockedBy.join()).includes('no secret')
    expect(row({ guards: ['g'] }, free).blockedBy.join()).includes('guard')
    expect(
      row({ stack: 'seat', services: ['smtp'] }, free).blockedBy.join()
    ).includes('smtp needs a seat')
    expect(
      row({ stack: 'seat', services: ['smtp'] }, free, 'tester').runnable
    ).equals(true)
    const none = row({
      surfaces: {
        'ios-app': { devices: [{ role: 'p', needs: ['x'], hardware: 'none' }] }
      }
    })
    expect(none.runnable).equals(true)
  })
})

describe('run', function () {
  async function outcome(
    body: string,
    options: object = {},
    extra = ''
  ): Promise<{
    status: Status
    exit: number
    reason?: string
    root: string
    degradations: string[]
  }> {
    const root = tempRoot()
    writeSpec(root, body, extra)
    const runDir = join(root, 'run')
    const { result, exitCode } = await runScenario({
      id: 'area/feature/thing#main',
      surface: 'web-chromium',
      settings: {},
      root,
      runDir,
      ...options
    })
    expect(existsSync(join(runDir, 'result.json'))).equals(true)
    return {
      status: result.status,
      exit: exitCode,
      reason: result.reason,
      root,
      degradations: result.degradations
    }
  }

  it('maps each outcome to its exit code, and always writes the result', async function () {
    expect((await outcome('return')).status).equals('passed')
    expect((await outcome('return')).exit).equals(0)
    const degraded = await outcome('ctx.degrade("stand-in")')
    expect(degraded.status).equals('passed-degraded')
    expect(degraded.exit).equals(0)
    expect(degraded.degradations).deep.equals(['stand-in'])
    const failed = await outcome('throw new Error("broke")')
    expect(failed.status).equals('failed')
    expect(failed.exit).equals(1)
    expect(failed.reason).equals('broke')
    const blocked = await outcome('throw new BlockedError("no phone")')
    expect(blocked.exit).equals(2)
    expect((await outcome('throw new HarnessError("bad")')).exit).equals(3)
    expect(exitCodeFor('needs-review')).equals(4)
    expect(exitCodeFor('unbaselined')).equals(4)
  })

  it('keeps a quarantined failure red, and still runs it', async function () {
    const quarantined = await outcome(
      'fs.writeFileSync(ctx.artifact("ran"), ""); throw new Error("known")',
      {},
      'quarantine: { reason: "known bug", since: "2026-10-30" },'
    )
    expect(quarantined.status).equals('quarantined')
    expect(quarantined.exit).equals(1)
    expect(existsSync(join(quarantined.root, 'run', 'ran'))).equals(true)
  })

  it('quarantines only the scenarios it names', async function () {
    const other = await outcome(
      'throw new Error("real")',
      {},
      'quarantine: { reason: "x", since: "y", scenarios: ["elsewhere"] },'
    )
    expect(other.status).equals('failed')
    const named = await outcome(
      'throw new Error("known")',
      {},
      'quarantine: { reason: "x", since: "y", scenarios: ["main"] },'
    )
    expect(named.status).equals('quarantined')
  })

  it('blocks for a surface it lacks, a missing device, a secret, or manual', async function () {
    const surface = await outcome('return', { surface: 'android-app' })
    expect(surface.status).equals('blocked')
    const device = await outcome('return', { surface: 'ios-app' })
    expect(device.exit).equals(2)
    expect(device.reason).includes('--device phone=<id>')
    expect((await outcome('return', {}, 'manual: true,')).reason).includes(
      'manual'
    )
  })

  it('gives a scenario its device, artifacts and retries', async function () {
    const passed = await outcome(
      `if (ctx.device('phone') !== 'sim') throw new Error('device')
       if (!fs.existsSync(ctx.artifact('tried'))) { fs.writeFileSync(ctx.artifact('tried'), ''); throw new Error('first') }`,
      { surface: 'ios-app', devices: { phone: 'sim' }, retries: 1 }
    )
    expect(passed.status).equals('passed')
    const missing = await outcome(`ctx.device('nobody')`)
    expect(missing.status).equals('blocked')
  })

  it('reports an unknown scenario as a harness error', async function () {
    expect(
      (await outcome('return', { id: 'area/feature/thing#gone' })).exit
    ).equals(3)
  })

  it('routes a seat scenario to the named seat, and to a local stack without one', async function () {
    const write = `fs.writeFileSync(ctx.artifact('stack'), ctx.stack.kind + ' ' + ctx.stack.origin)`
    const onSeat = await outcome(
      write,
      {
        seat: 'tester',
        settings: { seats: { tester: { origin: 'https://seat.example.test' } } }
      },
      "stack: 'seat',"
    )
    expect(readFileSync(join(onSeat.root, 'run', 'stack'), 'utf8')).equals(
      'seat https://seat.example.test'
    )
    const local = await outcome(write, {}, "stack: 'seat',")
    expect(readFileSync(join(local.root, 'run', 'stack'), 'utf8')).includes(
      'isolated http://127.0.0.1'
    )
    const none = await outcome(write)
    expect(readFileSync(join(none.root, 'run', 'stack'), 'utf8').trim()).equals(
      'none'
    )
    expect(
      (await outcome('return', { seat: 'absent' }, "stack: 'seat',")).reason
    ).includes('no seat "absent"')
    expect(
      (await outcome('return', {}, "stack: 'seat', services: ['smtp'],")).reason
    ).includes('smtp needs a seat')
  })
})

describe('settings', function () {
  it('reads the file named by the environment, or nothing', function () {
    const root = tempRoot()
    const file = join(root, 'local.json')
    expect(settingsPath({ E2E_LOCAL_SETTINGS: file })).equals(file)
    expect(settingsPath({})).includes('teamstation-e2e')
    expect(loadSettings(file)).deep.equals({})
    writeFileSync(file, JSON.stringify({ mailbox: 'x@example.test' }))
    expect(loadSettings(file).mailbox).equals('x@example.test')
  })

  it('reads a secret by name and blocks when it is absent', function () {
    const root = tempRoot()
    const secretsFile = join(root, 'secrets.json')
    writeFileSync(secretsFile, JSON.stringify({ anthropic: 'k' }))
    expect(readSecret({ secretsFile }, 'anthropic')).equals('k')
    expect(hasSecret({ secretsFile }, 'anthropic')).equals(true)
    expect(hasSecret({ secretsFile }, 'other')).equals(false)
    expect(() => readSecret({}, 'anthropic')).throws(BlockedError)
  })
})

describe('prepare', function () {
  function runs(
    options: Parameters<typeof prepareApp>[0]
  ): Array<{ command: string; args: string[]; env?: NodeJS.ProcessEnv }> {
    const out: Array<{
      command: string
      args: string[]
      env?: NodeJS.ProcessEnv
    }> = []
    prepareApp(options, (command, args, env) =>
      out.push({ command, args, env })
    )
    return out
  }

  it('installs a package from disk on either platform', function () {
    expect(
      runs({ app: 'teamstation-ios', device: 'd', packagePath: 'a.ipa' })[0]
        .command
    ).equals('xcrun')
    expect(
      runs({ app: 'teamstation-android', device: 'd', packagePath: 'a.apk' })[0]
        .args
    ).includes('install')
  })

  it('builds a simulator app with the origin in TS_API_BASE_URL', function () {
    const origin = 'http://192.0.2.1:9000'
    const ios = runs({ app: 'teamstation-ios', device: 'd', origin })[0]
    expect(ios.env?.TS_API_BASE_URL).equals(`${origin}/api/v1`)
    expect(
      runs({ app: 'teamstation-android', device: 'd', origin })[0].args
    ).includes('run-android')
  })

  it('refuses a loopback origin, no target and an unknown app', function () {
    expect(() => apiBaseFor('http://127.0.0.1:9000')).throws(HarnessError)
    expect(() => apiBaseFor('http://localhost:9000')).throws(HarnessError)
    expect(() => runs({ app: 'teamstation-ios', device: 'd' })).throws(
      HarnessError
    )
    expect(() =>
      runs({ app: 'other', device: 'd', origin: 'http://192.0.2.1' })
    ).throws(HarnessError)
    expect(() => runs({ app: 'other', device: 'd', packagePath: 'x' })).throws(
      HarnessError
    )
  })

  it('reports a failed install as blocked', function () {
    expect(() => {
      prepareApp(
        { app: 'teamstation-ios', device: 'd', packagePath: 'x' },
        () => {
          throw new Error('no device')
        }
      )
    }).throws(BlockedError)
  })
})

describe('browser emulation', function () {
  it('applies each emulation through CDP', async function () {
    const calls: string[] = []
    const page = {
      evaluateOnNewDocument: async (script: string) =>
        calls.push(`clock ${script.includes('1600000000000')}`),
      emulateTimezone: async (zone: string) => calls.push(zone),
      emulateMediaFeatures: async (features: Array<{ name: string }>) =>
        calls.push(features[0].name),
      setViewport: async (viewport: Record<string, unknown>) =>
        calls.push(`touch ${String(viewport.hasTouch)}`)
    }
    await applyEmulation(page, {
      clock: new Date(1600000000000).toISOString(),
      timeZone: 'America/Los_Angeles',
      reducedMotion: true,
      touch: { width: 400, height: 800 }
    })
    expect(calls).deep.equals([
      'clock true',
      'America/Los_Angeles',
      'prefers-reduced-motion',
      'touch true'
    ])
    calls.length = 0
    await applyEmulation(page, {})
    expect(calls).deep.equals([])
    expect(clockScript('2026-01-01T00:00:00Z')).includes('Pinned')
  })
})

describe('maestro loading', function () {
  it('blocks with the build command when the client is not built', function () {
    expect(() => maestroClient({ maestroClientRoot: tempRoot() })).throws(
      BlockedError,
      'npm run build'
    )
    expect(maestroBin({ maestroBin: '/x' })).equals('/x')
    expect(maestroBin({})).includes('maestro-d')
  })

  it('attaches with flowDir at the run directory', async function () {
    let seen: Record<string, unknown> = {}
    const root = tempRoot()
    await attachDevice(
      {
        attach: async (o: Record<string, unknown>) => {
          seen = o
          // eslint-disable-next-line @typescript-eslint/consistent-type-assertions
          return {} as never
        },
        shutdown: async () => {}
      },
      join(root, 'run'),
      { device: 'd' }
    )
    expect(seen.flowDir).equals(join(root, 'run'))
    expect(seen.device).equals('d')
  })
})

function interfaceRow(internal: boolean, address: string): never {
  // eslint-disable-next-line @typescript-eslint/consistent-type-assertions
  return { family: 'IPv4', internal, address } as never
}

describe('maestro connection', function () {
  function fakeClient(): {
    maestroClientRoot: string
    maestroBin: string
    maestroHome: string
  } {
    const root = tempRoot()
    mkdirSync(join(root, 'dist', 'cjs'), { recursive: true })
    writeFileSync(join(root, 'dist', 'cjs', 'index.js'), '')
    writeFileSync(join(root, 'package.json'), '{}')
    mkdirSync(join(root, 'node_modules', 'maestro-d'), { recursive: true })
    writeFileSync(
      join(root, 'node_modules', 'maestro-d', 'index.js'),
      'exports.MaestroD = { connect: async o => ({ name: o.name, shutdown: async () => {}, attach: async () => ({}) }) }'
    )
    const bin = join(root, 'maestro-d')
    writeFileSync(bin, '#!/bin/sh\necho NAME\n')
    chmodSync(bin, 0o755)
    return { maestroClientRoot: root, maestroBin: bin, maestroHome: root }
  }

  it('lists daemons, sets its home, and connects by name', async function () {
    const log = console.log
    let printed = ''
    console.log = (text: string) => {
      printed += text
    }
    try {
      const settings = fakeClient()
      const daemon = await connectDaemon(settings, 'e2e-test')
      expect(daemon).to.have.property('name', 'e2e-test')
      expect(process.env.MAESTRO_RUNNER_HOME).equals(settings.maestroHome)
      expect(printed).includes('NAME')
    } finally {
      console.log = log
      delete process.env.MAESTRO_RUNNER_HOME
    }
  })

  it('blocks when the binary is missing', async function () {
    let failure: unknown
    try {
      await connectDaemon({ maestroBin: join(tempRoot(), 'absent') }, 'x')
    } catch (error) {
      failure = error
    }
    expect(failure).instanceOf(BlockedError)
  })
})

describe('the isolated stack', function () {
  it('finds a LAN address, or says there is none', function () {
    expect(
      lanAddress({
        lo0: [interfaceRow(true, '127.0.0.1')],
        en0: [interfaceRow(false, '192.0.2.5')]
      })
    ).equals('192.0.2.5')
    expect(() => lanAddress({})).throws(HarnessError)
  })

  it('sends the paths Caddy forwards to the API and everything else to the page', function () {
    for (const path of [
      '/api/v1/x',
      '/socket',
      '/media/a',
      '/oauth/authorize',
      '/.well-known/openid-configuration',
      '/signin/abc'
    ]) {
      expect(goesToApi(path), path).equals(true)
    }
    expect(goesToApi('/games/g1')).equals(false)
  })

  it('joins a build and an API on one origin, socket upgrades included', async function () {
    const root = tempRoot()
    writeFileSync(join(root, 'index.html'), 'THE PAGE')
    writeFileSync(join(root, 'app.js'), 'THE BUNDLE')
    const api = createServer((req, res) => {
      res.writeHead(200, { 'content-type': 'text/plain' })
      res.end(`api ${req.url} from ${String(req.headers['x-forwarded-for'])}`)
    })
    api.on('upgrade', (req, socket) => {
      socket.write(
        'HTTP/1.1 101 Switching Protocols\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n\r\nhello'
      )
    })
    const apiPort = await freePort()
    await new Promise<void>(resolve =>
      api.listen(apiPort, '127.0.0.1', resolve)
    )
    const front = await startFront({
      webDir: root,
      apiPort,
      host: '127.0.0.1',
      port: 0
    })
    try {
      expect(await (await fetch(`${front.url}/api/v1/health`)).text()).includes(
        'api /api/v1/health from'
      )
      expect(await (await fetch(`${front.url}/games/1`)).text()).equals(
        'THE PAGE'
      )
      expect(await (await fetch(`${front.url}/app.js`)).text()).equals(
        'THE BUNDLE'
      )
      const { port } = new URL(front.url)
      const upgraded = await new Promise<string>((resolve, reject) => {
        const socket = connect(Number(port), '127.0.0.1', () => {
          socket.write(
            'GET /socket HTTP/1.1\r\nHost: x\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n\r\n'
          )
        })
        let text = ''
        socket.on('data', chunk => {
          text += String(chunk)
          if (text.includes('hello')) {
            socket.destroy()
            resolve(text)
          }
        })
        socket.on('error', reject)
      })
      expect(upgraded).includes('101')
      const refused = await new Promise<boolean>(resolve => {
        const socket = connect(Number(port), '127.0.0.1', () => {
          socket.write(
            'GET /games HTTP/1.1\r\nHost: x\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n\r\n'
          )
        })
        socket.on('close', () => {
          resolve(true)
        })
      })
      expect(refused).equals(true)
    } finally {
      front.server.close()
      front.server.closeAllConnections()
      api.close()
      api.closeAllConnections()
    }
    const gone = await startFront({
      webDir: join(root, 'absent'),
      apiPort: await freePort(),
      host: '127.0.0.1',
      port: 0
    })
    try {
      expect((await fetch(`${gone.url}/x`)).status).equals(404)
      expect((await fetch(`${gone.url}/api/x`)).status).equals(502)
    } finally {
      gone.server.close()
      gone.server.closeAllConnections()
    }
  })

  it('serves the same Places answers as the fixture file', async function () {
    const answers = JSON.parse(readFileSync(PLACES_ANSWERS, 'utf8')) as Record<
      string,
      unknown
    >
    expect(placesAnswer(answers, 'POST', '/v1/places:autocomplete')).equals(
      answers.autocomplete
    )
    expect(placesAnswer(answers, 'POST', '/v1/places:searchText')).equals(
      answers.searchText
    )
    expect(
      placesAnswer(answers, 'GET', '/v1/places/abc?languageCode=en')
    ).equals(answers.placeDetails)
    expect(placesAnswer(answers, 'GET', '/maps/api/timezone/json?x=1')).equals(
      answers.timezone
    )
    expect(placesAnswer(answers, 'GET', '/other')).equals(undefined)
    const stub = await startPlacesStub('127.0.0.1')
    try {
      const reply = await fetch(`${stub.url}/v1/places:searchText`, {
        method: 'POST'
      })
      expect(await reply.json()).deep.equals(answers.searchText)
      expect((await fetch(`${stub.url}/other`)).status).equals(404)
    } finally {
      stub.server.close()
      stub.server.closeAllConnections()
    }
  })

  it('starts a real API behind the front, with its store and catalog', async function () {
    this.timeout(180000)
    const stack = await startStack({ services: ['web', 'api'] })
    try {
      const health = await fetch(`${stack.origin}/api/v1/health`)
      expect(health.status).equals(200)
      expect(existsSync(join(stack.webDir ?? '', 'index.html'))).equals(true)
      const page = await fetch(`${stack.origin}/games/1`)
      expect(await page.text()).includes('<html')
      expect(stack.adopt('http://x.example.test')).equals(
        'http://x.example.test'
      )
      expect(stack.origin).equals('http://x.example.test')
    } finally {
      await stack.stop()
    }
    expect(existsSync(stack.dir)).equals(false)
  })

  it('reports a server that will not build', async function () {
    let failed = false
    try {
      await startStack({ services: ['web'], root: tempRoot() })
    } catch (error) {
      failed = error instanceof HarnessError
    }
    expect(failed).equals(true)
    expect(request).to.be.a('function')
  })
})

describe('the command line', function () {
  async function quietly(
    argv: string[]
  ): Promise<{ code: number; out: string }> {
    const log = console.log
    let out = ''
    console.log = (text: string) => {
      out += `${text}\n`
    }
    try {
      return { code: await main(argv), out }
    } finally {
      console.log = log
    }
  }

  it('lists, validates, selects and plans', async function () {
    const list = await quietly(['list', '--json', '--category', 'schedule'])
    expect(list.out).includes('roster-removal')
    expect(list.out).not.includes('list-screens')
    expect((await quietly(['list'])).out).includes(
      'schedule/rsvp/eligibility#roster-removal'
    )
    expect((await quietly(['list', '--surface', 'ios-app'])).out).not.includes(
      'roster-removal'
    )
    expect((await quietly(['validate'])).code).equals(0)
    expect(
      (await quietly(['select', '--changed', 'src/common/eventInfo.ts'])).out
    ).includes('roster-removal')
    expect((await quietly(['select', '--base', 'HEAD'])).code).equals(0)
    const plan = await quietly(['plan'])
    expect(plan.out).includes('runnable')
    const root = tempRoot()
    const resources = join(root, 'r.json')
    writeFileSync(resources, JSON.stringify({ resources: {} }))
    const ledger = join(root, 'l.json')
    writeFileSync(ledger, JSON.stringify({}))
    expect(
      (
        await quietly([
          'plan',
          '--resources',
          resources,
          '--ledger',
          ledger,
          '--seat',
          'tester'
        ])
      ).code
    ).equals(0)
  })

  it('runs a scenario and returns its exit code', async function () {
    const blocked = await quietly([
      'run',
      'schedule/rsvp/eligibility#roster-removal',
      '--surface',
      'web-safari-ios',
      '--run-dir',
      join(tempRoot(), 'run')
    ])
    expect(blocked.code).equals(2)
    expect(blocked.out).includes('--device browser=<id>')
  })

  it('starts a stack, runs against it, and stops it', async function () {
    this.timeout(60000)
    const up = await quietly([
      'stack',
      'up',
      '--id',
      'clitest',
      '--services',
      'none'
    ])
    const state = JSON.parse(up.out) as {
      id: string
      origin: string
      pid: number
    }
    expect(state.id).equals('clitest')
    expect(state.origin).includes('http://127.0.0.1')
    const blocked = await quietly([
      'run',
      'schedule/rsvp/eligibility#roster-removal',
      '--surface',
      'web-safari-ios',
      '--stack',
      'clitest',
      '--run-dir',
      join(tempRoot(), 'run')
    ])
    expect(blocked.code).equals(2)
    const prepared = await quietly([
      'prepare',
      '--app',
      'teamstation-ios',
      '--device',
      'd',
      '--stack',
      'clitest',
      '--package',
      join(tempRoot(), 'absent.ipa')
    ]).then(
      () => 'installed',
      (error: unknown) => (error as Error).constructor.name
    )
    expect(prepared).equals('BlockedError')
    const down = await quietly(['stack', 'down', 'clitest'])
    expect(down.out).includes('"stopped": true')
  })

  it('refuses bad usage clearly', async function () {
    const refuses = async (argv: string[], text: string): Promise<void> => {
      let message = ''
      try {
        await quietly(argv)
      } catch (error) {
        message = (error as Error).message
      }
      expect(message, argv.join(' ')).includes(text)
    }
    await refuses(['nonsense'], 'Unknown command')
    await refuses(['run'], 'run wants')
    await refuses(['prepare'], 'prepare wants --app')
    await refuses(
      ['prepare', '--app', 'a', '--device', 'd'],
      'prepare wants --stack'
    )
    await refuses(['stack', 'sideways'], 'stack wants')
    await refuses(['stack', 'down', 'absent'], 'No stack')
    await refuses(['run', 'x', '--surface', 'y', '--device', 'bad'], 'role=id')
  })
})
