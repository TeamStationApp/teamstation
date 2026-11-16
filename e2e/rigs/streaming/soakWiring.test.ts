import { EventEmitter } from 'node:events'
import { existsSync, mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { expect } from 'chai'

import type { FixtureAccount } from '../../../src/server/dev/fixtures/accounts'
import { BlockedError } from '../../core/result'
import type { E2eContext } from '../../core/spec'
import type { StreamingHandle } from '../../core/streamingStack'
import type { SoakSchedule } from './soakSchedule'
import {
  APP_PROCESS,
  gameLinks,
  REVOKE_SESSIONS,
  rtmpUrl,
  SIGN_IN_AS,
  soakAccounts,
  soakParts,
  type SoakPartsDeps,
  soakServerConfig,
  soakSettings,
  xctraceSampler
} from './soakWiring'
import type { StreamingWorld } from './streamingSession'
import { awaitable, fakeDevice, fixture } from './surfaces/fakes.test'
import type { SoakSurfaceDriver } from './surfaces/surface'

const HANDLE: StreamingHandle = {
  version: 1,
  id: 'streamtest-1',
  origin: 'https://streamtest.example.test/',
  api: 'https://streamtest.example.test/api/v1',
  ssh: 'stack@203.0.113.7',
  serverLog: '/example/api.log',
  hlsRoot: '/example/hls',
  databaseUrl: 'postgres://u:p@db.example.test/ts?sslmode=require',
  rtmp: 'rtmp://203.0.113.7:1935/live/',
  serverConfig: { sessionSecret: 's', live: { rtmpPort: 1935 } }
}

function thrown(run: () => unknown): Error {
  try {
    run()
  } catch (error) {
    return error as Error
  }
  throw new Error('expected a throw')
}

describe('the soak wiring', function () {
  it('signs the publishers and the TV in as the owner, and every watcher as the viewer', function () {
    expect(
      Object.entries(SIGN_IN_AS)
        .filter(([, who]) => who === 'owner')
        .map(([role]) => role)
    ).deep.equals(['publisherA', 'publisherB', 'tv'])
    for (const watcher of [
      'iphone',
      'android',
      'ipad',
      'chrome',
      'iphone-safari'
    ] as const) {
      expect(SIGN_IN_AS[watcher]).equals('viewer')
    }
  })

  it("names the world's owner and viewer, and refuses a world that lacks either", function () {
    const account = (role: string): FixtureAccount => ({
      role,
      email: `${role}@example.test`,
      password: '',
      userId: role,
      displayName: role
    })
    expect(
      soakAccounts({
        accounts: { owner: account('owner'), viewer: account('viewer') }
      })
    ).deep.equals({
      owner: 'owner@example.test',
      viewer: 'viewer@example.test'
    })
    expect(
      thrown(() => soakAccounts({ accounts: { owner: account('owner') } }))
        .message
    ).equals('the soak world has no viewer account')
    expect(thrown(() => soakAccounts({ accounts: {} })).message).equals(
      'the soak world has no owner account'
    )
  })

  it("ends every session but the TV's, the owner's included", function () {
    expect(REVOKE_SESSIONS).not.match(/user_id/)
    expect(REVOKE_SESSIONS).match(/device_name is distinct from 'Apple TV'/)
  })

  it('reads the bench settings, and blocks naming what is missing', function () {
    const settings = soakSettings({
      tvRemote: { command: ['python3', 'remote.py'], env: { TEAM: 't' } },
      ndiCapture: { command: ['python3', 'ndi.py', '{out}'] },
      tvJoinSteps: ['app:app.teamstation.tv', 'select'],
      ffmpeg: '/opt/ffmpeg',
      offsetMinutes: -480,
      iosApp: '/b/TeamStation Develop.app'
    })
    expect(settings.tvRemote.env).deep.equals({ TEAM: 't' })
    expect(settings.offsetMinutes).equals(-480)
    expect(
      soakSettings({
        tvRemote: { command: ['r'] },
        ndiCapture: { command: ['n'] },
        tvJoinSteps: [],
        ffmpeg: 'f',
        iosApp: 'a'
      }).tvRemote.env
    ).deep.equals({})
    const error = thrown(() => soakSettings(undefined))
    expect(error).instanceOf(BlockedError)
    expect(error.message).includes(
      'no tvRemote.command, ndiCapture.command, tvJoinSteps, ffmpeg, iosApp'
    )
  })

  it('keeps the conditioner and the shaped addresses that are strings, and drops the rest', function () {
    const base = {
      tvRemote: { command: ['r'] },
      ndiCapture: { command: ['n'] },
      tvJoinSteps: [],
      ffmpeg: 'f',
      iosApp: 'a'
    }
    expect(
      soakSettings({
        ...base,
        shapedIps: { iphone: '192.0.2.20', android: 7, ipad: null }
      }).shapedIps
    ).deep.equals({ iphone: '192.0.2.20' })
    expect(soakSettings(base)).not.have.property('shapedIps')
    expect(soakSettings(base)).not.have.property('shaper')
    expect(
      soakSettings({
        ...base,
        shaper: '/Users/dev/.config/teamstation-e2e/shaper.mjs'
      }).shaper
    ).equals('/Users/dev/.config/teamstation-e2e/shaper.mjs')
    expect(soakSettings({ ...base, shapedIps: 'x' })).not.have.property(
      'shapedIps'
    )
  })

  it('opens the game in the app, on the web and on the TV', function () {
    expect(gameLinks(HANDLE.origin, 'g1')).deep.equals({
      app: 'teamstation://games/g1?tab=watch',
      web: 'https://streamtest.example.test/games/g1?tab=watch',
      tvApp: 'teamstation-tv://games/g1'
    })
  })

  it('mints keys with the stack settings, and blocks a handle without them', function () {
    expect(soakServerConfig(HANDLE)).deep.equals({
      sessionSecret: 's',
      live: { rtmpPort: 1935 }
    })
    expect(
      thrown(() => soakServerConfig({ ...HANDLE, serverConfig: undefined }))
    ).instanceOf(BlockedError)
  })

  it("puts the synthetic camera's key on the stack's ingest", function () {
    expect(rtmpUrl(HANDLE, 'key1')).equals('rtmp://203.0.113.7:1935/live/key1')
    expect(
      rtmpUrl({ ...HANDLE, rtmp: 'rtmp://203.0.113.7:1936' }, 'k2')
    ).equals('rtmp://203.0.113.7:1936/live/k2')
    expect(
      thrown(() => rtmpUrl({ ...HANDLE, rtmp: undefined }, 'k'))
    ).instanceOf(BlockedError)
  })

  describe('the Activity Monitor recording', function () {
    function recorder(exitAtOnce: boolean): {
      kills: string[]
      spawn: (command: string, args: string[]) => any
      args: string[][]
    } {
      const kills: string[] = []
      const args: string[][] = []
      return {
        kills,
        args,
        spawn: (command, given) => {
          args.push([command, ...given])
          const child: any = new EventEmitter()
          child.kill = (signal: string) => {
            kills.push(signal)
            setImmediate(() => child.emit('exit', 0))
          }
          if (exitAtOnce) setImmediate(() => child.emit('exit', 1))
          return child
        }
      }
    }
    const xml = fixture('xctraceAll.xml')

    it('records every process into its own folder, then stops and exports it', async function () {
      const dir = join(mkdtempSync(join(tmpdir(), 'soak-xc-')), 'traces')
      const r = recorder(false)
      const exported: string[][] = []
      const sampler = xctraceSampler(
        { name: 'ipad', udid: 'udid-1', dir },
        {
          spawn: r.spawn,
          exec: async (command, args) => {
            exported.push([command, ...args])
            return xml
          },
          now: () => 1000
        }
      )
      await sampler.start!()
      expect(r.args[0]).includes('--all-processes')
      expect(r.args[0]).includes(join(dir, 'ipad-1.trace'))
      const samples = await sampler.stop!()
      expect(samples!.length).greaterThan(0)
      expect(samples!.every(sample => sample.device === 'ipad')).equals(true)
      // The develop app by its exact name, not the other app called TeamStation.
      expect(
        samples!
          .filter(sample => sample.process !== 'com.apple.WebKit.WebContent')
          .map(sample => [sample.process, sample.pid])
      ).deep.equals([
        [APP_PROCESS, 900],
        [APP_PROCESS, 900]
      ])
      expect(r.kills).deep.equals(['SIGINT'])
      expect(exported[0][0]).equals('xcrun')
    })

    it("reads the app it is given by name, as the TV's is", async function () {
      const dir = join(mkdtempSync(join(tmpdir(), 'soak-xc-')), 'traces')
      const sampler = xctraceSampler(
        { name: 'tv', udid: 'udid-tv', dir, appName: 'TeamStation' },
        { spawn: recorder(false).spawn, exec: async () => xml, now: () => 0 }
      )
      await sampler.start!()
      expect(
        (await sampler.stop!())!.map(sample => [sample.process, sample.pid])
      ).deep.equals([['TeamStation', 777]])
    })

    it('hands over to a new recording each piece, and reads the one that ended', async function () {
      const dir = join(mkdtempSync(join(tmpdir(), 'soak-xc-')), 'traces')
      const r = recorder(false)
      let now = 0
      const sampler = xctraceSampler(
        { name: 'ipad', udid: 'udid-1', dir, pieceMs: 1000 },
        { spawn: r.spawn, exec: async () => xml, now: () => now }
      )
      await sampler.start!()
      expect(await sampler.sample!(500)).deep.equals([])
      now = 1200
      const first = await sampler.sample!(1200)
      expect(first.length).greaterThan(0)
      expect(r.kills).deep.equals(['SIGINT'])
      expect(
        r.args.map(args => args.find(arg => arg.endsWith('.trace')))
      ).deep.equals([join(dir, 'ipad-1.trace'), join(dir, 'ipad-2.trace')])
      expect((await sampler.stop!())!.length).greaterThan(0)
    })

    it('kills a recording that will not stop, and says so', async function () {
      const dir = join(mkdtempSync(join(tmpdir(), 'soak-xc-')), 'traces')
      const kills: string[] = []
      const sampler = xctraceSampler(
        { name: 'tv', udid: 'udid-3', dir, stopMs: 10 },
        {
          spawn: () => {
            const child: any = new EventEmitter()
            child.kill = (signal: string) => {
              kills.push(signal)
            }
            return child
          },
          exec: async () => xml,
          now: () => 0
        }
      )
      await sampler.start!()
      expect(
        await sampler.stop!().catch((e: unknown) => (e as Error).message)
      ).equals('tv: the Activity Monitor recording would not stop')
      expect(kills).deep.equals(['SIGINT', 'SIGKILL'])
    })

    it('starts the next piece even when the last would not stop', async function () {
      const dir = join(mkdtempSync(join(tmpdir(), 'soak-xc-')), 'traces')
      let spawned = 0
      let now = 0
      const sampler = xctraceSampler(
        { name: 'tv', udid: 'udid-3', dir, stopMs: 10, pieceMs: 1000 },
        {
          spawn: () => {
            spawned++
            const child: any = new EventEmitter()
            child.kill = () => undefined
            return child
          },
          exec: async () => xml,
          now: () => now
        }
      )
      await sampler.start!()
      now = 2000
      expect(
        await sampler.sample!(2000).catch((e: unknown) => (e as Error).message)
      ).equals('tv: the Activity Monitor recording would not stop')
      expect(spawned).equals(2)
    })

    it('reads what a recording that ended early recorded, and says when it cannot', async function () {
      const dir = join(mkdtempSync(join(tmpdir(), 'soak-xc-')), 'traces')
      const r = recorder(true)
      const sampler = xctraceSampler(
        { name: 'tv', udid: 'udid-2', dir, appName: 'TeamStation' },
        { spawn: r.spawn, exec: async () => xml, now: () => 0 }
      )
      await sampler.start!()
      await new Promise(resolve => setImmediate(resolve))
      expect((await sampler.stop!())!.length).greaterThan(0)
      expect(r.kills).deep.equals([])
      const unread = xctraceSampler(
        { name: 'tv', udid: 'udid-2', dir },
        {
          spawn: recorder(true).spawn,
          exec: async () => {
            throw new Error('no such trace')
          },
          now: () => 0
        }
      )
      await unread.start!()
      await new Promise(resolve => setImmediate(resolve))
      expect(
        await unread.stop!().catch((e: unknown) => (e as Error).message)
      ).equals(
        'tv: the Activity Monitor recording ended early (1), and what it recorded could not be read: no such trace'
      )
    })

    it('hears an xcrun that could not start, rather than dying of it', async function () {
      const dir = join(mkdtempSync(join(tmpdir(), 'soak-xc-')), 'traces')
      const sampler = xctraceSampler(
        { name: 'ipad', udid: 'udid-1', dir },
        {
          spawn: () => {
            const child: any = new EventEmitter()
            child.kill = () => undefined
            setImmediate(() =>
              child.emit('error', new Error('spawn xcrun ENOENT'))
            )
            return child
          },
          exec: async () => {
            throw new Error('no such trace')
          },
          now: () => 0
        }
      )
      await sampler.start!()
      await new Promise(resolve => setImmediate(resolve))
      expect(
        await sampler.stop!().catch((e: unknown) => (e as Error).message)
      ).match(
        /^ipad: the Activity Monitor recording ended early \(spawn xcrun ENOENT\)/
      )
    })

    it('has nothing to give when it never started', async function () {
      const sampler = xctraceSampler(
        { name: 'x', udid: 'u', dir: '/nowhere' },
        { spawn: recorder(false).spawn, exec: async () => xml, now: () => 0 }
      )
      expect(await sampler.stop!()).deep.equals([])
    })
  })
})

/** Fakes for every piece `soakParts` reaches outside this process. */
function partsRig(): {
  ctx: E2eContext
  deps: SoakPartsDeps
  log: string[]
  dir: string
  tv: SoakSurfaceDriver
} {
  const dir = mkdtempSync(join(tmpdir(), 'soak-parts-'))
  const log: string[] = []
  const cdp = {
    send: async (method: string) => {
      log.push(`cdp ${method}`)
      return {}
    }
  }
  const chrome = fakeDevice()
  const ctx = {
    artifact: (name: string) => join(dir, name),
    device: (role: string) => `id-${role}`,
    browser: async () => ({
      m: chrome.device,
      page: {
        evaluate: async () => null,
        createCDPSession: async () => cdp,
        browser: () => ({
          target: () => ({ createCDPSession: async () => cdp })
        })
      },
      close: async () => {
        log.push('browser closed')
      }
    })
  } as unknown as E2eContext
  const world = {
    handle: HANDLE,
    settings: {
      tvRemote: { command: ['r'], env: {} },
      ndiCapture: { command: ['n'] },
      tvJoinSteps: [],
      ffmpeg: '/opt/ffmpeg',
      iosApp: 'a',
      offsetMinutes: -480
    },
    world: {
      gameId: 'g1',
      streams: [{ label: 'Synthetic', id: 's3', videoId: 'v3', key: 'key-s' }],
      accounts: {}
    },
    emails: { owner: 'o@example.test', viewer: 'v@example.test' },
    links: gameLinks(HANDLE.origin, 'g1'),
    stack: { api: HANDLE.api, serverLog: '/log' },
    ownerToken: 'o',
    link: (who: string) => async () => `tok-${who}`,
    close: async () => {
      log.push('world closed')
    }
  } as unknown as StreamingWorld
  const device = (role: string): unknown =>
    awaitable(
      fakeDevice({
        openLink: (arg: unknown) => {
          log.push(`${role} opens ${(arg as { link: string }).link}`)
          return { status: 'passed' }
        }
      }).device
    )
  const tv = { name: 'tv' } as unknown as SoakSurfaceDriver
  const deps: SoakPartsDeps = {
    openWorld: async options => {
      log.push(`world ${options.cwd}`)
      return world
    },
    deviceKit: () => ({
      attachIos: async role => device(role),
      attachSafari: async role => device(role),
      attachAndroid: async role => device(role),
      openIn: (role, platform) => async () => {
        log.push(`open ${role} ${platform}`)
      },
      saveShot: name => name
    }),
    tvKit: () => ({ tv, remote: async () => '' }),
    signInTv: async () => {
      log.push('tv signed in')
      return true
    },
    signInApp: async (_device, _app, link) => {
      log.push(`signed in ${await link()}`)
    },
    recordSessions: async (_world, file) => {
      log.push(`sessions ${file}`)
    }
  }
  return { ctx, deps, log, dir, tv }
}

describe('building the soak parts', function () {
  const schedule = {
    seed: 'seed-1',
    layout: 'compressed'
  } as unknown as SoakSchedule

  it('signs every surface in and gives the run its surfaces, publishers and samplers', async function () {
    const before = process.env.SOAK_TV_MEMORY
    delete process.env.SOAK_TV_MEMORY
    try {
      const r = partsRig()
      const { parts, cleanup } = await soakParts(
        { ctx: r.ctx, schedule, cwd: '/repo' },
        r.deps
      )
      expect(Object.keys(parts.surfaces)).deep.equals([
        'iphone-app',
        'iphone-safari',
        'android',
        'ipad',
        'tv',
        'chrome'
      ])
      expect(parts.surfaces.tv).equals(r.tv)
      expect(parts.surfaces.android.name).equals('android')
      expect(parts.iphone.surface).equals('iphone-app')
      expect(
        Object.values(parts.publishers)
          .map(
            publisher =>
              (
                publisher as unknown as {
                  options: { angle?: string; label?: string }
                }
              ).options
          )
          .map(options => options.angle ?? options.label)
      ).deep.equals(['PhoneA', 'PhoneB', 'Synthetic'])
      expect(parts.samplers.map(sampler => sampler.name)).deep.equals([
        'publisherA-xctrace',
        'iphone-xctrace',
        'ipad-xctrace',
        'tv-xctrace',
        'publisherB-meminfo',
        'android-meminfo',
        'chrome',
        'stack'
      ])
      expect(parts.runDir).equals(join(r.dir, 'soak'))
      expect(parts.provenance).deep.equals({
        stack: 'streamtest-1',
        origin: HANDLE.origin,
        build: process.env.SOAK_BUILD ?? null,
        schedule: { seed: 'seed-1', layout: 'compressed' }
      })
      expect(r.log.filter(line => line.startsWith('signed in'))).deep.equals([
        'signed in tok-owner',
        'signed in tok-owner',
        'signed in tok-viewer',
        'signed in tok-viewer',
        'signed in tok-viewer'
      ])
      expect(r.log).includes(
        'iphone opens https://streamtest.example.test//signin/tok-viewer'
      )
      expect(r.log).includes('tv signed in')
      expect(r.log).includes(`sessions ${join(r.dir, 'sessions.json')}`)
      const urlFile = join(tmpdir(), `soak-rtmp-${process.pid}`)
      expect(readFileSync(urlFile, 'utf8')).equals(
        'rtmp://203.0.113.7:1935/live/key-s'
      )
      await cleanup()
      expect(r.log.slice(-2)).deep.equals(['world closed', 'browser closed'])
      expect(existsSync(urlFile)).equals(false)
    } finally {
      if (before == null) delete process.env.SOAK_TV_MEMORY
      else process.env.SOAK_TV_MEMORY = before
    }
  })

  it('lets go of the world and the browser when a surface will not sign in', async function () {
    const r = partsRig()
    r.deps.signInTv = async () => {
      throw new Error('the TV is still signing in after 8 looks')
    }
    const message = await soakParts(
      { ctx: r.ctx, schedule, cwd: '/repo' },
      r.deps
    ).then(
      () => '',
      (error: unknown) => (error as Error).message
    )
    expect(message).equals('the TV is still signing in after 8 looks')
    expect(r.log.slice(-2)).deep.equals(['browser closed', 'world closed'])
    expect(existsSync(join(tmpdir(), `soak-rtmp-${process.pid}`))).equals(false)
  })

  it("leaves the TV's memory out with SOAK_TV_MEMORY=off, and needs a Synthetic camera", async function () {
    const before = process.env.SOAK_TV_MEMORY
    process.env.SOAK_TV_MEMORY = 'off'
    try {
      const r = partsRig()
      const { parts, cleanup } = await soakParts(
        { ctx: r.ctx, schedule, cwd: '/repo' },
        r.deps
      )
      expect(parts.samplers.map(sampler => sampler.name)).not.includes(
        'tv-xctrace'
      )
      expect(parts.samplers).length(7)
      await cleanup()
      const bare = partsRig()
      const opened = await bare.deps.openWorld({ ctx: bare.ctx, cwd: '/' })
      bare.deps.openWorld = async () => ({
        ...opened,
        world: { ...opened.world, streams: [] }
      })
      expect(
        await soakParts({ ctx: bare.ctx, schedule, cwd: '/' }, bare.deps).then(
          () => '',
          (error: unknown) => (error as Error).message
        )
      ).equals('the soak world has no Synthetic camera')
    } finally {
      if (before == null) delete process.env.SOAK_TV_MEMORY
      else process.env.SOAK_TV_MEMORY = before
    }
  })
})
