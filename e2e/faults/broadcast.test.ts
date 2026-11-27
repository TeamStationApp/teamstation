import { EventEmitter } from 'node:events'
import { join } from 'node:path'
import { PassThrough } from 'node:stream'

import { expect } from 'chai'
import { describe, it } from 'mocha'

import { liveVideoDir } from '../../src/server/live/controller'
import {
  broadcastActions,
  type BroadcastChild,
  type BroadcastDeps,
  broadcasterArgs,
  BROADCASTERS
} from './broadcast'
import { RemuxError } from './remux'

const URL = 'rtmp://e2e.example.test:1936/live/key-1.a'

class FakeChild extends EventEmitter implements BroadcastChild {
  stdout = new PassThrough()
  stderr = new PassThrough()
  killed: Array<string | undefined> = []
  kill(signal?: NodeJS.Signals): boolean {
    this.killed.push(signal)
    this.end(143)
    return true
  }

  print(event: Record<string, unknown>): void {
    this.stdout.write(`${JSON.stringify({ at: 1, ...event })}\n`)
  }

  end(code: number | null): void {
    setImmediate(() => this.emit('exit', code))
  }
}

function fake(
  options: { live?: Record<string, unknown>; mediaDir?: string } = {}
): {
  deps: BroadcastDeps
  children: FakeChild[]
  spawned: Array<[string, string[], { cwd: string }]>
} {
  const children: FakeChild[] = []
  const spawned: Array<[string, string[], { cwd: string }]> = []
  let n = 0
  const deps: BroadcastDeps = {
    checkout: '/srv/e2e/app',
    config: () => ({
      ffmpegPath: '/opt/ffmpeg/bin/ffmpeg',
      ...(options.mediaDir === undefined
        ? { mediaDir: '/srv/e2e/media' }
        : options.mediaDir === ''
          ? {}
          : { mediaDir: options.mediaDir }),
      live: options.live ?? { enabled: true, port: 1936 }
    }),
    spawn: (file, args, spawnOptions) => {
      spawned.push([file, args, spawnOptions])
      const child = new FakeChild()
      children.push(child)
      return child
    },
    readDir: async dir => {
      if (dir.endsWith('/vid_empty')) throw new Error('ENOENT')
      return ['seg-2.m4s', '.writer-init.mp4', 'master.m3u8', 'seg-1.m4s']
    },
    readText: async file => {
      if (file.includes('vid_nomaster')) throw new Error('ENOENT')
      return `#EXTM3U\n# ${file}\n`
    },
    makeId: () => `bc${++n}`,
    plannedMs: 200
  }
  return { deps, children, spawned }
}

async function refused(
  work: Promise<unknown>
): Promise<{ status: number; message: string }> {
  try {
    await work
  } catch (error) {
    expect(error).instanceOf(RemuxError)
    return {
      status: (error as RemuxError).status,
      message: (error as Error).message
    }
  }
  throw new Error('expected a refusal')
}

describe('the fake broadcaster’s command line', function () {
  it('publishes into the stack’s own ingest with the camera’s app and key', function () {
    expect(
      broadcasterArgs(
        {
          url: URL,
          duration: 180,
          stamped: true,
          sound: true,
          outages: [{ at: 60, seconds: 20 }],
          stalls: [{ at: 70, seconds: 10 }],
          jumps: [{ at: 40, seconds: 34 }],
          lead: 0,
          size: '640x360',
          fps: 25
        },
        1936,
        'ffmpeg'
      )
    ).deep.equals([
      BROADCASTERS.scoreboard,
      '--url',
      'rtmp://127.0.0.1:1936/live/key-1.a',
      '--duration',
      '180',
      '--ffmpeg',
      'ffmpeg',
      '--outage',
      '60:20',
      '--stall',
      '70:10',
      '--jump',
      '40:34',
      '--lead',
      '0',
      '--size',
      '640x360',
      '--fps',
      '25',
      '--stamped',
      '--sound'
    ])
    expect(
      broadcasterArgs(
        { url: URL, script: 'outage', duration: 150, stamped: false },
        1936,
        'ffmpeg'
      ).slice(0, 5)
    ).deep.equals([
      BROADCASTERS.outage,
      '--url',
      'rtmp://127.0.0.1:1936/live/key-1.a',
      '--duration',
      '150'
    ])
  })

  it('refuses what the broadcaster cannot follow', function () {
    const cases: Array<[Record<string, unknown>, string]> = [
      [{ url: URL, duration: 1, script: 'other' }, 'script is'],
      [{ duration: 1 }, 'url is'],
      [{ url: 'http://x/live/k', duration: 1 }, 'url is'],
      [{ url: URL }, 'duration is'],
      [{ url: URL, duration: 4000 }, 'duration is'],
      [{ url: URL, duration: 9, outages: 'x' }, 'outages is a list'],
      [{ url: URL, duration: 9, outages: [{ at: 1 }] }, 'outages.seconds'],
      [{ url: URL, duration: 9, stalls: [null] }, 'stalls.at'],
      [{ url: URL, duration: 9, lead: -1 }, 'lead is'],
      [{ url: URL, duration: 9, size: '1280' }, 'size is'],
      [{ url: URL, duration: 9, fps: 1.5 }, 'fps is'],
      [{ url: URL, duration: 9, sound: 'yes' }, 'sound is'],
      [
        { url: URL, duration: 9, script: 'outage', stamped: true },
        'stamped is the scoreboard'
      ],
      [
        { url: URL, duration: 9, script: 'outage', jumps: [] },
        'jumps is the scoreboard'
      ]
    ]
    for (const [body, message] of cases) {
      expect(() => broadcasterArgs(body, 1936, 'ffmpeg')).throws(
        RemuxError,
        message
      )
    }
  })
})

describe('the broadcast actions', function () {
  it('answers once planned, keeps every event, and its exit', async function () {
    const f = fake()
    const actions = broadcastActions(f.deps)
    const started = actions.broadcast({ url: URL, duration: 30 })
    await new Promise(resolve => setImmediate(resolve))
    const child = f.children[0]
    child.print({ event: 'planned', t0: 5000 })
    child.stdout.write('not json\n')
    const made = (await started) as Record<string, any>
    expect(made.id).equals('bc1')
    expect(made.t0).equals(5000)
    expect(made.exit).equals(null)
    expect(f.spawned[0][0]).equals(process.execPath)
    expect(f.spawned[0][1][0]).equals(BROADCASTERS.scoreboard)
    expect(f.spawned[0][1]).includes('/opt/ffmpeg/bin/ffmpeg')
    expect(f.spawned[0][2]).deep.equals({ cwd: '/srv/e2e/app' })

    child.print({ event: 'publish', fromSec: 0 })
    child.print({ event: 'done', failed: false })
    child.end(0)
    await new Promise(resolve => setTimeout(resolve, 10))
    const status = (await actions['broadcast-status']({ id: 'bc1' })) as any
    expect(status.exit).equals(0)
    expect(status.events.map((one: any) => one.event)).deep.equals([
      'planned',
      'output',
      'publish',
      'done'
    ])
    expect(status.events[1].line).equals('not json')
    child.stderr.write('a warning\n')
    await new Promise(resolve => setImmediate(resolve))
    expect(
      ((await actions['broadcast-status']({ id: 'bc1' })) as any).stderr
    ).deep.equals(['a warning'])
    // A stop after the end changes nothing.
    expect(
      ((await actions['broadcast-stop']({ id: 'bc1' })) as any).exit
    ).equals(0)
    expect(child.killed).deep.equals([])
  })

  it('stops a broadcast that is still publishing', async function () {
    const f = fake()
    const actions = broadcastActions(f.deps)
    const started = actions.broadcast({ url: URL, duration: 30 })
    await new Promise(resolve => setImmediate(resolve))
    f.children[0].print({ event: 'planned', t0: 1 })
    await started
    const stopped = (await actions['broadcast-stop']({ id: 'bc1' })) as any
    expect(f.children[0].killed).deep.equals(['SIGTERM'])
    expect(stopped.exit).equals(143)
  })

  it('names a broadcaster that ends or plans nothing', async function () {
    const f = fake()
    const actions = broadcastActions(f.deps)
    const ended = actions.broadcast({ url: URL, duration: 30 })
    await new Promise(resolve => setImmediate(resolve))
    f.children[0].stderr.write('no ffmpeg\n')
    await new Promise(resolve => setImmediate(resolve))
    f.children[0].emit('exit', null)
    const why = await refused(ended)
    expect(why.status).equals(502)
    expect(why.message).contains('exited 1').and.contains('no ffmpeg')
    expect(
      (await refused(actions['broadcast-status']({ id: 'bc1' }))).status
    ).equals(404)

    const silent = actions.broadcast({ url: URL, duration: 30 })
    const late = await refused(silent)
    expect(late.message).contains('planned nothing in time')
    expect(f.children[1].killed).deep.equals(['SIGTERM'])
  })

  it('refuses an unknown id, and a stack with no live port', async function () {
    const actions = broadcastActions(fake().deps)
    expect((await refused(actions['broadcast-status']({}))).status).equals(400)
    expect(
      (await refused(actions['broadcast-stop']({ id: 'nope' }))).status
    ).equals(404)
    const none = broadcastActions(fake({ live: { enabled: true } }).deps)
    expect(
      (await refused(none.broadcast({ url: URL, duration: 9 }))).status
    ).equals(501)
  })

  it('lists the ingest’s own live directory, dotfiles included', async function () {
    const actions = broadcastActions(
      fake({ live: { port: 1936, localTailSec: 60 } }).deps
    )
    const files = (await actions['ingest-files']({ videoId: 'vid_1' })) as any
    expect(files.names).deep.equals([
      '.writer-init.mp4',
      'master.m3u8',
      'seg-1.m4s',
      'seg-2.m4s'
    ])
    expect(files.master).contains(
      join(liveVideoDir('/srv/e2e/media', 'vid_1'), 'master.m3u8')
    )
    expect(files.live).deep.equals({ port: 1936, localTailSec: 60 })
    const empty = (await actions['ingest-files']({
      videoId: 'vid_empty'
    })) as any
    expect(empty.names).deep.equals([])
    const nomaster = (await actions['ingest-files']({
      videoId: 'vid_nomaster'
    })) as any
    expect(nomaster.master).equals('')
    expect(
      (await refused(actions['ingest-files']({ videoId: '../x' }))).status
    ).equals(400)
    const unset = broadcastActions(fake({ mediaDir: '' }).deps)
    expect(
      (await refused(unset['ingest-files']({ videoId: 'vid_1' }))).status
    ).equals(501)
  })
})
