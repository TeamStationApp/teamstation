import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { expect } from 'chai'
import { after, describe, it } from 'mocha'

import type { StackDatabase } from './database'
import { PagesStandIn } from './pages'
import {
  probeArgs,
  programmeArgs,
  remuxActions,
  type RemuxDeps,
  RemuxError,
  stackRemux,
  stackServerConfig,
  takeArgs
} from './remux'
import { startFaultServer } from './server'

const TOKEN = 'a'.repeat(64)
const SPACE = {
  endpoint: 'https://space.example.test',
  region: 'r',
  bucket: 'stack-bucket',
  accessKey: 'k',
  secretKey: 's'
} as any

interface Fake {
  deps: RemuxDeps
  ran: Array<[string, string[], { cwd?: string }]>
  queries: Array<[string, unknown[]]>
  puts: Array<{ key: string; contentType: string; body: string }>
  remuxed: unknown[]
  served: Array<[string, string, string]>
}

function fake(
  options: {
    space?: boolean
    database?: boolean
    startAt?: string | null
  } = {}
): Fake {
  const scratch = mkdtempSync(join(tmpdir(), 'e2e-remux-test-'))
  const ran: Fake['ran'] = []
  const queries: Fake['queries'] = []
  const puts: Fake['puts'] = []
  const remuxed: unknown[] = []
  const served: Fake['served'] = []
  const pages = new PagesStandIn()
  const serveFile = pages.serveFile.bind(pages)
  pages.serveFile = (path, file, type) => {
    served.push([path, file, type])
    serveFile(path, file, type)
  }
  const database: StackDatabase = {
    query: async (text, values) => {
      queries.push([text, values])
      if (text.startsWith('SELECT start_at')) {
        return {
          rows:
            options.startAt === null
              ? []
              : [{ start_at: options.startAt ?? '2026-11-26T10:00:00.000Z' }],
          rowCount: 1
        }
      }
      return { rows: [], rowCount: 1 }
    },
    close: async () => undefined
  }
  const deps: RemuxDeps = {
    checkout: '/srv/e2e/app',
    scratch,
    ...(options.database === false ? {} : { database }),
    pages,
    config: () => ({
      ...(options.space === false ? {} : { space: SPACE }),
      ffmpegPath: '/opt/ffmpeg/bin/ffmpeg'
    }),
    run: async (file, args, runOptions) => {
      ran.push([file, args, runOptions])
      // FFmpeg writes its last argument.
      if (file.endsWith('ffmpeg')) writeFileSync(args[args.length - 1], 'mp4!')
      if (file.endsWith('ffprobe')) {
        return {
          stdout: JSON.stringify({
            streams: [{ codec_type: 'video', codec_name: 'h264' }],
            packets: [{ dts_time: '0.000000' }]
          })
        }
      }
      return { stdout: `ran ${args.join(' ')}\n` }
    },
    remux: async (_ffmpeg, remuxOptions) => {
      remuxed.push(remuxOptions)
      for (const name of ['master.m3u8', 'video.m3u8', 'video.mp4']) {
        writeFileSync(join(remuxOptions.outDir, name), name)
      }
    },
    put: (async (put: any) => {
      puts.push({
        key: put.key,
        contentType: put.contentType,
        body: readFileSync(put.path, 'utf8')
      })
    }) as any,
    list: (async (space: any, prefix: string) => {
      expect(space.bucket).equals('stack-bucket')
      return [{ key: `${prefix}a.m4s`, size: 3, etag: 'e' }]
    }) as any,
    machine: () => ({ vcpus: 4, memGiB: 8 }),
    makeId: () => 'abc12345'
  }
  return { deps, ran, queries, puts, remuxed, served }
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

describe('the remux route’s media work', function () {
  it('encodes a programme and serves it on the pages stand-in', async function () {
    const f = fake()
    const made = await remuxActions(f.deps)({
      action: 'programme',
      seconds: 600,
      path: '/seek-1/programme.mp4'
    })
    expect(made).deep.equals({ path: '/seek-1/programme.mp4', bytes: 4 })
    expect(f.ran[0][0]).equals('/opt/ffmpeg/bin/ffmpeg')
    expect(f.ran[0][1]).deep.equals(programmeArgs(600, f.served[0][1]))
    expect(f.ran[0][1]).includes('libx265')
    expect(f.served[0][0]).equals('/seek-1/programme.mp4')
    expect(f.served[0][2]).equals('video/mp4')
  })

  it('makes a single-file recording in the Space, and its row', async function () {
    const f = fake()
    expect(
      await remuxActions(f.deps)({
        action: 'single-file',
        videoId: 'vid_repack1',
        gameId: 'gam_1',
        title: 'Before segments',
        startAt: '2026-11-26T10:00:00.000Z',
        seconds: 600
      })
    ).deep.equals({ videoId: 'vid_repack1' })
    expect(f.remuxed).has.length(1)
    expect((f.remuxed[0] as any).layout).equals('single-file')
    expect(f.puts).deep.equals([
      {
        key: 'videos/vid_repack1/master.m3u8',
        contentType: 'application/vnd.apple.mpegurl',
        body: 'master.m3u8'
      },
      {
        key: 'videos/vid_repack1/video.m3u8',
        contentType: 'application/vnd.apple.mpegurl',
        body: 'video.m3u8'
      },
      {
        key: 'videos/vid_repack1/video.mp4',
        contentType: 'video/mp4',
        body: 'video.mp4'
      }
    ])
    expect(f.queries[0][0]).contains('INSERT INTO videos')
    expect(f.queries[0][1]).deep.equals([
      'vid_repack1',
      'gam_1',
      'Before segments',
      '2026-11-26T10:00:00.000Z',
      600
    ])
  })

  it('runs segmentSpaceVideos in the checkout and answers what it printed', async function () {
    const f = fake()
    expect(
      await remuxActions(f.deps)({
        action: 'segment',
        args: ['--dry-run', '--video', 'vid_1']
      })
    ).deep.equals({
      output:
        'ran lib/server/dev/segmentSpaceVideos.js --dry-run --video vid_1\n'
    })
    expect(f.ran[0][0]).equals(process.execPath)
    expect(f.ran[0][2]).deep.equals({ cwd: '/srv/e2e/app' })
  })

  it('lists the Space under a prefix, and names this machine', async function () {
    const f = fake()
    const act = remuxActions(f.deps)
    expect(
      await act({ action: 'objects', prefix: 'videos/vid_1/' })
    ).deep.equals({ objects: [{ key: 'videos/vid_1/a.m4s', size: 3 }] })
    expect(await act({ action: 'machine' })).deep.equals({
      vcpus: 4,
      memGiB: 8
    })
  })

  it('seeds a play that far into the video’s own clock', async function () {
    const f = fake()
    expect(
      await remuxActions(f.deps)({
        action: 'play',
        gameId: 'gam_1',
        battingTeamId: 'tem_2',
        videoId: 'vid_1',
        secondsIn: 450,
        atBatIndex: 1
      })
    ).deep.equals({ eventId: 'evt_seekabc12345' })
    const [text, values] = f.queries[1]
    expect(text).contains('INSERT INTO events')
    expect(values.slice(0, 4)).deep.equals([
      'evt_seekabc12345',
      'gam_1',
      '2026-11-26T10:07:30.000Z',
      'tem_2'
    ])
    expect(JSON.parse(values[4] as string).about.atBatIndex).equals(1)
    expect(
      await refused(
        remuxActions(fake({ startAt: null }).deps)({
          action: 'play',
          gameId: 'g',
          battingTeamId: 't',
          videoId: 'v',
          secondsIn: 1,
          atBatIndex: 0
        })
      )
    ).deep.equals({ status: 404, message: 'video v has no start' })
  })

  it('refuses a body it cannot follow, and work the stack cannot do', async function () {
    const act = remuxActions(fake().deps)
    for (const body of [
      null,
      [],
      {},
      { action: 'nope' },
      { action: 'programme', seconds: -1, path: '/a' },
      { action: 'programme', seconds: 1, path: 'no-slash' },
      { action: 'single-file', videoId: 'v', gameId: 'g', seconds: 1 },
      {
        action: 'single-file',
        videoId: 'v',
        gameId: 'g',
        title: 't',
        startAt: 'never',
        seconds: 1
      },
      { action: 'segment', args: ['; rm -rf'] },
      { action: 'segment', args: 'x' },
      { action: 'objects', prefix: '' }
    ]) {
      expect((await refused(act(body))).status, JSON.stringify(body)).equals(
        400
      )
    }
    const single = {
      action: 'single-file',
      videoId: 'v',
      gameId: 'g',
      title: 't',
      startAt: '2026-11-26T10:00:00Z',
      seconds: 1
    }
    expect(
      await refused(remuxActions(fake({ space: false }).deps)(single))
    ).deep.equals({ status: 501, message: 'the stack has no Space configured' })
    expect(
      (
        await refused(
          remuxActions(fake({ database: false }).deps)({
            ...single,
            action: 'play',
            battingTeamId: 't',
            videoId: 'v',
            secondsIn: 1,
            atBatIndex: 0
          })
        )
      ).status
    ).equals(501)
  })

  it('makes a take as Director sends one, and reads it with ffprobe', async function () {
    const f = fake()
    const act = remuxActions(f.deps)
    const made = (await act({
      action: 'take',
      seconds: 2,
      path: '/e4-1/take.mp4'
    })) as any
    expect(made).deep.equals({
      path: '/e4-1/take.mp4',
      bytes: 4,
      streams: ['video/h264'],
      firstDts: 0
    })
    const file = f.served[0][1]
    expect(f.ran[0]).deep.equals([
      '/opt/ffmpeg/bin/ffmpeg',
      takeArgs(2, file),
      {}
    ])
    expect(takeArgs(2, file)).includes('libx264').and.includes('-an')
    expect(f.ran[1]).deep.equals([
      '/opt/ffmpeg/bin/ffprobe',
      probeArgs(file),
      {}
    ])
    expect(f.served[0][2]).equals('video/mp4')
    expect(
      (await refused(act({ action: 'take', seconds: 0, path: '/x.mp4' })))
        .status
    ).equals(400)
    // A probe that read nothing answers no streams and no first packet.
    const empty = fake()
    empty.deps.run = async (file, args) => {
      if (file.endsWith('ffmpeg')) writeFileSync(args[args.length - 1], 'x')
      return { stdout: '{}' }
    }
    expect(
      await remuxActions(empty.deps)({
        action: 'take',
        seconds: 1,
        path: '/e4-2/take.mp4'
      })
    ).deep.equals({
      path: '/e4-2/take.mp4',
      bytes: 1,
      streams: [],
      firstDts: null
    })
  })

  it('answers the actions another module adds', async function () {
    const f = fake()
    f.deps.more = { echo: async body => ({ echoed: body }) }
    expect(await remuxActions(f.deps)({ action: 'echo', a: 1 })).deep.equals({
      echoed: { a: 1 }
    })
  })

  it('reads the stack’s own server config for its Space and FFmpeg', async function () {
    const checkout = mkdtempSync(join(tmpdir(), 'e2e-remux-checkout-'))
    after(function () {
      rmSync(checkout, { recursive: true, force: true })
    })
    writeFileSync(
      join(checkout, 'serverConfig.json'),
      JSON.stringify({ mediaDir: '/srv/e2e/media' })
    )
    expect(stackServerConfig(checkout)).deep.equals({
      mediaDir: '/srv/e2e/media'
    })
    const act = stackRemux(checkout, undefined, new PagesStandIn(), {
      extra: async () => ({ extra: true })
    })
    expect(await act({ action: 'extra' })).deep.equals({ extra: true })
    expect((await act({ action: 'machine' })) as any).to.have.keys(
      'vcpus',
      'memGiB'
    )
    expect(
      await refused(act({ action: 'objects', prefix: 'videos/' }))
    ).deep.equals({ status: 501, message: 'the stack has no Space configured' })
  })
})

describe('the fault server’s remux route', function () {
  it('answers each action, its refusals by status, and 501 with no media work', async function () {
    const f = fake()
    const started = await startFaultServer({
      listen: { host: '127.0.0.1', port: 0 },
      target: 'http://127.0.0.1:1',
      token: TOKEN,
      remux: pages => {
        expect(pages).instanceOf(PagesStandIn)
        return remuxActions(f.deps)
      }
    })
    const bare = await startFaultServer({
      listen: { host: '127.0.0.1', port: 0 },
      target: 'http://127.0.0.1:1',
      token: TOKEN
    })
    const post = async (base: string, body: unknown): Promise<any> => {
      const reply = await fetch(`${base}/__e2e/remux`, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${TOKEN}`,
          'content-type': 'application/json'
        },
        body: typeof body === 'string' ? body : JSON.stringify(body)
      })
      return { status: reply.status, body: await reply.json() }
    }
    try {
      expect(await post(started.proxy.url, { action: 'machine' })).deep.equals({
        status: 200,
        body: { vcpus: 4, memGiB: 8 }
      })
      expect((await post(started.proxy.url, { action: 'nope' })).status).equals(
        400
      )
      expect((await post(started.proxy.url, 'not json')).status).equals(400)
      f.deps.machine = () => {
        throw new Error('no such machine')
      }
      expect(await post(started.proxy.url, { action: 'machine' })).deep.equals({
        status: 500,
        body: { error: 'no such machine' }
      })
      expect((await post(bare.proxy.url, { action: 'machine' })).status).equals(
        501
      )
    } finally {
      await started.close()
      await bare.close()
    }
  })
})

describe('the pages stand-in serving a file the stack made', function () {
  it('answers GET with the file and HEAD with its size', async function () {
    const dir = mkdtempSync(join(tmpdir(), 'e2e-pages-file-'))
    const file = join(dir, 'programme.mp4')
    writeFileSync(file, 'twelve bytes')
    const started = await startFaultServer({
      listen: { host: '127.0.0.1', port: 0 },
      target: 'http://127.0.0.1:1',
      token: TOKEN
    })
    try {
      started.pages.serveFile('/p/programme.mp4', file, 'video/mp4')
      const url = `${started.proxy.url}/p/programme.mp4`
      const headers = { 'x-e2e-site': 'pages' }
      const got = await fetch(url, { headers })
      expect(got.headers.get('content-type')).equals('video/mp4')
      expect(await got.text()).equals('twelve bytes')
      const head = await fetch(url, { method: 'HEAD', headers })
      expect(head.status).equals(200)
      expect(head.headers.get('content-length')).equals('12')
    } finally {
      await started.close()
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
