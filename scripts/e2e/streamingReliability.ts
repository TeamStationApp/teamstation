/**
 * Local ingest retention soak. No production configuration is read.
 * TS_E2E_ARTIFACT_DIR=<private output> node -r sucrase/register
 * scripts/e2e/streamingReliability.ts --surface web --case retention
 * Optional --seconds shortens the three-publisher stage for a smoke run.
 */
import assert from 'node:assert/strict'
import { type ChildProcess, spawn } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { parseArgs } from 'node:util'

import { createLiveHarness } from '../../src/app/player/liveHarness.e2e'
import { startFakeSpace } from '../../src/server/dev/fakeSpace'
import { signInTestAccount } from '../../src/test/passwordFixtures'
import { scratchDatabase } from '../../src/test/scoreboardKit'

const sleep = async (ms: number): Promise<void> => {
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

async function stop(child: ChildProcess): Promise<void> {
  if (child.exitCode != null || child.signalCode != null) return
  const done = new Promise<void>(resolve =>
    child.once('exit', () => {
      resolve()
    })
  )
  child.kill('SIGTERM')
  const deadline = setTimeout(() => child.kill('SIGKILL'), 10_000)
  await done
  clearTimeout(deadline)
}

async function retention(seconds: number): Promise<void> {
  const root = resolve('.')
  const output = process.env.TS_E2E_ARTIFACT_DIR
  assert(output != null && output !== '', 'TS_E2E_ARTIFACT_DIR is required')
  await mkdir(output, { recursive: true })
  const dir = await mkdtemp(join(tmpdir(), 'streaming-retention-'))
  const database = await scratchDatabase('streamingreliabilityfixes_retention')
  const [port, livePort] = await Promise.all([freePort(), freePort()])
  const api = `http://127.0.0.1:${port}/api/v1`
  const space = {
    endpoint: '',
    region: 'test',
    bucket: 'retention',
    accessKeyId: 'example',
    secretAccessKey: randomBytes(32).toString('hex'),
    pathStyle: true
  }
  const store = await startFakeSpace({ space, dir: join(dir, 'space') })
  space.endpoint = store.url
  const children: ChildProcess[] = []
  const publishers: ChildProcess[] = []
  const slots: Array<{ streamId: string; videoId: string }> = []
  let token = ''
  let gameId = ''
  let stage = 0
  const logs = new Map<string, string>()
  const start = (name: string, args: string[]): ChildProcess => {
    const child = spawn(process.execPath, args, {
      cwd: dir,
      env: { ...process.env, NODE_ENV: 'test' },
      stdio: ['ignore', 'pipe', 'pipe']
    })
    logs.set(name, '')
    children.push(child)
    for (const stream of [child.stdout, child.stderr])
      stream?.on('data', data => logs.set(name, logs.get(name)! + String(data)))
    return child
  }
  const helper = createLiveHarness({
    api,
    app: api,
    serverRoot: root,
    configDir: dir,
    token: () => token,
    live: { port: livePort, app: 'live' },
    daemon: () => undefined
  })
  const hold = async (duration: number): Promise<void> => {
    const until = Date.now() + duration * 1000
    while (Date.now() < until) {
      assert(
        children.every(
          child => child.exitCode == null && child.signalCode == null
        ),
        'A server exited'
      )
      assert(
        publishers.every(
          child => child.exitCode == null && child.signalCode == null
        ),
        'A publisher exited'
      )
      await sleep(Math.min(1000, until - Date.now()))
    }
  }
  try {
    const secret = randomBytes(32).toString('hex')
    await writeFile(
      join(dir, 'serverConfig.json'),
      JSON.stringify({
        databaseUrl: database.url,
        listenHost: '127.0.0.1',
        listenPort: port,
        primaryUrlOverride: `127.0.0.1:${port}`,
        clusterWorkers: 1,
        statsBuilder: false,
        sessionSecret: secret,
        mediaSecret: secret,
        workDir: join(dir, 'work'),
        mediaDir: join(dir, 'media'),
        uploadsDir: join(dir, 'uploads'),
        ffmpegPath: process.env.FFMPEG_PATH ?? 'ffmpeg',
        serveMediaLocally: true,
        sentry: { dsn: '' },
        space,
        live: {
          enabled: true,
          bindHost: '127.0.0.1',
          port: livePort,
          healthPort: 0,
          freeDiskFloorGb: 0
        }
      }),
      { mode: 0o600 }
    )
    const metrics = join(output, 'retention-memory.jsonl')
    // The child measures itself, without exposing a debug port or a heap payload.
    await writeFile(
      join(dir, 'metrics.cjs'),
      `const fs=require('node:fs');
setInterval(()=>fs.appendFileSync(${JSON.stringify(metrics)},JSON.stringify({at:Date.now(),...process.memoryUsage()})+'\\n'),5000).unref();`
    )
    const register = join(root, 'node_modules/sucrase/register')
    start('api', ['-r', register, join(root, 'src/server/index.ts')])
    start('ingest', [
      '-r',
      join(dir, 'metrics.cjs'),
      '-r',
      register,
      join(root, 'src/server/ingest/main.ts')
    ])
    const deadline = Date.now() + 60_000
    while (
      !logs.get('api')!.includes('listening on') ||
      !logs.get('ingest')!.includes('ingest health on')
    ) {
      assert(Date.now() < deadline, 'Local services did not start')
      await hold(1)
    }
    const account = {
      email: `retention.${Date.now()}@example.test`,
      password: randomBytes(24).toString('hex')
    }
    helper.dev('seed', account.email, account.password)
    const seeded = helper.dev(
      'scoringGame',
      `viewer.${Date.now()}@example.test`,
      randomBytes(24).toString('hex')
    )
    gameId = /^GAME_ID=(.+)$/m.exec(seeded)?.[1] ?? ''
    assert(gameId !== '')
    token = await signInTestAccount(api, account)
    const stages: Array<{ publishers: number; at: number }> = []
    for (stage = 0; stage <= 3; stage++) {
      if (stage > 0) {
        const camera = await helper.camera(gameId, `Camera ${stage}`)
        slots.push(camera)
        const child = spawn(
          process.env.FFMPEG_PATH ?? 'ffmpeg',
          [
            '-hide_banner',
            '-loglevel',
            'error',
            '-re',
            '-f',
            'lavfi',
            '-i',
            'testsrc2=size=640x360:rate=30',
            '-f',
            'lavfi',
            '-i',
            'sine=frequency=440:sample_rate=48000',
            '-c:v',
            'libx265',
            '-preset',
            'ultrafast',
            '-tune',
            'zerolatency',
            '-g',
            '60',
            '-b:v',
            '1500k',
            '-c:a',
            'aac',
            '-f',
            'flv',
            camera.url
          ],
          { stdio: ['ignore', 'ignore', 'pipe'] }
        )
        publishers.push(child)
        const name = `publisher-${stage}`
        logs.set(name, '')
        child.stderr?.on('data', data =>
          logs.set(name, logs.get(name)! + String(data))
        )
      }
      stages.push({ publishers: stage, at: Date.now() })
      await writeFile(
        join(output, 'retention-stages.json'),
        JSON.stringify(stages, null, 2)
      )
      console.log(`Stage ${stage} publishers`)
      await hold(stage === 3 ? seconds : 30)
    }
    await Promise.all(publishers.map(stop))
    publishers.length = 0
    for (const slot of slots) {
      const result = await helper.ask(
        `/games/${gameId}/live-streams/${slot.streamId}/end`,
        { method: 'POST' }
      )
      assert(
        result.status >= 200 && result.status < 300,
        'End diagnostic slot failed'
      )
    }
    stages.push({ publishers: 0, at: Date.now() })
    await writeFile(
      join(output, 'retention-stages.json'),
      JSON.stringify(stages, null, 2)
    )
    await hold(60)
    const samples = (await readFile(metrics, 'utf8'))
      .trim()
      .split('\n')
      .map(line => JSON.parse(line))
    console.log(
      JSON.stringify({
        result: 'completed',
        seconds,
        samples: samples.length,
        maxHeapUsed: Math.max(...samples.map(sample => sample.heapUsed)),
        maxRss: Math.max(...samples.map(sample => sample.rss))
      })
    )
  } finally {
    await Promise.all(publishers.map(stop))
    for (const slot of slots)
      await helper
        .ask(`/games/${gameId}/live-streams/${slot.streamId}/end`, {
          method: 'POST'
        })
        .catch(() => undefined)
    await Promise.all(children.map(stop))
    await new Promise<void>(resolve =>
      store.server.close(() => {
        resolve()
      })
    )
    for (const [name, text] of logs)
      await writeFile(join(dir, `${name}.log`), text, { mode: 0o600 })
    await database.drop()
    console.log(`Private diagnostics: ${dir}`)
  }
}

const { values } = parseArgs({
  options: {
    surface: { type: 'string' },
    case: { type: 'string' },
    seconds: { type: 'string', default: '3600' }
  }
})
assert(
  values.case === 'retention' ||
    values.surface === 'tv' ||
    (values.surface === 'web' && values.case === 'gaps'),
  'Unknown case'
)
const seconds = Number(values.seconds)
assert(Number.isFinite(seconds) && seconds > 0 && seconds <= 3600)
const run =
  values.surface === 'tv'
    ? import('./streamingReliabilityTv').then(async ({ tvReliability }) => {
        await tvReliability(values.case ?? 'transport')
      })
    : values.case === 'gaps'
      ? import('./streamingReliabilityWeb').then(async ({ webReliability }) => {
          await webReliability('gaps')
        })
      : retention(seconds)
run.catch((error: unknown) => {
  console.error(error)
  process.exitCode = 1
})
