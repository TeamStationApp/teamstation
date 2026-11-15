import { existsSync, mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { expect } from 'chai'
import { describe, it } from 'mocha'

import { BlockedError } from '../../core/result'
import type { E2eContext } from '../../core/spec'
import type { TileClock } from './clockReader'
import type { SoakSettings, StreamingWorld } from './streamingSession'
import { awaitable, type Call, fakeDevice, png } from './surfaces/fakes.test'
import type { SurfaceProbe } from './surfaces/surface'
import {
  fractionFor,
  lookFrom,
  medianMs,
  memorySamplers,
  overall,
  Recorder,
  runTargeted,
  spreadMs,
  type StepRecord,
  type TargetedDeps,
  type TargetedDriver,
  type TargetedSession,
  type TargetedSetup,
  tileMoments,
  verdicts,
  waitFor
} from './targeted'

const T0 = Date.UTC(2026, 10, 14, 12, 0, 0)
const DAY = 86_400_000

function clock(angle: string, atMs: number, confidence = 1): TileClock {
  return {
    angle,
    reading: { msOfDay: atMs % DAY, label: angle.toUpperCase(), confidence }
  }
}

function step(
  surface: string,
  verdict: StepRecord['verdict'],
  name = 's'
): StepRecord {
  return {
    atMs: 0,
    step: name,
    surface,
    expected: '',
    observed: '',
    verdict
  }
}

async function rejection(promise: Promise<unknown>): Promise<Error> {
  return await promise.then(
    () => {
      throw new Error('expected a rejection')
    },
    (error: unknown) => error as Error
  )
}

describe('the targeted helpers', function () {
  it('puts the bar at a moment of the take, within its ends', function () {
    expect(fractionFor(T0 + 30_000, T0, T0 + 120_000)).equals(0.25)
    expect(fractionFor(T0 - 1, T0, T0 + 120_000)).equals(0)
    expect(fractionFor(T0 + 999_000, T0, T0 + 120_000)).equals(1)
    expect(fractionFor(T0, T0, T0)).equals(1)
  })

  it('reads moments from confident clocks only, and how far apart they are', function () {
    const moments = tileMoments(
      [
        clock('SynthA', T0 + 1000),
        clock('SynthB', T0 + 1400),
        clock('SynthC', T0, 0.5),
        { angle: 'SynthD', reading: null }
      ],
      T0
    )
    expect([...moments]).deep.equals([
      ['SynthA', T0 + 1000],
      ['SynthB', T0 + 1400]
    ])
    expect(spreadMs(moments.values())).equals(400)
    expect(spreadMs([1])).equals(null)
    expect(medianMs([3, 1, 2])).equals(2)
    expect(medianMs([4, 1, 2, 3])).equals(2.5)
    expect(medianMs([])).equals(null)
  })

  it('asks until yes or the time is up, on its own clock or the real one', async function () {
    let t = 0
    let asked = 0
    const yes = await waitFor(
      async () => ({ ok: ++asked === 3, value: asked }),
      {
        timeoutMs: 60_000,
        everyMs: 5000,
        now: () => t,
        sleep: async ms => {
          t += ms
        }
      }
    )
    expect(yes).deep.equals({ ok: true, value: 3 })
    expect(t).equals(10_000)
    const no = await waitFor(async () => ({ ok: false, value: 'x' }), {
      timeoutMs: 5,
      everyMs: 2
    })
    expect(no).deep.equals({ ok: false, value: 'x' })
  })

  it('fails a surface with any failed step, and blocks one with a step blocked every time it was taken', function () {
    expect(
      verdicts([
        step('chrome', 'passed'),
        step('chrome', 'failed'),
        step('tv', 'blocked'),
        step('tv', 'blocked'),
        step('ipad', 'blocked'),
        step('ipad', 'passed'),
        step('iphone', 'passed', 'playing'),
        step('iphone', 'blocked', 'recover-scrubLeft'),
        step('iphone', 'blocked', 'recover-scrubLeft')
      ])
    ).deep.equals({
      chrome: 'failed',
      tv: 'blocked',
      ipad: 'passed',
      iphone: 'blocked'
    })
    expect(verdicts([])).deep.equals({})
    expect(overall([step('ipad', 'passed'), step('tv', 'blocked')])).equals(
      'blocked'
    )
    expect(overall([step('ipad', 'failed'), step('tv', 'blocked')])).equals(
      'failed'
    )
    expect(overall([step('ipad', 'passed')])).equals('passed')
    expect(overall([])).equals('blocked')
  })

  it('records each step with its picture, and without one it could not take', async function () {
    const dir = mkdtempSync(join(tmpdir(), 'targeted-recorder-'))
    const file = join(dir, 'targeted.jsonl')
    const saved: string[] = []
    const record = new Recorder(
      file,
      name => {
        saved.push(name)
        return `shots/${name}`
      },
      () => 42
    )
    await record.check(
      { role: 'iphone', screenshot: async () => png(2, 2) },
      'join',
      'opens',
      'opened',
      true
    )
    await record.check(
      {
        role: 'tv',
        screenshot: async () => {
          throw new Error('no picture')
        }
      },
      'join',
      'opens',
      'did not',
      false
    )
    await record.step({ role: 'chrome' }, 'join', 'opens', 'no', 'blocked')
    expect(saved).deep.equals(['join-iphone-1.png'])
    const lines = readFileSync(file, 'utf8')
      .trim()
      .split('\n')
      .map(line => JSON.parse(line) as StepRecord)
    expect(lines).deep.equals(record.steps)
    expect(lines.map(line => [line.surface, line.verdict])).deep.equals([
      ['iphone', 'passed'],
      ['tv', 'failed'],
      ['chrome', 'blocked']
    ])
    expect(lines[0]).includes({
      atMs: 42,
      screenshot: 'shots/join-iphone-1.png'
    })
    expect(lines[1]).not.have.property('screenshot')
    // The same step again keeps its own screenshot.
    await record.check(
      { role: 'iphone', screenshot: async () => png(2, 2) },
      'join',
      'opens',
      'opened',
      true
    )
    expect(saved).deep.equals(['join-iphone-1.png', 'join-iphone-2.png'])
    const real = new Recorder(file, name => name)
    expect(
      (await real.step({ role: 'x' }, 'a', 'b', 'c', 'passed')).atMs
    ).above(T0 - DAY * 365)
  })

  it('puts each tile beside the moment its clock shows', function () {
    const probe: SurfaceProbe = {
      tiles: [
        { angle: 'SynthA', advancing: true, notice: null },
        { angle: 'SynthB', advancing: false, notice: 'Camera catching up…' }
      ],
      bar: 0.5,
      foreground: true
    }
    expect(lookFrom(probe, [clock('SynthA', T0 + 500)], T0, 0)).deep.equals({
      atMs: T0,
      tiles: [
        { angle: 'SynthA', advancing: true, notice: null, wallMs: T0 + 500 },
        {
          angle: 'SynthB',
          advancing: false,
          notice: 'Camera catching up…',
          wallMs: null
        }
      ]
    })
    expect(
      lookFrom(
        { tiles: null, bar: null, foreground: null, reason: 'gone' },
        [],
        T0,
        0
      )
    ).deep.equals({ atMs: T0, tiles: null, reason: 'gone' })
    expect(
      lookFrom({ tiles: null, bar: null, foreground: null }, [], T0, 0)
    ).deep.equals({ atMs: T0, tiles: null })
  })
})

/** The TV's surface, whose bar lands where `landings` says and whose clocks show it. */
function tvDriver(): {
  driver: TargetedDriver
  scrubs: number[]
  landings: number[]
  clocks: { fail: boolean }
} {
  const scrubs: number[] = []
  const landings: number[] = []
  const clocks = { fail: false }
  let at = T0
  const driver: TargetedDriver = {
    name: 'tv',
    join: async () => {},
    cut: async () => {},
    scrub: async fraction => {
      scrubs.push(fraction)
      at = landings.shift() ?? at
    },
    rapidScrub: async () => {},
    skip: async () => {},
    slowMotion: async () => {},
    jumpToPresent: async () => {},
    exitAndReenter: async () => {},
    relaunch: async () => {},
    probe: async () => ({
      tiles: [{ angle: 'SynthA', advancing: true, notice: null }],
      bar: null,
      foreground: true
    }),
    readClocks: async () => {
      if (clocks.fail) throw new Error('no picture')
      return [clock('SynthA', at)]
    }
  }
  return { driver, scrubs, landings, clocks }
}

interface Rig {
  ctx: E2eContext
  deps: TargetedDeps
  dir: string
  log: string[]
  scrubs: number[]
  landings: number[]
  clocks: { fail: boolean }
  clock: { t: number }
  chromeCalls: Call[]
}

function rig(
  options: {
    settings?: Partial<SoakSettings>
    androidJoinFails?: boolean
  } = {}
): Rig {
  const dir = mkdtempSync(join(tmpdir(), 'targeted-run-'))
  const log: string[] = []
  const time = { t: T0 }
  const tv = tvDriver()
  const chrome = fakeDevice({ screenshot: png(2, 2) })
  const ctx = {
    artifact: (name: string) => join(dir, name),
    device: (role: string) => `id-${role}`,
    browser: async (size: { width: number }, emulation: unknown) => {
      log.push(`browser ${size.width} ${JSON.stringify(emulation)}`)
      return {
        m: chrome.device,
        page: {
          evaluate: async (script: string) => `evaluated ${script}`,
          createCDPSession: async () => ({
            send: async (method: string) => {
              log.push(`cdp ${method}`)
              return { method }
            },
            on: (event: string) => {
              log.push(`cdp on ${event}`)
            }
          }),
          browser: () => ({
            target: () => ({
              createCDPSession: async () => ({
                send: async (method: string) => {
                  log.push(`browser cdp ${method}`)
                  return { processInfo: [] }
                }
              })
            })
          })
        },
        close: async () => {
          log.push('browser closed')
        }
      }
    }
  } as unknown as E2eContext
  const settings: SoakSettings = {
    tvRemote: { command: ['remote'], env: {} },
    ndiCapture: { command: ['ndi'] },
    tvJoinSteps: [],
    ffmpeg: 'f',
    iosApp: 'a',
    shaper: '/Users/dev/.config/teamstation-e2e/shaper.mjs',
    shapedIps: { iphone: '192.0.2.1' },
    ...options.settings
  }
  const world = {
    handle: {
      version: 1,
      id: 'streamtest-1',
      origin: 'https://stack.example.test',
      api: 'https://stack.example.test/api/v1',
      rtmp: 'rtmp://h:1936'
    },
    settings,
    world: {
      gameId: 'g1',
      streams: [
        { label: 'SynthA', id: 'st-a', videoId: 'v-a', key: 'key-a' },
        { label: 'SynthB', id: 'st-b', videoId: 'v-b', key: 'key-b' }
      ],
      accounts: {}
    },
    emails: { owner: 'o@example.test', viewer: 'v@example.test' },
    links: {
      app: 'teamstation://games/g1?tab=watch',
      web: 'https://stack.example.test/games/g1?tab=watch',
      tvApp: 'teamstation-tv://games/g1'
    },
    stack: { api: 'https://stack.example.test/api/v1', serverLog: '/log' },
    ownerToken: 'o',
    link: (who: string) => async () => {
      log.push(`link ${who}`)
      return 'tok'
    },
    close: async () => {
      log.push('world closed')
    }
  } as unknown as StreamingWorld
  const deps: TargetedDeps = {
    memorySamplers: () => [],
    openWorld: async opened => {
      log.push(`world ${(opened.synthetic ?? []).join(',')}`)
      return world
    },
    deviceKit: () => ({
      attachIos: async role => {
        log.push(`attach ios ${role}`)
        return awaitable(fakeDevice({ screenshot: png(2, 2) }).device)
      },
      attachSafari: async role => {
        log.push(`attach safari ${role}`)
        return awaitable(fakeDevice({ screenshot: png(2, 2) }).device)
      },
      attachAndroid: async role => {
        log.push(`attach android ${role}`)
        return awaitable(
          fakeDevice({
            screenshot: png(2, 2),
            ...(options.androidJoinFails === false
              ? {}
              : {
                  tapOn: () => {
                    throw new Error('All angles is not shown')
                  }
                })
          }).device
        )
      },
      openIn: (role, platform) => async link => {
        log.push(`open ${role} ${platform} ${link}`)
      },
      saveShot: name => {
        log.push(`shot ${name}`)
        return name
      }
    }),
    tvKit: () => ({
      tv: tv.driver,
      remote: async steps => {
        log.push(`remote ${steps.join(' ')}`)
        return 'dump'
      }
    }),
    signInTv: async () => {
      log.push('tv signed in')
      return true
    },
    signInApp: async (_device, app, link, signIn) => {
      log.push(`signed in ${app} ${await link()}`)
      await signIn?.openIn?.('teamstation://signin')
    },
    recordSessions: async (_world, file) => {
      log.push(`sessions ${file}`)
    },
    publisher: publisher => {
      log.push(
        `publisher ${publisher.label} ${publisher.ffmpeg} ${readFileSync(publisher.urlFile, 'utf8')} ${String(publisher.offsetMinutes)}`
      )
      return {
        start: async () => {
          log.push(`start ${publisher.label}`)
        },
        stop: async () => {
          log.push(`stop ${publisher.label}`)
        },
        cut: async seconds => {
          log.push(`cut ${publisher.label} ${seconds}`)
        }
      }
    },
    run: async (command, args) => {
      log.push(`run ${command} ${args.join(' ')}`)
    },
    now: () => time.t,
    sleep: async ms => {
      time.t += ms
    }
  }
  return {
    ctx,
    deps,
    dir,
    log,
    scrubs: tv.scrubs,
    landings: tv.landings,
    clocks: tv.clocks,
    clock: time,
    chromeCalls: chrome.calls
  }
}

const ALL: TargetedSetup = {
  synthetic: ['SynthA', 'SynthB'],
  watchers: ['chrome', 'tv', 'iphone', 'android']
}

function summary(dir: string): unknown {
  return JSON.parse(readFileSync(join(dir, 'targeted-summary.json'), 'utf8'))
}

describe('running a targeted scenario', function () {
  it('sets every watcher up, publishes, joins, and passes when no step failed', async function () {
    const r = rig()
    let seen: TargetedSession | undefined
    await runTargeted(
      r.ctx,
      '/repo',
      ALL,
      async session => {
        seen = session
        // Android's join was blocked: it is out of the scenario's steps.
        expect(session.watchers.map(w => w.role)).deep.equals(
          ALL.watchers.filter(role => role !== 'android')
        )
        expect(session.takeStartMs).equals(T0)
        expect(session.now()).equals(T0 + 60_000)
        expect(session.shaper).equals(
          '/Users/dev/.config/teamstation-e2e/shaper.mjs'
        )
        expect(session.shapedIps).deep.equals({ iphone: '192.0.2.1' })
        expect(session.offsetMinutes).equals(0)
        expect(session.streamId('SynthB')).equals('st-b')
        expect(() => session.streamId('SynthZ')).throws(
          'no synthetic camera "SynthZ"'
        )
        const [chrome, tv, iphone] = session.watchers
        await chrome.cdp!.send('Fetch.enable', {})
        chrome.cdp!.on('Fetch.requestPaused', () => {})
        expect(await chrome.evaluate!('1')).equals('evaluated 1')
        await chrome.open!('https://stack.example.test/x')
        expect(await chrome.screenshot!()).instanceOf(Uint8Array)
        expect(await iphone.screenshot!()).instanceOf(Uint8Array)
        await tv.tv!.coldLaunch()
        expect(await tv.tv!.dump()).equals('dump')
        expect(await tv.tv!.approve()).equals(true)
        await session.record.check(tv, 'look', 'moving', 'moving', true)
      },
      r.deps
    )
    expect(seen).not.equals(undefined)
    expect(r.log).includes('world SynthA,SynthB')
    expect(r.log).includes('browser 1440 {"h264":true}')
    expect(r.log).includes('link viewer')
    expect(r.log).includes('attach ios iphone')
    expect(r.log).includes('attach android android')
    expect(r.log).includes('open iphone ios teamstation://signin')
    expect(r.log).includes('open android android teamstation://signin')
    expect(r.log).includes('signed in app.teamstation.develop tok')
    expect(r.log).includes(`sessions ${join(r.dir, 'sessions.json')}`)
    expect(r.log).includes(
      'publisher SynthA f rtmp://h:1936/live/key-a undefined'
    )
    expect(r.log).includes('cdp Fetch.enable')
    expect(r.log).includes('cdp on Fetch.requestPaused')
    // Once before the TV joins, so its home lists the live game, and once by the scenario.
    expect(
      r.log.filter(
        line =>
          line ===
          'run xcrun devicectl device process launch --device id-tv --terminate-existing app.teamstation.tv'
      )
    ).length(2)
    expect(r.log).includes('remote app:app.teamstation.tv wait:1 dump')
    expect(r.log.filter(line => line === 'tv signed in')).length(2)
    expect(r.log.slice(-4)).deep.equals([
      'stop SynthA',
      'stop SynthB',
      'browser closed',
      'world closed'
    ])
    expect(r.chromeCalls[0]).deep.equals([
      'openLink',
      { link: 'https://stack.example.test/signin/tok' }
    ])
    // The Chrome watcher joined the game page.
    expect(r.chromeCalls).deep.includes([
      'openLink',
      { link: 'https://stack.example.test/games/g1?tab=watch' }
    ])
    expect(summary(r.dir)).deep.equals({
      verdicts: { android: 'blocked', tv: 'passed' },
      steps: 2
    })
    const joined = readFileSync(join(r.dir, 'targeted.jsonl'), 'utf8')
      .trim()
      .split('\n')
      .map(line => JSON.parse(line) as StepRecord)
    expect(joined[0]).includes({
      step: 'join',
      surface: 'android',
      observed: 'All angles is not shown',
      verdict: 'blocked',
      screenshot: 'join-android-1.png'
    })
    expect(
      existsSync(join(tmpdir(), `targeted-rtmp-${process.pid}-SynthA`))
    ).equals(false)
  })

  it('samples memory for each watcher and the stack when asked, and writes into the run directory', async function () {
    const r = rig()
    let names: string[] = []
    await runTargeted(
      r.ctx,
      '/repo',
      { ...ALL, watchers: ['chrome', 'iphone', 'android'], memory: true },
      async session => {
        names = (session.memory ?? []).map(sampler => sampler.name)
        // Chrome's sampler reads through the browser's and the page's DevTools sessions.
        const chrome = session.memory!.find(s => s.name === 'chrome')!
        expect(await chrome.sample!(T0)).deep.equals([])
        session.writeArtifact('note.txt', 'hello')
        await session.record.check(session.watchers[0], 'x', '', '', true)
      },
      { ...r.deps, memorySamplers }
    )
    expect(names).deep.equals([
      'chrome',
      'iphone-xctrace',
      'android-meminfo',
      'stack'
    ])
    expect(readFileSync(join(r.dir, 'note.txt'), 'utf8')).equals('hello')
    expect(r.log).includes('browser cdp SystemInfo.getProcessInfo')
    expect(r.log).includes('cdp Performance.getMetrics')
  })

  it('takes no samplers when not asked', async function () {
    const r = rig()
    await runTargeted(
      r.ctx,
      '/repo',
      { ...ALL, watchers: ['iphone'] },
      async session => {
        expect(session.memory).equals(undefined)
        await session.record.check(session.watchers[0], 'x', '', '', true)
      },
      { ...r.deps, memorySamplers }
    )
  })

  it('samples an iPad with time to save its recording, and leaves Chrome out without its sessions', function () {
    const r = rig()
    const samplers = memorySamplers(
      r.ctx,
      { handle: JSON.parse('{"ssh": "o@h"}') },
      ['ipad', 'chrome', 'tv']
    )
    expect(samplers.map(s => s.name)).deep.equals(['ipad-xctrace', 'stack'])
  })

  it('hands back the watchers that failed a step, with the summary written', async function () {
    const r = rig({ settings: { offsetMinutes: 60 }, androidJoinFails: false })
    const outcome = await runTargeted(
      r.ctx,
      '/repo',
      { synthetic: ['SynthA'], watchers: ['android'], leadMs: 1000 },
      async session => {
        expect(session.offsetMinutes).equals(60)
        expect(session.now()).equals(T0 + 1000)
        await session.record.check(
          session.watchers[0],
          'look',
          'moving',
          'still',
          false
        )
      },
      r.deps
    )
    // The scenario's own file judges it: here is what it is handed.
    expect(outcome).deep.equals({
      failed: ['android'],
      steps: join(r.dir, 'targeted.jsonl')
    })
    expect(r.log).includes('publisher SynthA f rtmp://h:1936/live/key-a 60')
    expect(summary(r.dir)).deep.equals({
      verdicts: { android: 'failed' },
      steps: 1
    })
  })

  it('is blocked when every watcher was, or none took a step', async function () {
    const blocked = rig()
    const error = await rejection(
      runTargeted(
        blocked.ctx,
        '/repo',
        { synthetic: ['SynthA'], watchers: ['android'] },
        async () => {},
        blocked.deps
      )
    )
    expect(error).instanceOf(BlockedError)
    expect(error.message).contains('every watcher was blocked')
    const quiet = rig()
    expect(
      await rejection(
        runTargeted(
          quiet.ctx,
          '/repo',
          { synthetic: ['SynthA'], watchers: ['tv'] },
          async () => {},
          quiet.deps
        )
      )
    ).instanceOf(BlockedError)
  })

  it('lets go of everything when the scenario throws', async function () {
    const r = rig()
    r.deps.publisher = () => ({
      start: async () => {},
      stop: async () => {
        throw new Error('already stopped')
      },
      cut: async () => {}
    })
    r.deps.openWorld = async () => {
      const world = await rig().deps.openWorld({
        ctx: r.ctx,
        cwd: '/repo'
      })
      return {
        ...world,
        close: async () => {
          throw new Error('mirror gone')
        }
      }
    }
    const error = await rejection(
      runTargeted(
        r.ctx,
        '/repo',
        { synthetic: ['SynthA'], watchers: ['chrome'] },
        async () => {
          throw new Error('scenario broke')
        },
        r.deps
      )
    )
    expect(error.message).equals('scenario broke')
    expect(r.log).includes('browser closed')
    expect(summary(r.dir)).deep.equals({ verdicts: {}, steps: 0 })
  })

  async function withTv(
    body: (session: TargetedSession, r: Rig) => Promise<void>
  ): Promise<Rig> {
    const r = rig()
    await runTargeted(
      r.ctx,
      '/repo',
      { synthetic: ['SynthA'], watchers: ['tv'] },
      async session => {
        await body(session, r)
        await session.record.check(session.watchers[0], 'x', '', '', true)
      },
      r.deps
    )
    return r
  }

  it('looks at a watcher with its clocks, and without them when they cannot be read', async function () {
    await withTv(async (session, r) => {
      await session.watchers[0].surface.scrub(0.5)
      r.landings.push(session.now() - 30_000)
      await session.watchers[0].surface.scrub(0.5)
      const look = await session.look(session.watchers[0])
      expect(look).deep.equals({
        atMs: session.now(),
        tiles: [
          {
            angle: 'SynthA',
            advancing: true,
            notice: null,
            wallMs: session.now() - 30_000
          }
        ]
      })
      r.clocks.fail = true
      expect((await session.look(session.watchers[0])).tiles![0].wallMs).equals(
        null
      )
    })
  })

  it('refines a seek by reading the clocks back, until within two seconds', async function () {
    await withTv(async (session, r) => {
      const tv = session.watchers[0]
      await session.sleep(10 * 60_000)
      const target = T0 + 5 * 60_000
      r.landings.push(target + 8000, target + 3000, target + 500)
      expect(await session.seekTo(tv, target)).equals(target + 500)
      expect(r.scrubs).length(3)
      expect(r.scrubs[0]).closeTo(5 / 11, 0.001)
      expect(r.scrubs[1]).lessThan(r.scrubs[0])
      expect(r.scrubs[2]).lessThan(r.scrubs[1])
      r.scrubs.length = 0
      r.landings.push(target + 1000)
      expect(await session.seekTo(tv, target)).equals(target + 1000)
      expect(r.scrubs).length(1)
      r.scrubs.length = 0
      r.landings.push(target + 9000, target + 9000, target + 9000)
      expect(await session.seekTo(tv, target)).equals(target + 9000)
      expect(r.scrubs).length(3)
      r.scrubs.length = 0
      r.clocks.fail = true
      expect(await session.seekTo(tv, T0 + 99 * 60_000)).equals(null)
      expect(r.scrubs).deep.equals([1])
    })
  })
})

describe('a TV that never signs in', function () {
  it('is a failed step, and the run goes on without it', async function () {
    const r = rig()
    r.deps.signInTv = async () => {
      throw new Error('the TV is still signing in after 8 looks')
    }
    let roles: string[] = []
    await runTargeted(
      r.ctx,
      '/repo',
      { synthetic: ['SynthA'], watchers: ['tv', 'iphone'], leadMs: 0 },
      async session => {
        roles = session.watchers.map(w => w.role)
      },
      r.deps
    ).catch(() => undefined)
    expect(roles).deep.equals(['iphone'])
    const steps = readFileSync(join(r.dir, 'targeted.jsonl'), 'utf8')
    expect(steps).contains('"step":"sign-in","surface":"tv"')
    expect(steps).contains('the TV is still signing in after 8 looks')
  })
})
