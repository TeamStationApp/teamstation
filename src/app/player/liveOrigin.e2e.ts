import { type ChildProcess, execFileSync, spawn } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import {
  appendFile,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  writeFile
} from 'node:fs/promises'
import { createRequire } from 'node:module'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { basename, join, resolve } from 'node:path'
import { parseArgs } from 'node:util'

import { createLiveHarness } from '../../../e2e/rigs/liveHarness'
import type { OriginRequest } from '../../../e2e/rigs/liveOriginRequests'
import { createEmailCode } from '../../server/auth/emailCodes'
import { startFakeSpace } from '../../server/dev/fakeSpace'
import { presignGetUrl } from '../../server/media/presign'
import { listSpaceObjects } from '../../server/media/spacesVideo'
import { signInTestAccount } from '../../test/passwordFixtures'
import { scratchDatabase } from '../../test/scoreboardKit'
import { originPhone } from './liveOriginPhone.e2e'

/**
 * Two API processes with separate media roots, one ingest, and a real HTTP
 * Space. Run from this checkout after building the native crypto module:
 *
 * MAESTRO_D=<own daemon> MAESTRO_D_CLIENT_ROOT=<client package> \
 * TS_E2E_ARTIFACT_DIR=<artifacts> node -r sucrase/register \
 * src/app/player/liveOrigin.e2e.ts [--before --server-root <base checkout>]
 *
 * The web build must point at TS_ORIGIN_VIEWER_PORT (default 9101), served
 * at TS_SCORING_TEST_URL (default http://127.0.0.1:9180). Every database and
 * server directory belongs to this run. Tokens and stream keys stay private.
 * For browser runs, set TS_ORIGIN_SPACE_PORT to the port allowed in the web
 * build's TS_MEDIA_ORIGINS, so its normal media CSP permits the fake Space.
 */
export async function until(
  what: string,
  check: () => boolean | Promise<boolean>,
  timeout = 60_000
): Promise<void> {
  const deadline = Date.now() + timeout
  while (!(await check())) {
    if (Date.now() >= deadline) throw new Error(`Timed out: ${what}`)
    await pause(200)
  }
}
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

export async function runOrigin(options: {
  before?: boolean
  serverRoot?: string
  device?: string
  contractOnly?: boolean
  outage?: boolean
}): Promise<void> {
  const root = resolve(options.serverRoot ?? '.')
  const slug = options.device ?? 'chrome'
  if (!['chrome', 'iphone-safari', 'iphone-app'].includes(slug))
    throw new Error('Unsupported device scenario')
  const artifacts = process.env.TS_E2E_ARTIFACT_DIR
  if (artifacts == null) throw new Error('TS_E2E_ARTIFACT_DIR is required')
  await mkdir(artifacts, { recursive: true })
  const scratch = await mkdtemp(join(tmpdir(), 'tsLiveOrigin-'))
  const database = await scratchDatabase('liveorigin')
  const children: ChildProcess[] = []
  const logs = new Map<string, string>()
  const host = process.env.TS_ORIGIN_HOST ?? '127.0.0.1'
  const viewerPort = Number(process.env.TS_ORIGIN_VIEWER_PORT ?? 9101)
  const writerPort = await freePort()
  const livePort = await freePort()
  const app = process.env.TS_SCORING_TEST_URL ?? `http://${host}:9180`
  const writer = `http://${host}:${writerPort}/api/v1`
  const viewer = `http://${host}:${viewerPort}/api/v1`
  const secret = randomBytes(32).toString('hex')
  const space = {
    endpoint: '',
    region: 'test',
    bucket: 'liveorigin',
    accessKeyId: 'example',
    secretAccessKey: randomBytes(32).toString('hex'),
    pathStyle: true
  }
  const store = await startFakeSpace({
    space,
    dir: join(scratch, 'space'),
    host: '0.0.0.0',
    port: Number(process.env.TS_ORIGIN_SPACE_PORT ?? 0),
    log: join(scratch, 'space.log')
  })
  space.endpoint = store.url.replace('0.0.0.0', host)
  const mediaReads: OriginRequest[] = []
  store.server.on('request', (request, response) => {
    if (
      request.method === 'GET' &&
      request.headers.range !== 'bytes=0-0' &&
      request.url?.split('?')[0].endsWith('.m4s') === true
    ) {
      const entry = {
        at: Date.now(),
        method: request.method,
        path: request.url.split('?')[0],
        address: request.socket.remoteAddress ?? '',
        agent: request.headers['user-agent'] ?? ''
      }
      response.once('finish', () =>
        mediaReads.push({ ...entry, status: response.statusCode })
      )
    }
  })
  const viewerTrace = join(scratch, 'viewer-requests.jsonl')
  let daemon: any
  let page: any
  let phone: Awaited<ReturnType<typeof originPhone>> | undefined
  let token = ''
  const start = (name: string, entry: string, cwd: string): ChildProcess => {
    const child = spawn(
      process.execPath,
      [
        '-r',
        join(root, 'node_modules/sucrase/register'),
        ...(name === 'viewer'
          ? ['-r', join(__dirname, 'liveOriginRequests.e2e.ts')]
          : []),
        join(root, entry)
      ],
      {
        cwd,
        env: {
          ...process.env,
          NODE_ENV: 'test',
          ...(name === 'viewer' ? { TS_ORIGIN_REQUEST_TRACE: viewerTrace } : {})
        },
        stdio: ['ignore', 'pipe', 'pipe']
      }
    )
    children.push(child)
    logs.set(name, '')
    for (const stream of [child.stdout, child.stderr])
      stream.on('data', bytes =>
        logs.set(name, logs.get(name)! + String(bytes))
      )
    return child
  }
  try {
    for (const [node, port] of [
      ['writer', writerPort],
      ['viewer', viewerPort]
    ] as const) {
      const dir = join(scratch, node)
      await mkdir(join(dir, 'work'), { recursive: true })
      await mkdir(join(dir, 'media'), { recursive: true })
      await writeFile(
        join(dir, 'serverConfig.json'),
        JSON.stringify({
          databaseUrl: database.url,
          listenHost: '0.0.0.0',
          listenPort: port,
          primaryUrlOverride: `${host}:${port}`,
          clusterWorkers: 1,
          statsBuilder: false,
          sessionSecret: secret,
          mediaSecret: secret,
          workDir: join(dir, 'work'),
          mediaDir: join(dir, 'media'),
          uploadsDir: join(dir, 'uploads'),
          ffmpegPath: process.env.TS_ORIGIN_FFMPEG ?? 'ffmpeg',
          serveMediaLocally: true,
          corsOrigins: [app],
          sentry: { dsn: '' },
          logRequests: true,
          space,
          live: {
            enabled: node === 'writer',
            bindHost: '127.0.0.1',
            port: livePort,
            healthPort: 0,
            freeDiskFloorGb: 0
          }
        })
      )
      start(node, 'src/server/index.ts', dir)
    }
    start('ingest', 'src/server/ingest/main.ts', join(scratch, 'writer'))
    await until(
      'both API nodes listening and ingest ready',
      () =>
        ['writer', 'viewer'].every(name =>
          logs.get(name)!.includes('listening on')
        ) && logs.get('ingest')!.includes('ingest health on')
    )
    if (options.outage === true) {
      const suite = spawn(
        process.execPath,
        [
          join(root, 'node_modules/mocha/bin/mocha.js'),
          '-r',
          join(root, 'node_modules/sucrase/register'),
          '--timeout',
          '1800000',
          '--exit',
          join(root, 'src/app/player/liveOutage.e2e.ts')
        ],
        {
          cwd: join(scratch, 'writer'),
          env: {
            ...process.env,
            TS_API_TEST_URL: writer,
            TS_E2E_SERVER_ROOT: root,
            TS_SCORING_TEST_URL: app
          },
          stdio: 'inherit'
        }
      )
      const code = await new Promise<number | null>(resolve =>
        suite.once('exit', resolve)
      )
      if (code !== 0) throw new Error(`Outage regression exited ${code}`)
      return
    }
    const helper = createLiveHarness({
      api: writer,
      app,
      serverRoot: root,
      configDir: join(scratch, 'writer'),
      token: () => token,
      live: { port: livePort, app: 'live' },
      daemon: () => daemon
    })
    const stamp = Date.now().toString(36)
    const admin = {
      email: `origin.admin.${stamp}@example.test`,
      password: randomBytes(18).toString('base64url')
    }
    const watcher = {
      email: `origin.viewer.${stamp}@example.test`,
      password: randomBytes(18).toString('base64url')
    }
    helper.dev('seed', admin.email, admin.password)
    const seeded = helper.dev('scoringGame', watcher.email, watcher.password)
    const gameId = /^GAME_ID=(.+)$/m.exec(seeded)?.[1]
    if (gameId == null) throw new Error('No fixture game')
    token = await signInTestAccount(writer, admin)
    if (options.contractOnly !== true && slug !== 'chrome') {
      const login = await createEmailCode(database.db, watcher.email, 'login', {
        origin: slug === 'iphone-app' ? 'ios' : 'web'
      })
      phone = await originPhone({
        slug: slug as 'iphone-safari' | 'iphone-app',
        app,
        signInToken: login.token,
        artifacts,
        diagnostics: scratch
      })
    }
    const camera = await helper.camera(gameId, 'Live origin')
    const show = helper.broadcast(camera.url, [
      '--duration',
      phone == null ? '75' : '120',
      '--size',
      '1280x720',
      '--ffmpeg',
      process.env.TS_E2E_FFMPEG ?? 'ffmpeg'
    ])
    const t0 = await show.t0
    await pause(Math.max(0, t0 + 10_000 - Date.now()))
    const playback = async (): Promise<{
      url?: string
      unavailable: boolean
    }> =>
      (await (
        await fetch(`${viewer}/videos/${camera.videoId}/playback`, {
          headers: { authorization: `Bearer ${token}` }
        })
      ).json()) as { url?: string; unavailable: boolean }
    if (options.before === true) {
      if (!(await playback()).unavailable)
        throw new Error('Expected base viewer to lack the live files')
    } else {
      await until('viewer playback from Space', async () => {
        const found = await playback()
        return typeof found.url === 'string' && !found.unavailable
      })
      const url = (await playback()).url!
      if (!url.includes('/hls/index.m3u8?'))
        throw new Error('Live URL is not the event playlist')
      const body = await (await fetch(url)).text()
      const segment = body
        .split('\n')
        .find(line => line.startsWith('http') && line.includes('.m4s'))
      if (segment == null || !(await fetch(segment)).ok)
        throw new Error('No readable published segment')
    }
    if (phone != null) {
      await phone.open(gameId, camera.videoId, t0)
      await phone.sample()
    } else if (options.contractOnly !== true) {
      const name = process.env.MAESTRO_D
      if (name == null) throw new Error('MAESTRO_D is required')
      execFileSync(process.env.MAESTRO_D_BIN ?? 'maestro-d', ['ps'], {
        stdio: 'ignore'
      })
      const client = createRequire(
        join(process.env.MAESTRO_D_CLIENT_ROOT!, 'package.json')
      )('maestro-d')
      daemon = await client.MaestroD.connect({ name })
      const viewerToken = await signInTestAccount(viewer, watcher)
      const viewerHelper = createLiveHarness({
        api: viewer,
        app,
        token: () => viewerToken,
        live: { port: livePort, app: 'live' },
        daemon: () => daemon
      })
      page = await viewerHelper.browser('origin')
      await page.openBrowser({
        url: `${app}/games/${gameId}?video=${camera.videoId}`
      })
      if (options.before === true) {
        await pause(20_000)
        await writeFile(
          join(artifacts, 'live-viewer-node-before.png'),
          await page.screenshot()
        )
      } else {
        await until('live picture', async () => {
          await page.evalBrowserScript({
            script: 'return !!document.querySelector("video")?.videoWidth',
            output: 'ready'
          })
          return (await page.vars()).ready === 'true'
        })
        await page.evalBrowserScript({
          script: 'return document.querySelector("video").paused',
          output: 'paused'
        })
        if ((await page.vars()).paused === 'true')
          await page.tapOn({ id: 'gameVideoZones' })
        await page.evalBrowserScript({
          script: `const stream = document.querySelector('video').captureStream();
            window.originChunks = [];
            window.originRecorder = new MediaRecorder(stream);
            window.originRecorder.ondataavailable = e => window.originChunks.push(e.data);
            window.originRecorder.start(1000);`
        })
        await writeFile(
          join(artifacts, 'live-viewer-node-after.png'),
          await page.screenshot()
        )
        const samples: Array<{ elapsed: number; position: number }> = []
        const samplingStarted = Date.now()
        for (let i = 0; i < 7; i++) {
          if (i !== 0) await pause(5000)
          await page.evalBrowserScript({
            script: 'return document.querySelector("video").currentTime',
            output: 'position'
          })
          const position = Number((await page.vars()).position)
          if (!Number.isFinite(position))
            throw new Error('No Chrome playback position')
          samples.push({
            elapsed: (Date.now() - samplingStarted) / 1000,
            position
          })
        }
        await appendFile(
          join(artifacts, 'device-pass.log'),
          '$ node -r sucrase/register src/app/player/liveOrigin.e2e.ts --device chrome\n' +
            JSON.stringify(samples) +
            '\n'
        )
        if (samples.at(-1)!.position - samples[0].position < 25)
          throw new Error('Chrome playback did not advance for 25 seconds')
      }
    }
    if ((await show.done) !== 0) throw new Error('Broadcaster failed')
    const ended = await helper.ask(
      `/games/${gameId}/live-streams/${camera.streamId}/end`,
      { method: 'POST' }
    )
    if (ended.status !== 200) throw new Error(`End answered ${ended.status}`)
    await until(
      'verified recording',
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
    const keys = await listSpaceObjects(space, `videos/${camera.videoId}/`)
    if (options.before === true) {
      if (!keys.some(key => key.endsWith('/video.mp4')))
        throw new Error('Base did not remux')
      await writeFile(
        join(artifacts, 'finish-space-before.log'),
        '$ node -r sucrase/register src/app/player/liveOrigin.e2e.ts --before --server-root <base-checkout>\nObjects after finishing the base stream:\n' +
          keys.join('\n') +
          '\n'
      )
    } else {
      const body = await (
        await fetch(
          presignGetUrl({
            ...space,
            key: `videos/${camera.videoId}/index.m3u8`,
            expiresSec: 300
          })
        )
      ).text()
      if (
        !body.includes('#EXT-X-ENDLIST') ||
        keys.some(key => key.endsWith('/video.mp4'))
      )
        throw new Error('Recording is not the closed fragment playlist')
      if (page != null) {
        await until('player ended', async () => {
          await page.evalBrowserScript({
            script: 'return !!document.querySelector("video")?.ended',
            output: 'ended'
          })
          return (await page.vars()).ended === 'true'
        })
        await writeFile(
          join(artifacts, 'ended-chrome.png'),
          await page.screenshot()
        )
        await page.evalBrowserScript({
          script: `const save = () => {
              const reader = new FileReader();
              reader.onload = () => { window.originRecording = reader.result.split(',')[1]; };
              reader.readAsDataURL(new Blob(window.originChunks));
            };
            window.originRecorder.onstop = save;
            if (window.originRecorder.state === 'inactive') save();
            else window.originRecorder.stop();`
        })
        await until('browser recording exported', async () => {
          await page.evalBrowserScript({
            script: 'return window.originRecording ?? ""',
            output: 'recording'
          })
          return (await page.vars()).recording !== ''
        })
        const recording = join(scratch, 'chrome.webm')
        await writeFile(
          recording,
          Buffer.from((await page.vars()).recording, 'base64')
        )
        execFileSync(
          process.env.TS_E2E_FFMPEG ?? 'ffmpeg',
          [
            '-y',
            '-i',
            recording,
            '-c:v',
            'libx264',
            '-pix_fmt',
            'yuv420p',
            join(artifacts, 'live-chrome.mp4')
          ],
          { stdio: 'ignore' }
        )
      }
      if (phone != null) {
        const row = await database.db
          .selectFrom('videos')
          .select('duration_sec')
          .where('id', '=', camera.videoId)
          .executeTakeFirstOrThrow()
        await phone.ended(row.duration_sec ?? 0)
      }
    }
    const viewerFiles = await readdir(
      join(scratch, 'viewer/media/work/videos')
    ).catch(() => [])
    if (viewerFiles.length !== 0)
      throw new Error('Viewer unexpectedly has local video')
    if (options.before !== true && options.contractOnly !== true) {
      const viewerRequests: OriginRequest[] = (
        await readFile(viewerTrace, 'utf8')
      )
        .trim()
        .split('\n')
        .filter(Boolean)
        .map(line => JSON.parse(line))
      const isPlayer = (request: OriginRequest): boolean =>
        /Mozilla\/|AppleCoreMedia\/|CoreMedia\/|CFNetwork\//.test(request.agent)
      const players = viewerRequests.filter(
        request =>
          isPlayer(request) &&
          request.method === 'GET' &&
          request.status === 200 &&
          request.path === `/api/v1/videos/${camera.videoId}/hls/index.m3u8`
      )
      if (players.length === 0)
        throw new Error('No player playlist request at viewer node')
      const matches = (request: OriginRequest): boolean =>
        players.some(
          player =>
            player.address === request.address && player.agent === request.agent
        )
      const reads = mediaReads.filter(
        request =>
          matches(request) && request.status >= 200 && request.status < 300
      )
      if (reads.length < 3)
        throw new Error('No sustained player-matched reads from the Space')
      const localReads = viewerRequests.filter(
        request => matches(request) && request.path.startsWith('/media/')
      )
      if (localReads.length !== 0)
        throw new Error('Player requested ingest-local media')
      await appendFile(
        join(artifacts, 'device-pass.log'),
        `$ node -r sucrase/register src/app/player/liveOrigin.e2e.ts --device ${slug}\n` +
          reads
            .map(request =>
              JSON.stringify({
                method: request.method,
                object: basename(request.path),
                status: request.status,
                viewerAddressMatched: true,
                playerAgentMatched: true
              })
            )
            .join('\n') +
          '\n' +
          `PASS: live playback reached the recording end; ${reads.length} player-matched media-fragment reads from the Space; zero matching viewer /media requests; viewer media root empty; closed fragment recording retained without video.mp4. Addresses, agents and signed queries are omitted from public evidence.\n`
      )
    }
    console.log(
      `PASS: ${options.before === true ? 'base cannot play live; finishes as video.mp4' : 'viewer plays and closes Space fragments'}; viewer media root empty`
    )
  } finally {
    // A disconnected driver must not strand the API children or scratch DB.
    const closed = await Promise.allSettled([
      phone?.close(),
      page?.detach(),
      daemon?.close()
    ])
    for (const result of closed)
      if (result.status === 'rejected')
        console.error('Viewer cleanup failed:', result.reason)
    for (const child of children) child.kill('SIGTERM')
    await Promise.all(
      children.map(async child => {
        if (child.exitCode != null) return
        const kill = setTimeout(() => child.kill('SIGKILL'), 12_000)
        await new Promise(resolve => child.once('exit', resolve))
        clearTimeout(kill)
      })
    )
    store.server.close()
    // Private diagnostic logs contain ephemeral keys; never upload them.
    for (const [name, body] of logs)
      await writeFile(join(scratch, `${name}.log`), body)
    console.log(`Private diagnostics: ${scratch}`)
    await database.drop()
  }
}

if (require.main === module) {
  const { values } = parseArgs({
    options: {
      before: { type: 'boolean' },
      'server-root': { type: 'string' },
      device: { type: 'string', default: 'chrome' },
      'contract-only': { type: 'boolean' },
      outage: { type: 'boolean' }
    }
  })
  runOrigin({
    before: values.before,
    serverRoot: values['server-root'],
    device: values.device,
    contractOnly: values['contract-only'],
    outage: values.outage
  }).catch((error: unknown) => {
    console.error(error)
    process.exitCode = 1
  })
}
