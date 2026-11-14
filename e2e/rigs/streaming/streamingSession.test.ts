import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { expect } from 'chai'
import { describe, it } from 'mocha'
import type { Client } from 'pg'

import { BlockedError } from '../../core/result'
import type { E2eContext } from '../../core/spec'
import type { StreamingHandle } from '../../core/streamingStack'
import type { SoakFixtureManifest } from './soakFixture'
import type { SignInStack } from './soakSignIn'
import {
  DEVELOP_APP,
  deviceKit,
  localSoak,
  openWorld,
  recordSessions,
  REVOKE_SESSIONS,
  signInTv,
  type SoakSettings,
  TV_APP,
  tvKit,
  type WorldDeps
} from './streamingSession'
import { awaitable, fakeDevice, fixture, png } from './surfaces/fakes.test'

const HANDLE: StreamingHandle = {
  version: 1,
  id: 'streamtest-1',
  origin: 'https://streamtest.example.test/',
  api: 'https://streamtest.example.test/api/v1',
  ssh: 'stack@203.0.113.7',
  serverLog: '/example/api.log',
  hlsRoot: '/example/hls',
  databaseUrl: 'postgres://u:p@db.example.test/ts?sslmode=require',
  rtmp: 'rtmp://203.0.113.7:1935',
  serverConfig: { sessionSecret: 's', live: { rtmpPort: 1935 } }
}

const SETTINGS: SoakSettings = {
  tvRemote: { command: ['python3', 'remote.py'], env: { TEAM: 't' } },
  ndiCapture: { command: ['ndi', '--out', '{out}'] },
  tvJoinSteps: ['select'],
  ffmpeg: '/opt/ffmpeg',
  iosApp: '/b/TeamStation Develop.app'
}

const MANIFEST = {
  gameId: 'g1',
  streams: [],
  accounts: {
    owner: { email: 'owner@example.test', userId: 'u-owner' },
    viewer: { email: 'viewer@example.test', userId: 'u-viewer' }
  }
} as unknown as SoakFixtureManifest

function context(attached: unknown = HANDLE): {
  ctx: E2eContext
  dir: string
  attached: Array<[string, Record<string, unknown>]>
} {
  const dir = mkdtempSync(join(tmpdir(), 'streaming-session-'))
  const attachedCalls: Array<[string, Record<string, unknown>]> = []
  const ctx = {
    stack: { attached },
    artifact: (name: string) => join(dir, name),
    device: (role: string) => `id-${role}`,
    attach: async (role: string, options: Record<string, unknown>) => {
      attachedCalls.push([role, options])
      return awaitable(fakeDevice().device)
    }
  } as unknown as E2eContext
  return { ctx, dir, attached: attachedCalls }
}

/** A database that records each statement and answers with `rows`. */
function database(rows: unknown[] = []): {
  onDatabase: WorldDeps['onDatabase']
  queries: string[]
} {
  const queries: string[] = []
  return {
    queries,
    onDatabase: async (handle, work) => {
      expect(handle.id).equals('streamtest-1')
      await work({
        query: async (sql: string) => {
          queries.push(sql)
          return { rows }
        }
      } as unknown as Client)
    }
  }
}

function worldDeps(overrides: Partial<WorldDeps> = {}): {
  deps: WorldDeps
  queries: string[]
  seeded: unknown[]
  signedIn: string[]
  stopped: string[]
} {
  const { onDatabase, queries } = database()
  const seeded: unknown[] = []
  const signedIn: string[] = []
  const stopped: string[] = []
  const deps: WorldDeps = {
    runOnStack: async options => {
      seeded.push(options)
      return MANIFEST
    },
    mirror: (_handle, dir) => ({
      apiLog: join(dir, 'api.log'),
      stop: async () => {
        stopped.push(dir)
      }
    }),
    onDatabase,
    sessionToken: async (_stack, email) => {
      signedIn.push(`session ${email}`)
      return 'owner-token'
    },
    signInToken: async (_stack, email) => {
      signedIn.push(`link ${email}`)
      return `tok-${email}`
    },
    mailbox: () => 'bench@example.test',
    settings: () => SETTINGS,
    sleep: async () => {},
    ...overrides
  }
  return { deps, queries, seeded, signedIn, stopped }
}

async function rejection(promise: Promise<unknown>): Promise<Error> {
  return await promise.then(
    () => {
      throw new Error('expected a rejection')
    },
    (error: unknown) => error as Error
  )
}

describe('opening a streaming world', function () {
  it('seeds labelled cameras, ends old sessions, signs the owner in and hands out links', async function () {
    const { ctx, dir } = context()
    const { deps, queries, seeded, signedIn, stopped } = worldDeps()
    const world = await openWorld(
      { ctx, cwd: '/repo', synthetic: ['SynthA', 'SynthB'] },
      deps
    )
    const seed = seeded[0] as {
      cwd: string
      script: string
      args: string[]
      config: unknown
    }
    expect(seed.cwd).equals('/repo')
    expect(seed.script).equals('e2e/rigs/streaming/soakFixture.ts')
    expect(seed.args).deep.equals([
      '--json',
      '--mailbox',
      'bench@example.test',
      '--synthetic',
      'SynthA,SynthB'
    ])
    expect(seed.config).deep.equals({
      sessionSecret: 's',
      live: { rtmpPort: 1935 }
    })
    expect(world.emails).deep.equals({
      owner: 'owner@example.test',
      viewer: 'viewer@example.test'
    })
    expect(world.links.web).equals(
      'https://streamtest.example.test/games/g1?tab=watch'
    )
    expect(world.ownerToken).equals('owner-token')
    expect(world.stack.serverLog).equals(join(dir, 'mirror', 'api.log'))
    expect(queries).deep.equals([REVOKE_SESSIONS])
    await world.stack.resetLimits!()
    expect(queries[1]).contains('delete from rate_events')
    expect(await world.link('viewer')()).equals('tok-viewer@example.test')
    expect(signedIn).deep.equals([
      'session owner@example.test',
      'link viewer@example.test'
    ])
    await world.close()
    expect(stopped).deep.equals([join(dir, 'mirror')])
  })

  it("seeds the soak's own world when no cameras are named", async function () {
    const { ctx } = context()
    const { deps, seeded } = worldDeps()
    await openWorld({ ctx, cwd: '/repo' }, deps)
    expect((seeded[0] as { args: string[] }).args).deep.equals([
      '--json',
      '--mailbox',
      'bench@example.test'
    ])
  })

  it('blocks without an attached stack or a mailbox', async function () {
    const bare = context(null)
    expect(
      await rejection(openWorld({ ctx: bare.ctx, cwd: '/' }, worldDeps().deps))
    ).instanceOf(BlockedError)
    const { ctx } = context()
    const noMail = await rejection(
      openWorld({ ctx, cwd: '/' }, worldDeps({ mailbox: () => undefined }).deps)
    )
    expect(noMail).instanceOf(BlockedError)
    expect(noMail.message).equals('local settings name no mailbox')
  })
})

describe('the local soak settings', function () {
  it('reads the soak block from the local settings file, or nothing', function () {
    const before = process.env.E2E_LOCAL_SETTINGS
    const { dir } = context()
    const file = join(dir, 'local.json')
    writeFileSync(file, JSON.stringify({ soak: { ffmpeg: 'f' } }))
    try {
      process.env.E2E_LOCAL_SETTINGS = file
      expect(localSoak()).deep.equals({ ffmpeg: 'f' })
      process.env.E2E_LOCAL_SETTINGS = join(dir, 'missing.json')
      expect(localSoak()).equals(undefined)
    } finally {
      if (before == null) delete process.env.E2E_LOCAL_SETTINGS
      else process.env.E2E_LOCAL_SETTINGS = before
    }
  })
})

describe('the device kit', function () {
  it('attaches the develop app on iOS and Android', async function () {
    const { ctx, attached } = context()
    const kit = deviceKit(ctx, SETTINGS, {
      run: async () => undefined,
      write: () => {},
      log: () => {},
      settleMs: 0
    })
    await kit.attachIos('iphone')
    await kit.attachAndroid('android')
    expect(attached).deep.equals([
      [
        'iphone',
        {
          platform: 'ios',
          appId: DEVELOP_APP,
          appFile: '/b/TeamStation Develop.app'
        }
      ],
      ['android', { platform: 'android', appId: DEVELOP_APP }]
    ])
  })

  it('hands a link to the develop app alone on each platform, and saves screenshots', async function () {
    const { ctx, dir } = context()
    const ran: Array<[string, string[]]> = []
    const written: Array<[string, Uint8Array]> = []
    const kit = deviceKit(ctx, SETTINGS, {
      run: async (command, args) => {
        ran.push([command, args])
      },
      write: (file, data) => {
        written.push([file, data])
      },
      log: () => {},
      settleMs: 0
    })
    await kit.openIn('iphone', 'ios')('teamstation://games/g1')
    await kit.openIn('android', 'android')('teamstation://games/g1')
    expect(ran).deep.equals([
      [
        'xcrun',
        [
          'devicectl',
          'device',
          'process',
          'launch',
          '--device',
          'id-iphone',
          '--payload-url',
          'teamstation://games/g1',
          DEVELOP_APP
        ]
      ],
      [
        'adb',
        [
          '-s',
          'id-android',
          'shell',
          `am start -W -a android.intent.action.VIEW -d 'teamstation://games/g1' ${DEVELOP_APP}`
        ]
      ]
    ])
    const shot = png(2, 2)
    expect(kit.saveShot('join-iphone.png', shot)).equals('join-iphone.png')
    expect(written).deep.equals([[join(dir, 'join-iphone.png'), shot]])
  })

  it('attaches a device again when its driver dies, and says so', async function () {
    const { dir } = context()
    let attaches = 0
    let fails = 1
    const ctx = {
      artifact: (name: string) => join(dir, name),
      device: (role: string) => `id-${role}`,
      attach: async () => {
        attaches++
        return awaitable(
          fakeDevice({
            state: () => {
              if (fails-- > 0) throw new Error('read: connection reset by peer')
              return { foregroundApp: DEVELOP_APP }
            }
          }).device
        )
      }
    } as unknown as E2eContext
    const lines: string[] = []
    const kit = deviceKit(ctx, SETTINGS, {
      run: async () => undefined,
      write: () => {},
      log: line => {
        lines.push(line)
      },
      settleMs: 0
    })
    const device = await kit.attachIos('iphone')
    expect(await device.state()).deep.equals({ foregroundApp: DEVELOP_APP })
    expect(attaches).equals(2)
    expect(lines).deep.equals(['iphone: driver lost in state; attached again'])
    const recovery = JSON.parse(
      readFileSync(join(dir, 'recoveries.jsonl'), 'utf8')
    ) as { role: string; call: string }
    expect([recovery.role, recovery.call]).deep.equals(['iphone', 'state'])
  })
})

describe("the TV's kit", function () {
  it('drives the remote with the TV named, and captures its picture over NDI', async function () {
    const { ctx, dir } = context()
    const calls: Array<{
      command: string
      args: string[]
      env?: Record<string, string | undefined>
    }> = []
    const { tv, remote } = tvKit(
      ctx,
      SETTINGS,
      async (command, args, options) => {
        calls.push({ command, args, env: options.env })
        if (command === 'ndi') {
          writeFileSync(args[1], png(1920, 1080))
          return { stdout: '' }
        }
        return { stdout: fixture('tvDump.txt') }
      }
    )
    expect(await remote(['dump'])).equals(fixture('tvDump.txt'))
    expect(calls[0].command).equals('python3')
    expect(calls[0].args).deep.equals(['remote.py', 'dump'])
    expect(calls[0].env).includes({ TEAM: 't', TV_DEVICE_UDID: 'id-tv' })
    const probe = await tv.probe()
    expect(probe.tiles).not.equals(null)
    expect(
      calls.filter(call => call.command === 'ndi').map(call => call.args)
    ).deep.equals([
      ['--out', join(dir, 'tv-ndi.png')],
      ['--out', join(dir, 'tv-ndi.png')]
    ])
  })
})

describe('signing the TV in', function () {
  function stack(approved: string[]): SignInStack {
    return {
      api: 'https://streamtest.example.test/api/v1',
      serverLog: '/example/api.log',
      fetch: (async (url: string, init: RequestInit) => {
        approved.push(`${url} ${init.body as string}`)
        return new Response(null, { status: 204 })
      }) as unknown as typeof fetch
    }
  }

  it('waits past the brand screen, approves the code the TV shows as the owner, and sees it signed in', async function () {
    const approved: string[] = []
    const asked: string[][] = []
    const screens = [
      'Other, identifier: tv-brand-screen',
      'Other, identifier: tv-login-panel; StaticText, label: TV login code ABCD–EFGH',
      'Other, identifier: tv-page-home'
    ]
    const shown = await signInTv(
      async steps => {
        asked.push(steps)
        return screens.shift() ?? ''
      },
      { stack: stack(approved), ownerToken: 'owner-token' }
    )
    expect(shown).equals(true)
    expect(asked).deep.equals([
      [`app:${TV_APP}`, 'wait:4', 'dump'],
      [`app:${TV_APP}`, 'wait:5', 'dump'],
      [`app:${TV_APP}`, 'wait:5', 'dump']
    ])
    expect(approved).deep.equals([
      'https://streamtest.example.test/api/v1/auth/tv/approve {"code":"abcdefgh"}'
    ])
  })

  it('approves nothing when the TV is signed in already', async function () {
    const approved: string[] = []
    expect(
      await signInTv(async () => 'Other, identifier: tv-page-player', {
        stack: stack(approved),
        ownerToken: 'owner-token'
      })
    ).equals(false)
    expect(approved).deep.equals([])
  })

  it('throws when the TV never gets past signing in', async function () {
    let looks = 0
    const failed = await signInTv(
      async () => {
        looks++
        return looks % 2 === 0 ? '' : 'Other, identifier: tv-brand-screen'
      },
      { stack: stack([]), ownerToken: 'owner-token' },
      3
    ).catch((error: unknown) => error)
    expect((failed as Error).message).equals(
      'the TV is still signing in after 3 looks'
    )
    expect(looks).equals(3)
  })
})

describe('recording the live sessions', function () {
  it('names the account each live session holds', async function () {
    const { dir } = context()
    const file = join(dir, 'sessions.json')
    const { onDatabase, queries } = database([
      {
        user_id: 'u-viewer',
        device_name: 'iPhone',
        user_agent: 'ua',
        created_at: 't1'
      },
      {
        user_id: 'u-owner',
        device_name: 'Apple TV',
        user_agent: 'tv',
        created_at: 't2'
      },
      { user_id: 'u-x', device_name: null, user_agent: null, created_at: 't3' }
    ])
    await recordSessions({ handle: HANDLE, world: MANIFEST }, file, onDatabase)
    expect(queries[0]).contains('from auth_sessions where revoked_at is null')
    expect(JSON.parse(readFileSync(file, 'utf8'))).deep.equals([
      { account: 'viewer', device: 'iPhone', userAgent: 'ua', createdAt: 't1' },
      {
        account: 'owner',
        device: 'Apple TV',
        userAgent: 'tv',
        createdAt: 't2'
      },
      { account: 'other', device: null, userAgent: null, createdAt: 't3' }
    ])
  })
})
