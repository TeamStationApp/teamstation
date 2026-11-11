/**
 * The one local stack legacy scripts share: an API on 9100 over its own
 * database, the web app served on 8082 from its own directory, and a proxy on
 * 8080 that sends `/api/` to the API and everything else to the web app.
 */

import { type ChildProcess, spawn, spawnSync } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  rmSync,
  writeFileSync
} from 'node:fs'
import { createServer, request, type Server } from 'node:http'
import { connect } from 'node:net'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'

import { stackServers } from './legacyServers'
import { loadSettings, readSecret } from './settings'
import { lanAddress } from './stack'

export const STACK_DATABASE = 'AppDb_nativeScoreboard'
/** The stack's database and store, from TS_TEST_DATABASE_URL and TS_TEST_REDIS_URL. */
export const STACK_SERVERS = stackServers(STACK_DATABASE)
export const STACK_DATABASE_URL = STACK_SERVERS.databaseUrl
export const STACK_API_PORT = 9100
export const STACK_WEB_PORT = 8082
export const STACK_PROXY_PORT = 8080
export const STACK_SPACE_PORT = 9190
export const STACK_METRO_PORT = 8081
const FFMPEG_FULL = '/opt/homebrew/opt/ffmpeg-full/bin/ffmpeg'
export const STACK_API = `http://127.0.0.1:${STACK_API_PORT}/api/v1`
export const STACK_ORIGIN = `http://127.0.0.1:${STACK_PROXY_PORT}`
/** The media origins the stack's web builds allow: any loopback port. */
export const STACK_MEDIA_ORIGINS = 'http://127.0.0.1:* http://localhost:*'

export interface LegacyStack {
  /** Variables every legacy script sees while the stack is up. */
  env: Record<string, string>
  apiLog: string
  /** Whether the API has an xAI speech key. */
  speech: boolean
  /** Seeds the accounts again, after something dropped the database. */
  reseed: () => void
  /** Restarts the API, with `speech` left out of its config when `speech` is false. */
  restartApi: (options?: { speech?: boolean }) => Promise<void>
  /**
   * Starts the stack's own API again when a script stopped it and left a
   * server of its own on the API port (scoreboardServer's restart).
   */
  ensureApi: () => Promise<void>
  stop: () => Promise<void>
}

type Json = Record<string, unknown>

function anthropicKey(): string {
  try {
    return readSecret(loadSettings(), 'anthropic')
  } catch {
    return ''
  }
}

function speechKey(): string {
  try {
    return readSecret(loadSettings(), 'speech')
  } catch {
    return ''
  }
}

function writePrivate(file: string, value: unknown): void {
  writeFileSync(file, JSON.stringify(value, null, 2), { mode: 0o600 })
}

async function waitFor(url: string, timeoutMs: number): Promise<void> {
  const until = Date.now() + timeoutMs
  let last = ''
  while (Date.now() < until) {
    try {
      const response = await fetch(url)
      if (response.ok) return
      last = `status ${response.status}`
    } catch (error) {
      last = error instanceof Error ? error.message : String(error)
    }
    await new Promise(resolve => setTimeout(resolve, 500))
  }
  throw new Error(`${url} did not answer: ${last}`)
}

/**
 * Refuses ports something already answers on. A server left from an earlier
 * run would otherwise answer the stack's own readiness checks, and serve the
 * scripts in its place.
 */
export async function refuseTakenPorts(ports: number[]): Promise<void> {
  const taken: number[] = []
  for (const port of ports) {
    const answers = await new Promise<boolean>(resolve => {
      const socket = connect(port, '127.0.0.1', () => {
        socket.destroy()
        resolve(true)
      })
      socket.on('error', () => {
        resolve(false)
      })
    })
    if (answers) taken.push(port)
  }
  if (taken.length > 0)
    throw new Error(
      `the stack's ports are taken: ${taken.join(', ')}; stop what holds them`
    )
}

/** Stops, by PID, whatever listens on `port`, and waits for the port to free. */
async function stopListeners(port: number): Promise<void> {
  const found = spawnSync(
    '/usr/sbin/lsof',
    ['-t', `-iTCP:${port}`, '-sTCP:LISTEN'],
    { encoding: 'utf8' }
  )
  const pids = found.stdout.split('\n').filter(line => /^\d+$/.test(line))
  for (const pid of pids) {
    try {
      process.kill(Number(pid), 'SIGTERM')
    } catch {}
  }
  const until = Date.now() + 20_000
  while (Date.now() < until) {
    const left = await new Promise<boolean>(resolve => {
      const socket = connect(port, '127.0.0.1', () => {
        socket.destroy()
        resolve(true)
      })
      socket.on('error', () => {
        resolve(false)
      })
    })
    if (!left) return
    await new Promise(resolve => setTimeout(resolve, 250))
  }
  throw new Error(
    `port ${port} is still held after stopping ${pids.join(', ')}`
  )
}

async function stopChild(child: ChildProcess | undefined): Promise<void> {
  if (child == null || child.exitCode != null) return
  await new Promise<void>(resolve => {
    const timer = setTimeout(() => {
      child.kill('SIGKILL')
    }, 10_000)
    child.once('close', () => {
      clearTimeout(timer)
      resolve()
    })
    child.kill('SIGTERM')
  })
}

/** A fresh `AppDb_nativeScoreboard`: fixtures with fixed ids refuse a second run. */
function freshDatabase(): void {
  const { clusterArgs, password } = STACK_SERVERS
  const env =
    password == null ? process.env : { ...process.env, PGPASSWORD: password }
  const dropped = spawnSync(
    'dropdb',
    [...clusterArgs, '--if-exists', '--force', STACK_DATABASE],
    { encoding: 'utf8', env }
  )
  if (dropped.status !== 0) throw new Error(`dropdb failed: ${dropped.stderr}`)
  const made = spawnSync('createdb', [...clusterArgs, STACK_DATABASE], {
    encoding: 'utf8',
    env
  })
  if (made.status !== 0) throw new Error(`createdb failed: ${made.stderr}`)
}

/** Paths the API answers at the origin's root, as the deployed proxy sends them. */
const API_ROOTS = [
  '/api/',
  '/socket',
  '/oauth',
  '/.well-known/',
  '/away',
  '/plain',
  '/turn'
]

function toApi(url: string | undefined): boolean {
  const path = url ?? ''
  return API_ROOTS.some(root => path === root || path.startsWith(root))
}

function proxy(): Server {
  const server = createServer((req, res) => {
    const port = toApi(req.url) ? STACK_API_PORT : STACK_WEB_PORT
    const forward = request(
      {
        host: '127.0.0.1',
        port,
        path: req.url,
        method: req.method,
        headers: req.headers
      },
      upstream => {
        res.writeHead(upstream.statusCode ?? 502, upstream.headers)
        upstream.pipe(res)
      }
    )
    forward.on('error', () => {
      if (!res.headersSent) res.writeHead(502)
      res.end()
    })
    req.pipe(forward)
  })
  server.on('upgrade', (req, socket, head) => {
    const port = toApi(req.url) ? STACK_API_PORT : STACK_WEB_PORT
    const upstream = connect(port, '127.0.0.1', () => {
      const lines = [`${req.method} ${req.url} HTTP/${req.httpVersion}`]
      for (let i = 0; i < req.rawHeaders.length; i += 2) {
        lines.push(`${req.rawHeaders[i]}: ${req.rawHeaders[i + 1]}`)
      }
      upstream.write(lines.join('\r\n') + '\r\n\r\n')
      upstream.write(head)
      upstream.pipe(socket)
      socket.pipe(upstream)
    })
    upstream.on('error', () => socket.destroy())
    socket.on('error', () => upstream.destroy())
  })
  return server
}

/** Starts the stack from `cwd`, writing its logs under `artifacts`. */
export async function startLegacyStack(
  cwd: string,
  artifacts: string
): Promise<LegacyStack> {
  await refuseTakenPorts([
    STACK_API_PORT,
    STACK_WEB_PORT,
    STACK_PROXY_PORT,
    STACK_SPACE_PORT
  ])
  const scratch = join(tmpdir(), 'teamstation-e2eSuite-stack')
  rmSync(scratch, { recursive: true, force: true })
  mkdirSync(scratch, { recursive: true, mode: 0o700 })
  mkdirSync(artifacts, { recursive: true })
  const mediaDir = join(scratch, 'media')
  const workDir = join(scratch, 'work')
  mkdirSync(mediaDir, { recursive: true })
  mkdirSync(workDir, { recursive: true })

  const configFile = join(cwd, 'serverConfig.json')
  const original = join(scratch, 'serverConfig.original.json')
  const hadConfig = existsSync(configFile)
  if (hadConfig) copyFileSync(configFile, original)
  const base: Json = hadConfig
    ? (JSON.parse(readFileSync(original, 'utf8')) as Json)
    : {}

  const anthropic = anthropicKey()
  const speech = speechKey()
  const sessionSecret = randomBytes(32).toString('hex')
  const mediaSecret = randomBytes(32).toString('hex')
  const space = {
    endpoint: `http://127.0.0.1:${STACK_SPACE_PORT}`,
    region: 'us-east-1',
    bucket: 'e2e',
    accessKeyId: 'e2e',
    secretAccessKey: 'e2e-secret-key',
    pathStyle: true,
    mediaBaseUrl: ''
  }
  // A phone reaches the stack through the proxy on this Mac's LAN address.
  const lanOrigin = `http://${lanAddress()}:${STACK_PROXY_PORT}`
  const config = (withSpeech: boolean): Json => {
    const next: Json = {
      ...base,
      listenHost: '127.0.0.1',
      listenPort: STACK_API_PORT,
      databaseUrl: STACK_DATABASE_URL,
      databasePoolUrl: '',
      sessionSecret,
      mediaSecret,
      mediaDir,
      workDir,
      uploadsDir: join(scratch, 'uploads'),
      space,
      serveMediaLocally: true,
      // Chat history recovery and fresh keys: the chat scripts exercise both.
      chatHistoryRecoveryEnabled: true,
      // Fixtures burn a clock into sample video, which needs drawtext.
      ...(existsSync(FFMPEG_FULL) ? { ffmpegPath: FFMPEG_FULL } : {}),
      redis: { url: STACK_SERVERS.redisUrl, prefix: '', caFile: '' },
      corsOrigins: [
        STACK_ORIGIN,
        `http://localhost:${STACK_PROXY_PORT}`,
        lanOrigin
      ],
      live: { ...(base.live ?? {}), enabled: true }
    }
    delete next.speech
    delete next.dictation
    if (withSpeech && anthropic !== '') {
      next.dictation = { apiKey: '', anthropic: { apiKey: anthropic } }
    }
    if (withSpeech && speech !== '') next.speech = { apiKey: speech }
    return next
  }
  writePrivate(configFile, config(true))
  const restore = (): void => {
    if (hadConfig) copyFileSync(original, configFile)
    else rmSync(configFile, { force: true })
  }
  const children: Array<ChildProcess | undefined> = []
  let store: Server | undefined
  try {
    return await bringUp()
  } catch (error) {
    for (const child of children) await stopChild(child)
    store?.close()
    restore()
    throw error
  }

  async function bringUp(): Promise<LegacyStack> {
    const dictationConfig = join(scratch, 'dictation.json')
    const anthropicFile = join(scratch, 'anthropic.json')
    const localSettings = join(scratch, 'local.json')
    if (anthropic !== '') {
      writePrivate(dictationConfig, {
        dictation: { anthropic: { apiKey: anthropic } }
      })
      writePrivate(anthropicFile, { anthropic })
      writePrivate(localSettings, {
        ...loadSettings(),
        secretsFile: anthropicFile
      })
    }

    const { startFakeSpace } = await import('../../src/server/dev/fakeSpace')
    const spaceStore = join(scratch, 'store')
    store = (
      await startFakeSpace({
        space,
        dir: spaceStore,
        host: '127.0.0.1',
        port: STACK_SPACE_PORT
      })
    ).server

    freshDatabase()
    const migrate = spawnSync(
      process.execPath,
      ['-r', 'sucrase/register', 'src/migrate/cli.ts', 'up'],
      { cwd, encoding: 'utf8' }
    )
    if (migrate.status !== 0) {
      throw new Error(`migrate failed: ${migrate.stderr.slice(-2000)}`)
    }

    // Accounts the scoring scripts sign in as, with passwords made for this run
    // and never printed. The lineup fixture makes its own people with its own.
    const passwords = {
      TS_SCORER_PASSWORD: randomBytes(12).toString('hex'),
      TS_VIEWER_PASSWORD: randomBytes(12).toString('hex'),
      TS_LINEUP_PASSWORD: randomBytes(12).toString('hex')
    }
    const reseed = (): void => {
      for (const [email, password] of [
        ['scoring@teamstation.local', passwords.TS_SCORER_PASSWORD],
        ['viewer@teamstation.local', passwords.TS_VIEWER_PASSWORD]
      ]) {
        const seeded = spawnSync(
          process.execPath,
          ['-r', 'sucrase/register', 'src/server/dev/seed.ts', email, password],
          { cwd, encoding: 'utf8' }
        )
        if (seeded.status !== 0) {
          throw new Error(`seed ${email} failed: ${seeded.stderr.slice(-2000)}`)
        }
      }
    }
    reseed()

    const apiLog = join(artifacts, 'api.log')
    const ingestLog = join(artifacts, 'ingest.log')
    const webLog = join(artifacts, 'web.log')
    let api: ChildProcess | undefined
    let ingest: ChildProcess | undefined
    const startApi = async (): Promise<void> => {
      const out = openSync(apiLog, 'a')
      api = spawn(
        process.execPath,
        ['-r', 'sucrase/register', 'src/server/index.ts'],
        { cwd, stdio: ['ignore', out, out], env: process.env }
      )
      children.push(api)
      await waitFor(`${STACK_API}/health`, 120_000)
      // Ingest reads the same config: the session secret and the media dir.
      const ingestOut = openSync(ingestLog, 'a')
      ingest = spawn(
        process.execPath,
        ['-r', 'sucrase/register', 'src/server/ingest/main.ts'],
        { cwd, stdio: ['ignore', ingestOut, ingestOut], env: process.env }
      )
      children.push(ingest)
    }
    await startApi()

    const webOut = join(scratch, 'web')
    const webOutput = openSync(webLog, 'a')
    const web = spawn(process.execPath, ['src/build.mjs', '--serve'], {
      cwd,
      stdio: ['ignore', webOutput, webOutput],
      env: {
        ...process.env,
        TS_SERVE_PORT: String(STACK_WEB_PORT),
        TS_WEB_OUT_DIR: webOut,
        TS_API_BASE_URL: '/api/v1',
        TS_MEDIA_ORIGINS: STACK_MEDIA_ORIGINS
      }
    })
    children.push(web)
    await waitFor(`http://127.0.0.1:${STACK_WEB_PORT}/`, 300_000)

    // A phone's debug build loads its JavaScript from Metro, which inlines the
    // API it was started with, so phones reach this stack without a rebuild.
    const phones = [process.env.E2E_IOS_UDID, process.env.E2E_ANDROID_SERIAL]
    if (phones.some(device => device != null && device !== '')) {
      const metroOut = openSync(join(artifacts, 'metro.log'), 'a')
      const metro = spawn(
        'npx',
        [
          'react-native',
          'start',
          '--port',
          String(STACK_METRO_PORT),
          '--reset-cache'
        ],
        {
          cwd,
          stdio: ['ignore', metroOut, metroOut],
          env: { ...process.env, TS_API_BASE_URL: `${lanOrigin}/api/v1` }
        }
      )
      children.push(metro)
      await waitFor(`http://127.0.0.1:${STACK_METRO_PORT}/status`, 180_000)
      const serial = process.env.E2E_ANDROID_SERIAL
      if (serial != null && serial !== '') {
        spawnSync('adb', [
          '-s',
          serial,
          'reverse',
          `tcp:${STACK_METRO_PORT}`,
          `tcp:${STACK_METRO_PORT}`
        ])
      }
    }

    const front = proxy()
    await new Promise<void>((resolve, reject) => {
      front.once('error', reject)
      front.listen(STACK_PROXY_PORT, '0.0.0.0', resolve)
    })

    const env: Record<string, string> = {
      TS_E2E_HOST: `http://127.0.0.1:${STACK_API_PORT}`,
      TS_E2E_DATABASE_URL: STACK_DATABASE_URL,
      TS_E2E_DATABASE: STACK_DATABASE,
      TS_DATABASE: STACK_DATABASE_URL,
      TS_E2E_SERVER_LOG: apiLog,
      TS_E2E_WEB: STACK_ORIGIN,
      // The stand-in Space's files, for scripts that read stored objects.
      TS_FAKE_SPACE_DIR: spaceStore,
      // What the web builds were made with, for scripts that check their policy.
      TS_MEDIA_ORIGINS: STACK_MEDIA_ORIGINS,
      TS_STACK_LAN_ORIGIN: lanOrigin,
      TS_STREAM_API: STACK_API,
      TS_STREAM_SERVER_LOG: apiLog,
      TS_STREAM_HLS_ROOT: join(mediaDir, 'work', 'videos'),
      REPLAY_WEB_URL: STACK_ORIGIN,
      REPLAY_API: STACK_API,
      REPLAY_SERVER_LOG: apiLog,
      ...passwords
    }
    if (anthropic !== '') {
      env.TS_DICTATION_CONFIG = dictationConfig
      env.TS_TESS_CONFIG = dictationConfig
      env.E2E_LOCAL_SETTINGS = localSettings
    }

    return {
      get env() {
        return { ...env, TS_E2E_SERVER_PID: String(api?.pid ?? '') }
      },
      apiLog,
      speech: speech !== '',
      reseed,
      restartApi: async options => {
        await stopChild(ingest)
        await stopChild(api)
        writePrivate(configFile, config(options?.speech ?? true))
        await startApi()
      },
      ensureApi: async () => {
        if (api != null && api.exitCode == null && api.signalCode == null)
          return
        await stopChild(ingest)
        await stopListeners(STACK_API_PORT)
        await startApi()
      },
      stop: async () => {
        await new Promise<void>(resolve =>
          front.close(() => {
            resolve()
          })
        )
        for (const child of children) await stopChild(child)
        await stopChild(ingest)
        await stopChild(api)
        store?.close()
        restore()
        rmSync(scratch, { recursive: true, force: true })
      }
    }
  }
}

/** Where the stack keeps its logs between scripts. */
export function stackArtifacts(): string {
  return join(
    homedir(),
    '.cursor/artifacts/202611080444-e2eSuite/legacy/_stack'
  )
}
