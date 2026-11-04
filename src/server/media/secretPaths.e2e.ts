import { type ChildProcess, execFile, spawn } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:net'
import { homedir, tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { promisify } from 'node:util'

import { expect } from 'chai'
import { after, before, describe, it } from 'mocha'

import { createLiveHarness } from '../../app/player/liveHarness.e2e'
import { signInTestAccount } from '../../test/passwordFixtures'
import { scratchDatabase } from '../../test/scoreboardKit'
import { startFakeSpace } from '../dev/fakeSpace'
import { remuxToHls } from './ffmpeg'
import { putObjectFile } from './images'
import { contentTypeFor, listSpaceObjects } from './spacesVideo'
import { oldVideoPrefix, videoPrefix } from './videoPrefix'

/**
 * E2E-3: existing videos move to their secret paths, new media is under one,
 * public and unsigned, and playlists stay private. (The web player half of
 * E2E-3, playing in a browser with no CSP violation, is `liveOrigin.e2e.ts`.)
 *
 *   node src/migrate/requirePostgres18.js && npx mocha --timeout 900000 \
 *     --exit -r sucrase/register --extension ts \
 *     --spec src/server/media/secretPaths.e2e.ts
 *
 * Needs the Postgres 18 cluster, Redis, `curl` and `ffmpeg` with libx265 on
 * PATH. The API and the ingest run as processes from a temporary directory
 * with their own `serverConfig.json`, a scratch database, free ports and an
 * in-process fake Space, with `space.mediaBaseUrl` its bucket base,
 * `http://127.0.0.1:<port>/<bucket>`.
 *
 * Before anything of the branch writes, two videos are seeded on their old
 * path, `videos/<id>/`, private, as the base build left them: a finished
 * recording (put there by the base checkout's own `importVideoFile.ts` when
 * `TS_SECRET_E2E_BASE` names a base checkout with its `node_modules`, and
 * otherwise by the same remux and private upload), and a live origin
 * recording, its pieces beside a still.
 *
 * `TS_E2E_ARTIFACT_DIR` gets `secret-paths.log`, every command with its `$`
 * line. `TS_SECRET_E2E_PUBLISH_SEC` is how long the new game publishes (30).
 */
const PUBLISH_SEC = Number(process.env.TS_SECRET_E2E_PUBLISH_SEC ?? 30)
const SEGMENT_SEC = 4
const run = promisify(execFile)
const pause = async (ms: number): Promise<void> => {
  await new Promise(resolve => setTimeout(resolve, ms))
}

async function freePort(): Promise<number> {
  const server = createServer()
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const port = (server.address() as { port: number }).port
  await new Promise<void>(resolve =>
    server.close(() => {
      resolve()
    })
  )
  return port
}

async function until(
  what: string,
  check: () => boolean | Promise<boolean>,
  timeoutMs = 60_000
): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!(await check())) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`)
    await pause(250)
  }
}

interface Proc {
  child: ChildProcess
  output: () => string
  gone: () => boolean
  exited: Promise<number | null>
}

function track(child: ChildProcess): Proc {
  let text = ''
  child.stdout?.on('data', chunk => (text += String(chunk)))
  child.stderr?.on('data', chunk => (text += String(chunk)))
  let gone = false
  const exited = new Promise<number | null>(resolve =>
    child.on('exit', code => {
      gone = true
      resolve(code)
    })
  )
  return { child, output: () => text, gone: () => gone, exited }
}

async function stop(proc: Proc): Promise<void> {
  if (proc.gone()) return
  proc.child.kill('SIGTERM')
  const late = setTimeout(() => proc.child.kill('SIGKILL'), 20_000)
  await proc.exited
  clearTimeout(late)
}

/** Every media URI of a playlist, maps included. */
function mediaUris(body: string): string[] {
  return body
    .split('\n')
    .flatMap(line =>
      line.startsWith('#EXT-X-MAP:')
        ? [/URI="([^"]+)"/.exec(line)?.[1] ?? '']
        : line === '' || line.startsWith('#')
          ? []
          : [line]
    )
}

describe('E2E-3: unsigned media under the secret path (M5)', function () {
  this.timeout(900_000)
  const root = resolve('.')
  const register = require.resolve('sucrase/register')
  const base =
    process.env.TS_SECRET_E2E_BASE ??
    join(homedir(), 'git-worktrees/teamstation_streamingBase')
  const procs: Proc[] = []
  const transcript: string[] = []
  let scratch = ''
  let database: Awaited<ReturnType<typeof scratchDatabase>>
  let store: Awaited<ReturnType<typeof startFakeSpace>>
  let space: {
    endpoint: string
    region: string
    bucket: string
    accessKeyId: string
    secretAccessKey: string
    pathStyle: boolean
    mediaBaseUrl: string
  }
  let api = ''
  let livePort = 0
  let token = ''
  let sample = ''
  let gameId = ''
  let helper: ReturnType<typeof createLiveHarness>
  let configPath = ''

  /** A command run for the log: its `$` line, then what it printed. */
  const logged = async (
    shown: string,
    file: string,
    args: string[],
    cwd = root
  ): Promise<string> => {
    const { stdout, stderr } = await run(file, args, {
      cwd,
      maxBuffer: 1 << 24
    })
    const out = (stdout + stderr).trimEnd()
    transcript.push(`$ ${shown}`, out, '')
    return out
  }
  const note = (line: string): void => {
    transcript.push(line, '')
  }
  /** A `curl` with no credentials, by its status. */
  const curl = async (url: string, range = false): Promise<string> =>
    await logged(
      `curl -s -o /dev/null -w '%{http_code}\\n'${range ? " -H 'Range: bytes=0-99'" : ''} '${url}'`,
      'curl',
      [
        '-s',
        '-o',
        '/dev/null',
        '-w',
        '%{http_code}\n',
        ...(range ? ['-H', 'Range: bytes=0-99'] : []),
        url
      ]
    )
  const secretOf = async (id: string): Promise<string | null> =>
    (
      await database.db
        .selectFrom('videos')
        .select('space_secret')
        .where('id', '=', id)
        .executeTakeFirstOrThrow()
    ).space_secret
  /** The media playlist `/playback` leads to, as a player gets it. */
  const served = async (videoId: string): Promise<string> => {
    const playback = (await helper.ask(`/videos/${videoId}/playback`)).json as {
      url: string | null
    }
    if (playback.url == null) return ''
    let body = await (await fetch(playback.url)).text()
    if (!body.includes('#EXTINF')) {
      const variant = body
        .split('\n')
        .find(line => line !== '' && !line.startsWith('#'))
      if (variant == null) return ''
      body = await (await fetch(new URL(variant, playback.url))).text()
    }
    return body
  }
  /** Every media URI plain, on mediaBaseUrl, under the row's secret path. */
  const expectUnsigned = (
    body: string,
    videoId: string,
    secret: string
  ): string[] => {
    const uris = mediaUris(body)
    expect(uris.length).greaterThan(0)
    const prefix = `${space.mediaBaseUrl}/${videoPrefix({ id: videoId, spaceSecret: secret })}`
    for (const uri of uris) {
      expect(uri, uri).not.contains('?')
      expect(uri.startsWith(prefix), uri).equals(true)
      expect(uri).matches(/-[0-9a-f]{32}\//)
    }
    return uris
  }

  const start = (entry: string, cwd: string): Proc => {
    const proc = track(
      spawn(process.execPath, ['-r', register, join(root, entry)], {
        cwd,
        env: { ...process.env, NODE_ENV: 'test' },
        stdio: ['ignore', 'pipe', 'pipe']
      })
    )
    procs.push(proc)
    return proc
  }

  before(async function () {
    scratch = await mkdtemp(join(tmpdir(), 'tsSecretPathsE2e-'))
    database = await scratchDatabase('secretpaths')
    space = {
      endpoint: '',
      region: 'test',
      bucket: 'secretpaths',
      accessKeyId: 'example',
      secretAccessKey: randomBytes(32).toString('hex'),
      pathStyle: true,
      mediaBaseUrl: ''
    }
    store = await startFakeSpace({
      space,
      dir: join(scratch, 'space'),
      log: join(scratch, 'space-requests.log')
    })
    space.endpoint = store.url
    space.mediaBaseUrl = `${store.url}/${space.bucket}`
    const apiPort = await freePort()
    livePort = await freePort()
    api = `http://127.0.0.1:${apiPort}/api/v1`
    const secret = randomBytes(32).toString('hex')
    const mediaRoot = join(scratch, 'shared', 'media')
    for (const name of ['api', 'ingest']) {
      const dir = join(scratch, name)
      await mkdir(dir, { recursive: true })
      await writeFile(
        join(dir, 'serverConfig.json'),
        JSON.stringify({
          databaseUrl: database.url,
          listenHost: '127.0.0.1',
          listenPort: apiPort,
          primaryUrlOverride: `127.0.0.1:${apiPort}`,
          clusterWorkers: 1,
          statsBuilder: false,
          sessionSecret: secret,
          mediaSecret: secret,
          workDir: join(scratch, 'shared', 'work'),
          mediaDir: mediaRoot,
          uploadsDir: join(dir, 'uploads'),
          ffmpegPath: 'ffmpeg',
          serveMediaLocally: true,
          sentry: { dsn: '' },
          logRequests: false,
          space,
          live: {
            enabled: true,
            bindHost: '127.0.0.1',
            port: livePort,
            healthPort: 0,
            freeDiskFloorGb: 0,
            segmentSeconds: SEGMENT_SEC
          }
        })
      )
    }
    configPath = join(scratch, 'api', 'serverConfig.json')
    await mkdir(join(scratch, 'shared', 'work'), { recursive: true })
    await mkdir(mediaRoot, { recursive: true })
    const apiProc = start('src/server/index.ts', join(scratch, 'api'))
    const ingest = start('src/server/ingest/main.ts', join(scratch, 'ingest'))
    await until('the API and the ingest', () => {
      for (const proc of procs)
        if (proc.gone()) throw new Error(`a process exited:\n${proc.output()}`)
      return (
        apiProc.output().includes('listening on') &&
        ingest.output().includes('ingest health on')
      )
    })
    // Thirty seconds of 720p HEVC with sound, a keyframe every 2 s.
    sample = join(scratch, 'sample.mp4')
    await run(
      'ffmpeg',
      [
        '-hide_banner',
        '-loglevel',
        'error',
        '-f',
        'lavfi',
        '-i',
        'testsrc2=size=1280x720:rate=30',
        '-f',
        'lavfi',
        '-i',
        'sine=frequency=440:sample_rate=48000',
        '-t',
        '30',
        '-c:v',
        'libx265',
        '-preset',
        'ultrafast',
        '-x265-params',
        'log-level=none:keyint=60:min-keyint=60:scenecut=0',
        '-tag:v',
        'hvc1',
        '-c:a',
        'aac',
        sample
      ],
      { maxBuffer: 1 << 22 }
    )
    helper = createLiveHarness({
      api,
      app: 'http://127.0.0.1:1',
      serverRoot: root,
      configDir: join(scratch, 'api'),
      token: () => token,
      live: { port: livePort, app: 'live' },
      daemon: () => undefined
    })
    const admin = {
      email: 'secret.admin@example.test',
      password: randomBytes(18).toString('base64url')
    }
    const watcher = {
      email: 'secret.viewer@example.test',
      password: randomBytes(18).toString('base64url')
    }
    helper.dev('seed', admin.email, admin.password)
    const seeded = helper.dev('scoringGame', watcher.email, watcher.password)
    const found = /^GAME_ID=(.+)$/m.exec(seeded)?.[1]
    if (found == null) throw new Error('No fixture game')
    gameId = found
    token = await signInTestAccount(api, admin)
  })

  after(async function () {
    const artifacts = process.env.TS_E2E_ARTIFACT_DIR
    if (artifacts != null && transcript.length > 0) {
      await mkdir(artifacts, { recursive: true })
      await writeFile(
        join(artifacts, 'secret-paths.log'),
        transcript.join('\n') + '\n'
      )
    }
    for (const proc of procs.reverse()) await stop(proc)
    await new Promise<void>(resolve =>
      store?.server.close(() => {
        resolve()
      })
    )
    await database?.drop()
    if (scratch !== '') await rm(scratch, { recursive: true, force: true })
  })

  /** A finished recording on its old path, as the base build left one. */
  const seedFinished = async (): Promise<string> => {
    const importer = join(base, 'src/server/dev/importVideoFile.ts')
    if (existsSync(importer) && existsSync(join(base, 'node_modules'))) {
      const work = join(scratch, 'base-import')
      await mkdir(work, { recursive: true })
      await writeFile(
        join(work, 'serverConfig.json'),
        JSON.stringify({
          databaseUrl: database.url,
          space: { ...space, mediaBaseUrl: undefined },
          ffmpegPath: 'ffmpeg'
        })
      )
      const out = await logged(
        `node -r sucrase/register <base checkout>/src/server/dev/importVideoFile.ts --file sample.mp4 --game ${gameId} --title 'Seeded finished'`,
        process.execPath,
        [
          '-r',
          join(base, 'node_modules/sucrase/register'),
          importer,
          '--file',
          sample,
          '--game',
          gameId,
          '--title',
          'Seeded finished',
          '--start',
          new Date().toISOString()
        ],
        work
      )
      const id = /imported as (vid_\S+)/.exec(out)?.[1]
      if (id == null) throw new Error(`base import said: ${out}`)
      return id
    }
    note(
      '# no base checkout: the finished recording is remuxed and put on its old path here'
    )
    const id = `vid_seedfinished${randomBytes(2).toString('hex')}`
    const dir = join(scratch, 'seed-finished')
    await remuxToHls('ffmpeg', { input: sample, outDir: dir })
    for (const name of ['master.m3u8', 'video.m3u8', 'video.mp4'])
      await putObjectFile({
        space,
        key: `${oldVideoPrefix(id)}${name}`,
        path: join(dir, name),
        contentType: contentTypeFor(name)
      })
    await database.db
      .insertInto('videos')
      .values({
        id,
        game_id: gameId,
        kind: 'program',
        title: 'Seeded finished',
        storage: 'spaces',
        status: 'ready',
        hidden: false,
        duration_sec: 30,
        spaces_verified_at: new Date()
      })
      .execute()
    return id
  }

  /** A closed live origin recording on its old path, with a still beside it. */
  const seedOrigin = async (): Promise<string> => {
    const id = `vid_seedorigin${randomBytes(2).toString('hex')}`
    const dir = join(scratch, 'seed-origin')
    await mkdir(dir, { recursive: true })
    await run('ffmpeg', [
      '-v',
      'error',
      '-i',
      sample,
      '-c',
      'copy',
      '-f',
      'hls',
      '-hls_time',
      String(SEGMENT_SEC),
      '-hls_playlist_type',
      'vod',
      '-hls_segment_type',
      'fmp4',
      '-hls_segment_filename',
      join(dir, 'seg%06d.m4s'),
      join(dir, 'index.m3u8')
    ])
    await writeFile(
      join(dir, 'master.m3u8'),
      '#EXTM3U\n#EXT-X-VERSION:7\n#EXT-X-STREAM-INF:BANDWIDTH=2000000\nindex.m3u8\n'
    )
    await writeFile(join(dir, 'still.jpg'), 'a still')
    for (const name of (await readdir(dir)).sort())
      await putObjectFile({
        space,
        key:
          name === 'still.jpg'
            ? `${oldVideoPrefix(id)}stills/10.jpg`
            : `${oldVideoPrefix(id)}${name}`,
        path: join(dir, name),
        contentType: contentTypeFor(name)
      })
    await database.db
      .insertInto('videos')
      .values({
        id,
        game_id: gameId,
        kind: 'live',
        title: 'Seeded origin',
        storage: 'spaces',
        status: 'ready',
        hidden: false,
        duration_sec: 30,
        spaces_verified_at: new Date()
      })
      .execute()
    return id
  }

  it('moves the videos already on their old paths, and both play unsigned', async function () {
    const finished = await seedFinished()
    const origin = await seedOrigin()
    const before = {
      finished: await listSpaceObjects(space, oldVideoPrefix(finished)),
      origin: await listSpaceObjects(space, oldVideoPrefix(origin))
    }
    expect(await secretOf(finished)).equals(null)
    expect(await secretOf(origin)).equals(null)
    note(
      `# seeded on their old paths: ${finished} (${before.finished.length} objects), ${origin} (${before.origin.length} objects)`
    )

    const move = async (dryRun: boolean): Promise<string> =>
      await logged(
        `node -r sucrase/register src/server/dev/moveVideosToSecretPaths.ts${dryRun ? ' --dry-run' : ''} --config <scratch>/api/serverConfig.json`,
        process.execPath,
        [
          '-r',
          register,
          'src/server/dev/moveVideosToSecretPaths.ts',
          ...(dryRun ? ['--dry-run'] : []),
          '--config',
          configPath
        ]
      )
    const dry = await move(true)
    expect(dry).contains(`would move ${finished}`)
    expect(dry).contains(`would move ${origin}`)
    expect(await secretOf(finished)).equals(null)
    expect(await listSpaceObjects(space, oldVideoPrefix(finished))).deep.equals(
      before.finished
    )
    expect(await listSpaceObjects(space, oldVideoPrefix(origin))).deep.equals(
      before.origin
    )

    const moved = await move(false)
    expect(moved).contains(`moved ${finished}`)
    expect(moved).contains(`moved ${origin}`)
    for (const id of [finished, origin]) {
      const secret = await secretOf(id)
      expect(secret).matches(/^[0-9a-f]{32}$/)
      const uris = expectUnsigned(await served(id), id, secret!)
      const status = await curl(uris.at(-1)!, true)
      expect(['200', '206']).includes(status)
    }
    expect(await listSpaceObjects(space, oldVideoPrefix(finished))).deep.equals(
      []
    )
    expect(await listSpaceObjects(space, oldVideoPrefix(origin))).deep.equals([
      `${oldVideoPrefix(origin)}stills/10.jpg`
    ])
    await logged(
      'node -r sucrase/register src/server/dev/moveVideosToSecretPaths.ts --config <scratch>/api/serverConfig.json',
      process.execPath,
      [
        '-r',
        register,
        'src/server/dev/moveVideosToSecretPaths.ts',
        '--config',
        configPath
      ]
    ).then(again => expect(again).contains('0 moved, 0 finished'))
  })

  it('publishes a new game unsigned under its secret path, keeps its playlists private, and deletes both prefixes', async function () {
    const camera = await helper.camera(gameId, 'Secret')
    const secret = await secretOf(camera.videoId)
    expect(secret).matches(/^[0-9a-f]{32}$/)
    note(
      `# a new camera's video ${camera.videoId}, its secret made with its key`
    )
    const publisher = track(
      spawn(
        'ffmpeg',
        [
          '-hide_banner',
          '-loglevel',
          'error',
          '-re',
          '-stream_loop',
          '-1',
          '-i',
          sample,
          '-t',
          String(PUBLISH_SEC),
          '-c',
          'copy',
          '-f',
          'flv',
          camera.url
        ],
        { stdio: ['ignore', 'pipe', 'pipe'] }
      )
    )
    procs.push(publisher)
    let live = ''
    await until(
      'the live playlist to list pieces',
      async () => {
        live = await served(camera.videoId)
        return mediaUris(live).length >= 3
      },
      120_000
    )
    const uris = expectUnsigned(live, camera.videoId, secret!)
    const piece = uris.find(uri => uri.endsWith('.m4s'))!
    expect(await curl(piece)).equals('200')
    const prefix = videoPrefix({ id: camera.videoId, spaceSecret: secret })
    expect(await curl(`${space.mediaBaseUrl}/${prefix}index.m3u8`)).equals(
      '403'
    )
    expect(
      await listSpaceObjects(space, oldVideoPrefix(camera.videoId)),
      'nothing on the old path'
    ).deep.equals([])

    await publisher.exited
    const ended = await helper.ask(
      `/games/${gameId}/live-streams/${camera.streamId}/end`,
      { method: 'POST' }
    )
    expect(ended.status).equals(200)
    await until(
      'the recording to be verified in the Space',
      async () =>
        (
          await database.db
            .selectFrom('videos')
            .select('spaces_verified_at')
            .where('id', '=', camera.videoId)
            .executeTakeFirst()
        )?.spaces_verified_at != null,
      120_000
    )
    const closed = await served(camera.videoId)
    expect(closed).contains('#EXT-X-ENDLIST')
    expectUnsigned(closed, camera.videoId, secret!)

    const deleted = await logged(
      `curl -s -X DELETE -H 'authorization: Bearer <token>' '${api}/videos/${camera.videoId}'`,
      'curl',
      [
        '-s',
        '-X',
        'DELETE',
        '-H',
        `authorization: Bearer ${token}`,
        `${api}/videos/${camera.videoId}`
      ]
    )
    expect(deleted).contains('"removedFromSpace"')
    const left = [
      ...(await listSpaceObjects(space, prefix)),
      ...(await listSpaceObjects(space, oldVideoPrefix(camera.videoId)))
    ]
    note(
      `# listed in the fake Space: ${prefix} and ${oldVideoPrefix(camera.videoId)}: ${left.length} objects`
    )
    expect(left).deep.equals([])
    expect(await curl(piece)).equals('403')
  })
})
