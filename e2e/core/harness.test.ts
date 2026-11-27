import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { expect } from 'chai'
import { after, before, describe, it } from 'mocha'

import { defineSplash, targetFor } from '../rigs/app/splash'
import { Checkpoints } from './checkpoint'
import { caughtByLayer, detectRow } from './detectRow'
import {
  type Handoff,
  handoffProblem,
  HARNESS_VERSION,
  hubId,
  type MaestroClient,
  mapService,
  normalizedNeeds,
  platformOf,
  runScenario,
  stackControl
} from './harness'
import { Budget } from './judge'
import { loadSpec, ROOT } from './manifest'
import type { RunResult } from './result'
import {
  defineE2e,
  defineHarness,
  type E2eSpec,
  type HarnessSpec
} from './spec'
import { needProblems } from './validate'

/** A device as the maestro-d client hands it back, recording every call. */
function fakeDevice(
  name: string,
  calls: string[],
  overrides: Record<string, unknown> = {}
): any {
  return {
    name,
    hierarchy: async () => ({ text: `screen of ${name}` }),
    screenshot: async () => new Uint8Array([1, 2, 3]),
    state: async () => ({}),
    platformInfo: async () => ({
      platform: 'ios',
      isSimulator: true,
      osVersion: '18.2',
      screenWidth: 393,
      screenHeight: 852
    }),
    detach: async () => {
      calls.push(`detach ${name}`)
    },
    setStatusBar: async (mode: string) => {
      calls.push(`setStatusBar ${name} ${mode}`)
    },
    stopApp: async (appId: string) => {
      calls.push(`stopApp ${name} ${appId}`)
    },
    assertVisible: async (selector: unknown) => {
      calls.push(`assertVisible ${name} ${JSON.stringify(selector)}`)
    },
    ...overrides
  }
}

/** The runner's client, recording what was asked of it. */
function fakeClient(
  calls: string[],
  deviceOverrides: Record<string, unknown> = {}
): MaestroClient & Record<string, unknown> {
  const refuse = (what: string) => async (): Promise<never> => {
    calls.push(what)
    throw new Error(`${what} is the runner's, never the harness's`)
  }
  return {
    attach: async options => {
      calls.push(`attach ${String(options.device)} ${String(options.appId)}`)
      return fakeDevice(String(options.device), calls, deviceOverrides)
    },
    lease: refuse('lease'),
    claim: refuse('claim'),
    installApp: refuse('installApp'),
    createDevice: refuse('createDevice'),
    deleteDevice: refuse('deleteDevice'),
    devices: refuse('devices')
  }
}

function specWith(
  scenario: (ctx: any) => Promise<void>,
  overrides: Partial<E2eSpec> = {}
): E2eSpec {
  return defineE2e({
    id: 'platform/harness/fake',
    title: 'A fake spec for the harness',
    kind: 'e2e',
    covers: ['e2e/core/harness.ts'],
    stack: 'isolated',
    fixtures: [],
    exclusive: false,
    surfaces: {
      'ios-app': {
        devices: [
          { role: 'coach', needs: ['ios-phone'], hardware: 'required' },
          { role: 'player', needs: ['ios-phone'], hardware: 'none' }
        ]
      }
    },
    services: ['api'],
    apps: ['teamstation-ios'],
    secrets: [],
    costUsd: 0,
    minutes: 1,
    guards: [],
    faults: [],
    manual: false,
    scenarios: { go: scenario },
    ...overrides
  })
}

describe('the harness entry', function () {
  let scratch: string
  let n = 0
  const handoff = (overrides: Partial<Handoff> = {}): Handoff => ({
    version: HARNESS_VERSION,
    hub: 'hub-a:7001',
    surface: 'ios-app',
    devices: {
      coach: { id: 'PHONE-A', deviceClass: 'ios-phone', real: true },
      player: { id: 'PHONE-B@hub-b', deviceClass: 'ios-phone', real: false }
    },
    apps: { 'teamstation-ios': 'app.example.ios' },
    stack: {
      kind: 'isolated',
      origin: 'https://stack.example.test',
      services: []
    },
    secrets: {},
    aiBudgetUsd: 1,
    runDir: join(scratch, `run-${n++}`),
    ...overrides
  })
  const deps = { ref: 'abc1234' }

  before(function () {
    scratch = mkdtempSync(join(tmpdir(), 'harness-test-'))
  })
  after(function () {
    rmSync(scratch, { recursive: true, force: true })
  })

  it('is a harness error for a handoff of another version, and writes result.json', async function () {
    const calls: string[] = []
    const given = handoff({ version: 2 })
    const result = await runScenario(
      specWith(async () => undefined),
      'go',
      given,
      { maestro: fakeClient(calls) },
      deps
    )
    expect(result.status).equals('harness-error')
    expect(result.reason).contains('version 2')
    expect(calls).deep.equals([])
    const written = JSON.parse(
      readFileSync(join(given.runDir, 'result.json'), 'utf8')
    ) as RunResult
    expect(written.status).equals('harness-error')
  })

  it('blocks on a missing role, app, service or secret, naming it', async function () {
    const cases: Array<[Partial<E2eSpec>, Partial<Handoff>, string]> = [
      [{}, { devices: {} }, 'no device for role "coach"'],
      [{}, { apps: {} }, 'no app id for teamstation-ios'],
      [
        { services: ['tess-model'] },
        {},
        'the stack does not supply real-model'
      ],
      [{ secrets: ['jev'] }, {}, 'secret jev not supplied'],
      [{}, { stack: { kind: 'none', origin: '', services: [] } }, 'pool stack']
    ]
    for (const [spec, given, reason] of cases) {
      const calls: string[] = []
      const result = await runScenario(
        specWith(async () => undefined, spec),
        'go',
        handoff(given),
        { maestro: fakeClient(calls) },
        deps
      )
      expect(result.status).equals('blocked')
      expect(result.reason).contains(reason)
      expect(calls).deep.equals([])
    }
  })

  it('names a missing browser, a manual spec, a surface it does not run on and a scenario it lacks', function () {
    const web = normalizedNeeds(
      specWith(async () => undefined, {
        surfaces: { 'web-chromium': { devices: [] } },
        apps: []
      })
    )
    expect(
      handoffProblem(web, handoff({ surface: 'web-chromium', devices: {} }))
    ).contains('no browser')
    expect(handoffProblem(web, handoff({ surface: 'android-app' }))).contains(
      'does not run on android-app'
    )
    const manual = normalizedNeeds(
      specWith(async () => undefined, { manual: true })
    )
    expect(handoffProblem(manual, handoff())).contains('manual')
  })

  it('attaches the devices by id in role order and detaches them when the scenario throws', async function () {
    const calls: string[] = []
    const result = await runScenario(
      specWith(async ctx => {
        expect(ctx.device('coach')).equals('PHONE-A@hub-a:7001')
        expect(ctx.device('player')).equals('PHONE-B@hub-b')
        expect(ctx.attached('player').name).equals('PHONE-B@hub-b')
        expect(ctx.app('teamstation-ios')).equals('app.example.ios')
        const again = await ctx.attach('coach', { appId: 'app.example.ios' })
        expect(again).equals(ctx.attached('coach'))
        throw new Error('the app broke')
      }),
      'go',
      handoff(),
      { maestro: fakeClient(calls) },
      deps
    )
    expect(result.status).equals('failed')
    expect(result.failureKind).equals('crash')
    expect(calls.filter(call => !call.startsWith('setStatusBar'))).deep.equals([
      'attach PHONE-A@hub-a:7001 app.example.ios',
      'attach PHONE-B@hub-b app.example.ios',
      'detach PHONE-B@hub-b',
      'detach PHONE-A@hub-a:7001'
    ])
    // Only the simulator gets the demo status bar.
    expect(calls).contains('setStatusBar PHONE-B@hub-b demo')
    expect(calls).not.contains('setStatusBar PHONE-A@hub-a:7001 demo')
  })

  it('makes no lease, install or device-create call, and loads no maestro-d library itself', async function () {
    const calls: string[] = []
    const result = await runScenario(
      specWith(async ctx => {
        await ctx.checkpoint('home', { expect: [{ text: 'Home' }] })
      }),
      'go',
      handoff(),
      { maestro: fakeClient(calls) },
      deps
    )
    expect(result.status).equals('passed')
    for (const call of calls) {
      expect(call).to.match(/^(attach|detach|setStatusBar|assertVisible) /)
    }
    const source = readFileSync(join(__dirname, 'harness.ts'), 'utf8')
    for (const line of source.split('\n')) {
      if (line.includes("from './maestro'")) expect(line).match(/^import type /)
    }
    expect(source).not.match(/require\(['"]maestro-d['"]\)|from 'maestro-d'/)
    expect(source).not.match(/connectDaemon|maestroClient\(|hubDaemon/)
    expect(source).contains("import type { MaestroDevice } from './maestro'")
  })

  it('seeds a world through the stack control, and blocks with no seed route', async function () {
    const seen: Array<{ url: string; body: unknown; auth: string }> = []
    const fetchFn = (async (url: string, init: any) => {
      seen.push({
        url,
        body: JSON.parse(String(init.body)),
        auth: String(init.headers.authorization)
      })
      return new Response(
        JSON.stringify({
          world: 'coach-game',
          nonce: 'n',
          accounts: {},
          ids: { game: 'g' }
        }),
        { status: 200 }
      )
    }) as unknown as typeof fetch
    let manifest: any
    const calls: string[] = []
    const seeded = await runScenario(
      specWith(async ctx => {
        manifest = await ctx.fixture('coach-game')
      }),
      'go',
      handoff({
        stack: {
          kind: 'isolated',
          origin: 'https://stack.example.test',
          services: [],
          control: { url: 'https://stack.example.test/__e2e', token: 't' }
        }
      }),
      { maestro: fakeClient(calls) },
      { ...deps, fetchFn }
    )
    expect(seeded.status).equals('passed')
    expect(manifest.ids.game).equals('g')
    expect(seen).deep.equals([
      {
        url: 'https://stack.example.test/__e2e/seed',
        body: { world: 'coach-game', mailbox: 'e2e@example.test' },
        auth: 'Bearer t'
      }
    ])

    const blocked = await runScenario(
      specWith(async ctx => {
        await ctx.fixture('coach-game')
      }),
      'go',
      handoff(),
      { maestro: fakeClient([]) },
      deps
    )
    expect(blocked.status).equals('blocked')
    expect(blocked.reason).equals('this stack has no seed route')
  })

  it('gives a scenario only the secrets its spec declares', async function () {
    const result = await runScenario(
      specWith(
        async ctx => {
          expect(ctx.secret('jev')).equals('jev-value')
          expect(() => ctx.secret('anthropic')).to.throw(
            'not one the spec declares'
          )
        },
        { secrets: ['jev'] }
      ),
      'go',
      handoff({ secrets: { jev: 'jev-value' } }),
      { maestro: fakeClient([]) },
      deps
    )
    expect(result.status).equals('passed')
  })

  it('sets a proxy fault through the stack control and clears it after a throw', async function () {
    const faults: unknown[] = []
    const fetchFn = (async (url: string, init: any) => {
      if (url.endsWith('/fault'))
        faults.push(JSON.parse(String(init.body)).fault)
      if (url.includes('/errors')) {
        return new Response(JSON.stringify({ errors: [] }), { status: 200 })
      }
      return new Response('{}', { status: 200 })
    }) as unknown as typeof fetch
    const given = handoff({
      fault: 'api-500',
      stack: {
        kind: 'isolated',
        origin: 'https://stack.example.test',
        services: [],
        control: { url: 'https://stack.example.test/__e2e/', token: 't' }
      }
    })
    const result = await runScenario(
      specWith(async ctx => {
        expect(faults).deep.equals(['api-500'])
        expect(ctx.fault).equals('api-500')
        await ctx.checkpoint('home', { expect: [{ text: 'Home' }] })
      }),
      'go',
      given,
      {
        maestro: fakeClient([], {
          assertVisible: async () => {
            const error = new Error('Element not found: Home')
            error.name = 'MaestroError'
            throw error
          }
        })
      },
      { ...deps, fetchFn }
    )
    expect(faults).deep.equals(['api-500', null])
    expect(result.status).equals('failed')
    expect(result.detect).deep.include({
      kind: 'detect',
      scenario: 'platform/harness/fake#go',
      fault: 'api-500',
      caught: true,
      caughtBy: 'expect',
      expectedLayer: true
    })
    const written = JSON.parse(
      readFileSync(join(given.runDir, 'result.json'), 'utf8')
    ) as RunResult
    expect(written.detect?.caughtBy).equals('expect')
  })

  it('blocks a proxy fault on a stack with no control routes', async function () {
    const result = await runScenario(
      specWith(async () => undefined),
      'go',
      handoff({ fault: 'api-500' }),
      { maestro: fakeClient([]) },
      deps
    )
    expect(result.status).equals('blocked')
    expect(result.reason).contains('no control routes')
    expect(result.detect?.caught).equals(false)
  })

  it('applies app-crash as maestro-d stopApp on the attached device', async function () {
    const calls: string[] = []
    await runScenario(
      specWith(async ctx => {
        await ctx.checkpoint(
          'home',
          { expect: [{ text: 'Home' }] },
          ctx.attached('coach')
        )
      }),
      'go',
      handoff({ fault: 'app-crash' }),
      { maestro: fakeClient(calls) },
      deps
    )
    expect(calls).contains('stopApp PHONE-A@hub-a:7001 app.example.ios')
  })

  it('reads a dump world account, and throws for a role the world lacks', async function () {
    const root = join(scratch, 'root')
    mkdirSync(join(root, 'e2e', 'fixtures', 'dumps'), { recursive: true })
    writeFileSync(
      join(root, 'e2e', 'fixtures', 'dumps', 'tiny-dump.accounts.json'),
      JSON.stringify({
        world: 'tiny-dump',
        source: 'coach-game',
        migration: 'm',
        accounts: {
          coach: {
            role: 'coach',
            email: 'dumps+coach@example.test',
            password: 'pw',
            userId: 'u1',
            displayName: 'Aaron Boone',
            teams: [{ id: 't1', name: 'Hosts' }],
            games: [],
            people: []
          }
        }
      })
    )
    const result = await runScenario(
      specWith(
        async ctx => {
          expect(ctx.account('coach').teams[0].name).equals('Hosts')
          expect(() => ctx.account('umpire')).to.throw(
            'no account for role "umpire"'
          )
        },
        { fixtures: ['tiny-dump'] }
      ),
      'go',
      handoff(),
      { maestro: fakeClient([]) },
      { ...deps, root }
    )
    expect(result.status).equals('passed')
  })

  it('a golden mismatch under runScenario makes no model call', async function () {
    const root = join(scratch, 'goldens-root')
    mkdirSync(join(root, 'e2e'), { recursive: true })
    writeFileSync(
      join(root, 'e2e', 'goldens.json'),
      JSON.stringify({ directory: 'teamstation', parents: {} })
    )
    const goldensDir = join(scratch, 'fetched-goldens')
    const key = 'platform/harness/fake#go/home/ios-app@ios-simulator-393x852-18'
    mkdirSync(join(goldensDir, 'platform/harness/fake#go/home'), {
      recursive: true
    })
    writeFileSync(join(goldensDir, `${key}.png`), 'golden')
    const calls: string[] = []
    const mismatch = async (): Promise<never> => {
      calls.push('assertScreenshot')
      const error: any = new Error('screens differ')
      error.code = 'COMMAND_FAILED'
      error.result = { data: { matchPercentage: 90 } }
      throw error
    }
    const result = await runScenario(
      specWith(async ctx => {
        await ctx.checkpoint('home', { golden: {} })
      }),
      'go',
      handoff({ goldensDir }),
      {
        maestro: fakeClient(calls, {
          assertScreenshot: mismatch,
          assertWithAI: async () => {
            calls.push('assertWithAI')
            return {}
          }
        })
      },
      { ...deps, root }
    )
    expect(result.status).equals('failed')
    expect(calls).contains('assertScreenshot')
    expect(calls).not.contains('assertWithAI')
    const records = result.checkpoints as any[]
    expect(records[0].annotation).equals(undefined)
    expect(records[0].ask).equals(undefined)
    expect(result.goldens).deep.equals({ differs: [key], missing: [] })
  })

  it('is a harness error for a malformed goldens.json when goldens are handed over', async function () {
    const root = join(scratch, 'bad-goldens-root')
    mkdirSync(join(root, 'e2e'), { recursive: true })
    writeFileSync(join(root, 'e2e', 'goldens.json'), '{ "directory": 3 }')
    const result = await runScenario(
      specWith(async () => undefined),
      'go',
      handoff({ goldensDir: scratch }),
      { maestro: fakeClient([]) },
      { ...deps, root }
    )
    expect(result.status).equals('harness-error')
    expect(result.reason).contains('directory')
  })

  it('waits for mail through the stack control, and blocks with no control', async function () {
    let asks = 0
    const fetchFn = (async (url: string) => {
      if (url.includes('/mail?')) {
        asks++
        return new Response(
          JSON.stringify({
            messages:
              asks < 2
                ? []
                : [
                    {
                      from: 'noreply@teamstation.test',
                      subject: 'Hi',
                      body: 'Welcome'
                    }
                  ]
          })
        )
      }
      return new Response(JSON.stringify({ errors: [] }))
    }) as unknown as typeof fetch
    const control = {
      kind: 'isolated' as const,
      origin: 'https://stack.example.test',
      services: [],
      control: { url: 'https://stack.example.test/__e2e/', token: 't' }
    }
    const got = await runScenario(
      specWith(async ctx => {
        const address = ctx.address('invite')
        expect(address).equals('e2e+invite@example.test')
        const mail = await ctx.mail(address, 'noreply@')
        expect(mail.subject).equals('Hi')
        expect(mail.body()).equals('Welcome')
      }),
      'go',
      handoff({ stack: control }),
      { maestro: fakeClient([]) },
      { ...deps, fetchFn, mailWaitMs: 5, mailPollMs: 1 }
    )
    expect(got.status).equals('passed')
    expect(asks).equals(2)
    const late = await runScenario(
      specWith(async ctx => {
        await ctx.mail('x@example.test', 'noreply@')
      }),
      'go',
      handoff({ stack: control }),
      { maestro: fakeClient([]) },
      {
        ...deps,
        fetchFn: (async (url: string) =>
          new Response(
            JSON.stringify(
              url.includes('/mail?') ? { messages: [] } : { errors: [] }
            )
          )) as unknown as typeof fetch,
        mailWaitMs: 5,
        mailPollMs: 1
      }
    )
    expect(late.status).equals('failed')
    expect(late.reason).contains('No mail from noreply@ reached x@example.test')
    const blocked = await runScenario(
      specWith(async ctx => {
        await ctx.mail('x@example.test', 'noreply@')
      }),
      'go',
      handoff(),
      { maestro: fakeClient([]) },
      deps
    )
    expect(blocked.reason).equals('this stack has no mail capture to read')
  })

  it('names a role it has no device for, and keeps evidence of a failed checkpoint', async function () {
    const given = handoff()
    const result = await runScenario(
      specWith(async ctx => {
        expect(() => ctx.attached('umpire')).to.throw(
          'no device is attached for role "umpire"'
        )
        expect(() => ctx.device('umpire')).to.throw(
          'no device for role "umpire"'
        )
        expect(() => ctx.app('teamstation-android')).to.throw('no app id')
        expect(ctx.lastDevice()).equals(ctx.attached('player'))
        expect(ctx.artifact('x.png')).equals(join(given.runDir, 'x.png'))
        ctx.degrade('a slower phone')
        await ctx.attach('umpire', {})
      }),
      'go',
      given,
      { maestro: fakeClient([]) },
      deps
    )
    expect(result.status).equals('harness-error')
    expect(result.reason).contains('role "umpire" has no device')
    expect(result.degradations).deep.equals(['a slower phone'])

    const failed = handoff()
    const red = await runScenario(
      specWith(
        async ctx => {
          await ctx.checkpoint('home', { expect: [{ text: 'Home' }] })
        },
        { quarantine: { reason: 'flaky', since: '2026-11-26' } }
      ),
      'go',
      failed,
      {
        maestro: fakeClient([], {
          assertVisible: async () => {
            throw new Error('Element not found')
          },
          screenshot: async () => new Uint8Array([7])
        })
      },
      deps
    )
    expect(red.status).equals('quarantined')
    expect(red.failureKind).equals('assertion')
    expect(readFileSync(join(failed.runDir, 'failure-0.png'))[0]).equals(7)
  })

  it('degrades a simulator whose status bar cannot be pinned, and passes', async function () {
    const result = await runScenario(
      specWith(async ctx => {
        await ctx.checkpoint('home', {})
      }),
      'go',
      handoff(),
      {
        maestro: fakeClient([], {
          setStatusBar: async () => {
            throw new Error('UNSUPPORTED')
          },
          platformInfo: undefined
        })
      },
      deps
    )
    expect(result.status).equals('passed-degraded')
    expect(result.degradations[0]).contains('no demo status bar')
    expect(result.deviceClass).equals('ios-phone')
  })

  it('opens the local browser through the runner, applies a style fault there, and closes it', async function () {
    const calls: string[] = []
    const page = {
      setViewport: async (size: unknown) => {
        calls.push(`viewport ${JSON.stringify(size)}`)
      }
    }
    const connectPage = (async () => ({
      browser: {
        version: async () => 'HeadlessChrome/131.0.6778.0',
        disconnect: async () => {
          calls.push('disconnect')
        }
      },
      page
    })) as any
    const browserClient = fakeClient(calls, {
      evalBrowserScript: async () => {
        calls.push('style fault')
      },
      getConsoleLogs: async () => ({ data: [] })
    })
    const result = await runScenario(
      specWith(
        async ctx => {
          const session = await ctx.browser({ width: 1280, height: 900 })
          expect(session.deviceClass).equals('chromium-1280x900-131')
          await session.resize({ width: 800, height: 600 })
          await ctx.checkpoint('home', {})
          ctx.watch(session.m, { deviceClass: 'other' })
        },
        { surfaces: { 'web-chromium': { devices: [] } }, apps: [] }
      ),
      'go',
      handoff({
        surface: 'web-chromium',
        devices: {},
        browser: { daemon: 'local', placement: 'droplet' },
        fault: 'layout-shift'
      }),
      { maestro: fakeClient(['hub']), browser: browserClient },
      { ...deps, connectPage }
    )
    expect(result.status).equals('passed')
    expect(calls[0]).match(/^attach web-[0-9a-f]{8} about:blank#web-/)
    expect(calls).contains('viewport {"width":800,"height":600}')
    expect(calls).contains('style fault')
    expect(calls.slice(-2)).deep.equals(['disconnect', calls.at(-1)])
    expect(calls.at(-1)).match(/^detach web-/)

    const broken = await runScenario(
      specWith(
        async ctx => {
          await ctx.browser({ width: 10, height: 10 })
        },
        { surfaces: { 'web-chromium': { devices: [] } }, apps: [] }
      ),
      'go',
      handoff({
        surface: 'web-chromium',
        devices: {},
        browser: { daemon: 'local', placement: 'droplet' }
      }),
      { maestro: fakeClient(calls) },
      {
        ...deps,
        connectPage: async () => {
          throw new Error('no DevToolsActivePort')
        }
      }
    )
    expect(broken.status).equals('failed')
    expect(broken.failureKind).equals('crash')
    expect(broken.reason).equals('no DevToolsActivePort')
  })

  it('runs platform/dump-world/sign-in on its dump world account, in the local browser', async function () {
    const spec = loadSpec('e2e/tests/platform/dump-world/sign-in.e2e.ts', ROOT)
    const seen: string[] = []
    const browserDevice = {
      openLink: async (options: { link: string }) => {
        seen.push(`open ${options.link}`)
      },
      assertVisible: async (selector: { text: string }) => {
        seen.push(`see ${selector.text}`)
      },
      tapOn: async () => undefined,
      eraseText: async () => undefined,
      inputText: async (options: { text: string }) => {
        seen.push(`type ${options.text.includes('@') ? options.text : '…'}`)
      },
      hierarchy: async () => ({ text: 'Hosts' }),
      screenshot: async () => new Uint8Array([1]),
      getConsoleLogs: async () => ({ data: [] }),
      detach: async () => undefined
    }
    const result = await runScenario(
      spec,
      'coach-sees-team',
      handoff({
        surface: 'web-chromium',
        devices: {},
        apps: {},
        browser: { daemon: 'local', placement: 'droplet' }
      }),
      { maestro: { attach: async () => browserDevice as any } },
      {
        ...deps,
        connectPage: (async () => ({
          browser: {
            version: async () => 'HeadlessChrome/128.0.0.0',
            disconnect: async () => undefined
          },
          page: {}
        })) as any
      }
    )
    expect(result.status).equals('passed')
    const coach = JSON.parse(
      readFileSync(
        join(ROOT, 'e2e/fixtures/dumps/coach-season-dump.accounts.json'),
        'utf8'
      )
    ).accounts.coach
    expect(seen).deep.equals([
      'open https://stack.example.test/',
      'see Use a password instead',
      `type ${String(coach.email)}`,
      'type …',
      // The password form, then its sign-in loop, each look for the menu mark.
      'see TeamStation menu',
      'see TeamStation menu',
      'see Hosts'
    ])
  })

  it('names the ids and platforms it attaches by', function () {
    expect(hubId('X', 'h:1')).equals('X@h:1')
    expect(hubId('X@other', 'h:1')).equals('X@other')
    expect(platformOf('ipad')).equals('ios')
    expect(platformOf('android-tablet')).equals('android')
    expect(platformOf('web')).equals(undefined)
  })
})

describe('the needs vocabulary', function () {
  it('maps an old spec, stack none with tess-model, to isolated with real-model', function () {
    // real-model.integration.ts as it was before M4 converted it.
    const spec = {
      ...loadSpec('e2e/tests/assistant/chat/real-model.integration.ts', ROOT),
      stack: 'none' as const,
      services: ['tess-model']
    }
    const needs = normalizedNeeds(spec)
    expect(needs.stack).equals('isolated')
    expect(needs.services).deep.equals(['real-model'])
    const surface = Object.keys(
      needs.surfaces
    )[0] as keyof typeof needs.surfaces
    const given: Handoff = {
      version: HARNESS_VERSION,
      hub: 'h',
      surface,
      devices: Object.fromEntries(
        (needs.surfaces[surface]?.devices ?? []).map(role => [
          role.role,
          { id: 'D', deviceClass: 'ios-phone', real: true }
        ])
      ),
      apps: Object.fromEntries(needs.apps.map(kind => [kind, 'app.x'])),
      browser: { daemon: 'local', placement: 'droplet' },
      stack: { kind: 'isolated', origin: 'o', services: ['real-model'] },
      secrets: Object.fromEntries(needs.secrets.map(name => [name, 'v'])),
      aiBudgetUsd: 0,
      runDir: '/nowhere'
    }
    expect(handoffProblem(needs, given)).equals(undefined)
  })

  it('maps the old fields: seat to isolated, smtp to mail-capture, api and web dropped, a role without simulator to never', function () {
    const needs = normalizedNeeds(
      specWith(async () => undefined, {
        stack: 'seat',
        services: ['api', 'web', 'smtp', 'reverse-proxy']
      })
    )
    expect(needs.stack).equals('isolated')
    expect(needs.services).deep.equals(['mail-capture', 'reverse-proxy'])
    expect(
      needs.surfaces['ios-app']?.devices.map(role => role.simulator)
    ).deep.equals(['never', 'never'])
    expect(mapService('dictation-model')).equals('dictation-model')
    expect(mapService('web')).equals(undefined)
    const none = normalizedNeeds(
      specWith(async () => undefined, { stack: 'none', services: [] })
    )
    expect(none.stack).equals('none')
  })

  it('keeps allowed for a role that says so, but never with camera, push or gpu', function () {
    const needs = normalizedNeeds(
      specWith(async () => undefined, {
        surfaces: {
          'android-app': {
            devices: [
              {
                role: 'a',
                needs: ['android-phone'],
                hardware: 'none',
                simulator: 'allowed'
              },
              {
                role: 'b',
                needs: ['android-phone', 'camera'],
                hardware: 'none',
                simulator: 'allowed'
              }
            ]
          },
          'web-chromium': {
            devices: [],
            browser: { role: 'browser', needs: ['video'], codecs: ['hevc'] }
          }
        }
      })
    )
    expect(
      needs.surfaces['android-app']?.devices.map(role => role.simulator)
    ).deep.equals(['allowed', 'never'])
    expect(needs.surfaces['web-chromium']?.browser?.placement).equals('mac')
  })

  it("still validates 'seat' and the old service names in M2", function () {
    expect(
      needProblems({
        surfaces: {
          'ios-app': {
            devices: [{ role: 'r', needs: ['ios'], hardware: 'required' }]
          }
        },
        services: ['api', 'web', 'smtp', 'tess-model', 'mail-capture']
      })
    ).deep.equals([])
    expect(
      needProblems({ surfaces: {}, services: ['carrier-pigeon'] })
    ).deep.equals(['unknown service "carrier-pigeon"'])
  })
})

describe('compare: ai checkpoints', function () {
  let scratch: string
  before(function () {
    scratch = mkdtempSync(join(tmpdir(), 'ai-checkpoint-test-'))
  })
  after(function () {
    rmSync(scratch, { recursive: true, force: true })
  })

  const answer = (
    verdict: 'pass' | 'fail' | 'unsure',
    confidence: number,
    costUsd = 0.01
  ): Record<string, unknown> => ({
    verdict,
    confidence,
    model: 'claude-haiku-5-5',
    escalations: [{ model: 'jev-1.14.0', verdict: 'unsure' }],
    observed: `the screen, ${verdict}`,
    costUsd
  })

  function checkpoints(
    authoritative: boolean,
    budget = new Budget(1)
  ): Checkpoints {
    return new Checkpoints({
      scenarioId: 'a/b/c#d',
      surface: 'ios-app',
      runDir: join(scratch, `run-${Math.random()}`),
      root: scratch,
      settings: {},
      serverErrors: async () => undefined,
      alone: true,
      worldIds: () => [],
      ai: { budget, authoritative }
    })
  }

  /** A device whose assertWithAI resolves as the real client does: the answer in the step's data. */
  function device(
    replies: Array<Record<string, unknown>>,
    asked: Array<Record<string, unknown>>
  ): any {
    return {
      hierarchy: async () => ({ text: 'Home' }),
      screenshot: async () => new Uint8Array([1]),
      state: async () => ({}),
      assertWithAI: async (options: Record<string, unknown>) => {
        asked.push(options)
        return { success: true, data: replies.shift() }
      }
    }
  }

  const target = (d: any): any => ({
    device: d,
    deviceClass: 'ios-device',
    consoleSeen: 0
  })

  it('passes a pass, and keeps the whole answer in record.ai', async function () {
    const asked: Array<Record<string, unknown>> = []
    const run = checkpoints(false)
    await run.check(
      'home',
      { compare: 'ai', prompt: 'The home screen lists the team' },
      target(device([answer('pass', 0.9)], asked))
    )
    expect(run.records[0].ask).deep.include({
      verdict: 'pass',
      question: 'The home screen lists the team',
      model: 'claude-haiku-5-5',
      costUsd: 0.01
    })
    expect(run.records[0].ai?.confidence).equals(0.9)
    expect(asked[0].assertion).equals('The home screen lists the team')
  })

  it('makes unsure needs-review, a fail below the bar needs-review, and a fail at the bar failed', async function () {
    const asked: Array<Record<string, unknown>> = []
    const below = checkpoints(false)
    await below.check(
      'a',
      { compare: 'ai', prompt: 'p' },
      target(device([answer('unsure', 0.5)], asked))
    )
    await below.check(
      'b',
      { compare: 'ai', prompt: 'p' },
      target(device([answer('fail', 0.95)], asked))
    )
    expect(below.records.map(row => row.ask?.verdict)).deep.equals([
      'needs-review',
      'needs-review'
    ])
    expect(below.records[1].ask?.detail).contains('not reached the bar')
    const { statusFromCheckpoints } = await import('./checkpoint')
    expect(statusFromCheckpoints(below.records).status).equals('needs-review')

    const at = checkpoints(true)
    await at.check(
      'c',
      { compare: 'ai', prompt: 'p' },
      target(device([answer('fail', 0.95)], asked))
    )
    expect(at.records[0].ask?.verdict).equals('fail')
    expect(statusFromCheckpoints(at.records).status).equals('failed')
  })

  it("lowers the second call's budgetUsd by the first call's costUsd", async function () {
    const asked: Array<Record<string, unknown>> = []
    const budget = new Budget(1)
    const run = checkpoints(false, budget)
    const d = device(
      [answer('pass', 0.9, 0.25), answer('pass', 0.9, 0.5)],
      asked
    )
    await run.check('a', { compare: 'ai', prompt: 'p' }, target(d))
    await run.check('b', { compare: 'ai', prompt: 'p' }, target(d))
    expect(asked.map(row => row.budgetUsd)).deep.equals([1, 0.75])
    expect(budget.spentUsd).equals(0.75)
  })

  it('reads a bare answer too, and is a harness error for no verdict, no prompt or a failed call', async function () {
    const run = checkpoints(false)
    const bare: any = {
      hierarchy: async () => ({ text: 'Home' }),
      screenshot: async () => new Uint8Array([1]),
      state: async () => ({}),
      assertWithAI: async () => answer('pass', 0.8)
    }
    await run.check('a', { compare: 'ai', prompt: 'p' }, target(bare))
    expect(run.records[0].ask?.verdict).equals('pass')
    const broken = async (spec: any, overrides: any): Promise<string> => {
      try {
        await run.check('x', spec, target({ ...bare, ...overrides }))
      } catch (error) {
        return (
          (error as Error).constructor.name + ': ' + (error as Error).message
        )
      }
      return 'no error'
    }
    expect(await broken({ compare: 'ai' }, {})).contains('needs a prompt')
    expect(
      await broken(
        { compare: 'ai', prompt: 'p' },
        { assertWithAI: async () => ({ data: {} }) }
      )
    ).contains('no verdict')
    expect(
      await broken(
        { compare: 'ai', prompt: 'p' },
        {
          assertWithAI: async () => {
            throw new Error('no screenshot')
          }
        }
      )
    ).contains('HarnessError: Checkpoint "x": assertWithAI: no screenshot')
    expect(
      await broken({ compare: 'ai', prompt: 'p' }, { assertWithAI: undefined })
    ).contains('has no assertWithAI')
  })

  it('compares the golden of a checkpoint with golden and no compare, and nothing for one with neither', async function () {
    const goldensDir = join(scratch, 'goldens')
    const shots: unknown[] = []
    const d: any = {
      hierarchy: async () => ({ text: 'Home' }),
      screenshot: async () => new Uint8Array([1]),
      state: async () => ({}),
      assertScreenshot: async (options: unknown) => {
        shots.push(options)
        return { data: { matchPercentage: 100 } }
      }
    }
    const run = new Checkpoints({
      scenarioId: 'a/b/c#d',
      surface: 'ios-app',
      runDir: join(scratch, 'compare-run'),
      root: scratch,
      settings: {},
      serverErrors: async () => undefined,
      alone: true,
      worldIds: () => [],
      goldensDir
    })
    await run.check('with-golden', { golden: {} }, target(d))
    await run.check(
      'with-neither',
      { expect: [] },
      target({ ...d, assertVisible: async () => undefined })
    )
    await run.check('compare-golden', { compare: 'golden' }, target(d))
    expect(shots.length).equals(2)
    expect(run.records[0].visual?.verdict).equals('pass')
    expect(run.records[1].visual).equals(undefined)
    expect((shots[0] as { path: string }).path).equals(
      join(goldensDir, 'a/b/c#d/with-golden/ios-app@ios-device.png')
    )
  })

  it('answers needs-review with no AI runtime, as under run.ts', async function () {
    const run = new Checkpoints({
      scenarioId: 'a/b/c#d',
      surface: 'ios-app',
      runDir: join(scratch, 'no-ai'),
      root: scratch,
      settings: {},
      serverErrors: async () => undefined,
      alone: true,
      worldIds: () => []
    })
    await run.check(
      'a',
      { compare: 'ai', prompt: 'p' },
      target({
        hierarchy: async () => ({ text: 'Home' }),
        screenshot: async () => new Uint8Array([1]),
        state: async () => ({})
      })
    )
    expect(run.records[0].ask?.verdict).equals('needs-review')
  })
})

describe('the fault-detection row', function () {
  it('is the same row detect.ts built, from detectRow.ts', function () {
    const result: RunResult = {
      scenario: 's',
      surface: 'web-chromium',
      ref: 'r',
      deviceClass: 'd',
      status: 'failed',
      durationMs: 1,
      costUsd: 0,
      degradations: [],
      checkpoints: [
        { id: 'c', basis: 'MEASURED', expect: 'pass', readBack: 'fail' }
      ]
    }
    const row = detectRow(
      result,
      { scenario: 's', surface: 'web-chromium', fault: 'not-saved' },
      new Date('2026-11-26T00:00:00Z')
    )
    expect(row).deep.equals({
      kind: 'detect',
      at: '2026-11-26T00:00:00.000Z',
      scenario: 's',
      surface: 'web-chromium',
      fault: 'not-saved',
      ref: 'r',
      caught: true,
      caughtBy: 'read-back',
      expectedLayer: true,
      status: 'failed'
    })
    expect(
      caughtByLayer({ ...result, checkpoints: [], failureKind: 'crash' })
    ).equals('test-crash')
    expect(
      detectRow(
        { ...result, checkpoints: [], failureKind: 'crash' },
        {
          scenario: 's',
          surface: 'web-chromium',
          fault: 'api-500'
        }
      ).caught
    ).equals(false)
    expect(
      caughtByLayer(
        { ...result, checkpoints: [], serverErrors: [{}] },
        'api-500'
      )
    ).equals('invariant')
  })
})

describe('defineSplash under the harness', function () {
  const target = {
    platform: 'ios' as const,
    statusBar: 54,
    name: 'phone'
  }
  const spec = defineSplash({
    behaviour: 'phone-launch-test',
    title: 't',
    surface: 'ios-app',
    needs: ['ios-phone'],
    covers: ['x'],
    target,
    scenarios: {
      launch: async (_ctx, device, given) => {
        await device.launchApp({ appId: given.appId })
      }
    }
  })

  function context(calls: string[], statusBar: (mode: string) => void): any {
    const device = {
      launchApp: async (options: { appId: string }) => {
        calls.push(`launch ${options.appId}`)
      },
      setStatusBar: async (options: { mode: string }) => {
        calls.push(`status bar ${options.mode}`)
        statusBar(options.mode)
      }
    }
    return {
      attach: async (_role: string, options: { appId: string }) => {
        calls.push(`attach ${options.appId}`)
        return device
      },
      app: (kind: string) => `caller.${kind}`
    }
  }

  it("attaches and launches ctx.app('teamstation-ios'), with a demo status bar given back", async function () {
    const calls: string[] = []
    await spec.scenarios.launch(context(calls, () => undefined))
    expect(calls).deep.equals([
      'attach caller.teamstation-ios',
      'status bar demo',
      'launch caller.teamstation-ios',
      'status bar live'
    ])
    expect(
      targetFor(
        context([], () => undefined),
        {
          ...target,
          platform: 'android'
        }
      ).appId
    ).equals('caller.teamstation-android')
  })

  it('goes on where a physical iPhone has no status bar override, and fails on anything else', async function () {
    const calls: string[] = []
    await spec.scenarios.launch(
      context(calls, () => {
        throw new Error(
          'UNSUPPORTED: status bar override on a physical iOS device'
        )
      })
    )
    expect(calls).contains('launch caller.teamstation-ios')
    let failed = ''
    try {
      await spec.scenarios.launch(
        context([], () => {
          throw new Error('device gone')
        })
      )
    } catch (error) {
      failed = (error as Error).message
    }
    expect(failed).equals('device gone')
  })
})

describe('the stack control client', function () {
  it('calls each control route with the token, and names a refusal', async function () {
    const seen: string[] = []
    const fetchFn = (async (url: string, init: any) => {
      seen.push(`${String(init.method)} ${url}`)
      if (url.endsWith('nope')) return new Response('gone', { status: 404 })
      if (url.includes('errors')) {
        return new Response(JSON.stringify({ errors: [{ status: 500 }] }))
      }
      return new Response('{}')
    }) as unknown as typeof fetch
    const control = stackControl(
      { url: 'https://s/__e2e', token: 't' },
      fetchFn
    )
    await control.rateLimits()
    await control.restartApi()
    expect(await control.serverLog(5)).deep.equals([{ status: 500 }])
    await control.jev.read()
    await control.jev.set({ passThrough: true })
    await control.remux({ id: 1 })
    await control.mail('a+b@example.test', 7)
    await control.push(8)
    await control.pages.script({ '/x': { type: 'text/html', body: 'x' } })
    await control.pages.requests(9)
    await control.sql('SELECT 1')
    await control.sql('SELECT $1', [2])
    await control.call('GET', '/model/calls')
    expect(seen).deep.equals([
      'POST https://s/__e2e/rate-limits',
      'POST https://s/__e2e/restart-api',
      'GET https://s/__e2e/errors?since=5',
      'GET https://s/__e2e/jev',
      'PUT https://s/__e2e/jev',
      'POST https://s/__e2e/remux',
      'GET https://s/__e2e/mail?to=a%2Bb%40example.test&since=7',
      'GET https://s/__e2e/push?since=8',
      'PUT https://s/__e2e/pages',
      'GET https://s/__e2e/pages/requests?since=9',
      'POST https://s/__e2e/sql',
      'POST https://s/__e2e/sql',
      'GET https://s/__e2e/model/calls'
    ])
    const nope = stackControl(
      { url: 'https://s/', token: 't' },
      async () => new Response('gone', { status: 404 })
    )
    let message = ''
    try {
      await nope.push(0)
    } catch (error) {
      message = (error as Error).message
    }
    expect(message).equals(
      "the stack's control answered GET push?since=0 with 404: gone"
    )
  })
})

describe('defineHarness', function () {
  it('answers the spec it is given, typed for runScenario alone', function () {
    const base = specWith(async () => undefined)
    const spec: HarnessSpec = defineHarness({
      ...base,
      scenarios: {
        go: async ctx => {
          ctx.app('teamstation-ios')
        }
      }
    })
    expect(spec.id).equals(base.id)
  })
})
