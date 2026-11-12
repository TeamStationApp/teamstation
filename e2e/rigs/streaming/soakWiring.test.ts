import { EventEmitter } from 'node:events'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { expect } from 'chai'

import { BlockedError } from '../../core/result'
import type { StreamingHandle } from '../../core/streamingStack'
import {
  gameLinks,
  rtmpUrl,
  soakServerConfig,
  soakSettings,
  xctraceSampler
} from './soakWiring'
import { fixture } from './surfaces/fakes.test'

const HANDLE: StreamingHandle = {
  version: 1,
  id: 'streamtest-1',
  origin: 'https://streamtest.example.test/',
  api: 'https://streamtest.example.test/api/v1',
  ssh: 'stack@203.0.113.7',
  serverLog: '/srv/api.log',
  hlsRoot: '/srv/hls',
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
      expect(r.kills).deep.equals(['SIGINT'])
      expect(exported[0][0]).equals('xcrun')
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

    it('says when the recording ended before the run did', async function () {
      const dir = join(mkdtempSync(join(tmpdir(), 'soak-xc-')), 'traces')
      const r = recorder(true)
      const sampler = xctraceSampler(
        { name: 'tv', udid: 'udid-2', dir },
        { spawn: r.spawn, exec: async () => xml, now: () => 0 }
      )
      await sampler.start!()
      await new Promise(resolve => setImmediate(resolve))
      expect(
        await sampler.stop!().catch((e: unknown) => (e as Error).message)
      ).equals('tv: the Activity Monitor recording ended early (1)')
      expect(r.kills).deep.equals([])
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
