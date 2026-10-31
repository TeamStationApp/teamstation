import { type ChildProcess, spawn, spawnSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { createServer as createNetServer } from 'node:net'
import { networkInterfaces, tmpdir } from 'node:os'
import { join } from 'node:path'

import { Pool } from 'pg'

import { startFront } from './front'
import { ROOT } from './manifest'
import { startPlacesStub } from './placesStub'
import { HarnessError } from './result'
import type { StackHandle } from './spec'

export interface StackOptions {
  id?: string
  /** Bind where a phone can reach it. Every surface but desktop Chromium needs it. */
  lan?: boolean
  /** Start Metro with this stack's API, for a native app. */
  native?: boolean
  services: string[]
  root?: string
}

export interface RunningStack extends StackHandle {
  id: string
  dir: string
  stop: () => Promise<void>
}

export function lanAddress(interfaces = networkInterfaces()): string {
  for (const rows of Object.values(interfaces)) {
    for (const row of rows ?? []) {
      if (row.family === 'IPv4' && !row.internal) return row.address
    }
  }
  throw new HarnessError('This machine has no LAN address')
}

export async function freePort(host = '127.0.0.1'): Promise<number> {
  return await new Promise((resolve, reject) => {
    const probe = createNetServer()
    probe.once('error', reject)
    probe.listen(0, host, () => {
      const { port } = probe.address() as { port: number }
      probe.close(() => {
        resolve(port)
      })
    })
  })
}

/** Builds the web app into `outDir` with `mediaOrigin` in its security policy. */
export function buildWeb(
  root: string,
  outDir: string,
  mediaOrigin: string
): void {
  const built = spawnSync(process.execPath, ['src/build.mjs'], {
    cwd: root,
    encoding: 'utf8',
    env: {
      ...process.env,
      TS_WEB_OUT_DIR: outDir,
      TS_MEDIA_ORIGINS: mediaOrigin
    }
  })
  if (built.status !== 0) {
    throw new HarnessError(`Web build failed: ${built.stderr}`)
  }
}

function serverEnv(): NodeJS.ProcessEnv {
  return { ...process.env, NODE_ENV: 'test' }
}

async function untilHealthy(url: string, proc: ChildProcess): Promise<void> {
  const end = Date.now() + 60000
  while (Date.now() < end) {
    if (proc.exitCode != null) {
      throw new HarnessError(`The API exited with ${proc.exitCode}`)
    }
    try {
      const reply = await fetch(`${url}/api/v1/health`)
      if (reply.ok) return
    } catch {
      // Not listening yet.
    }
    await new Promise(resolve => setTimeout(resolve, 250))
  }
  throw new HarnessError('The API did not become healthy')
}

/**
 * A scratch server on this machine: its own database, object store, Places stub, API
 * and web build on one origin. Nothing here touches a seat.
 */
export async function startStack(options: StackOptions): Promise<RunningStack> {
  // Server code loads only when a stack starts, so reading the suite stays free
  // of its native addon and its configuration file.
  const { testDatabaseUrl } = await import('../../src/migrate/testDatabase')
  const { startFakeSpace } = await import('../../src/server/dev/fakeSpace')
  const { publishPictureCatalog } =
    await import('../../src/server/media/pictureCatalog')
  const root = options.root ?? ROOT
  const id = options.id ?? randomUUID().slice(0, 8)
  const dir = join(tmpdir(), 'teamstation-e2e-stacks', id)
  mkdirSync(dir, { recursive: true })
  const host = options.lan === true ? lanAddress() : '127.0.0.1'
  const stops: Array<() => Promise<void> | void> = []
  const stop = async (): Promise<void> => {
    for (const fn of stops.reverse()) await fn()
    rmSync(dir, { recursive: true, force: true })
  }
  try {
    const wantsApi = options.services.includes('api')
    const wantsWeb = options.services.includes('web') || wantsApi

    const storePort = await freePort(host)
    const space = {
      endpoint: `http://${host}:${storePort}`,
      region: 'us-east-1',
      bucket: 'e2e',
      accessKeyId: 'e2e',
      secretAccessKey: 'e2e-secret-key',
      pathStyle: true
    }
    const store = await startFakeSpace({
      space,
      dir: join(dir, 'store'),
      host,
      port: storePort
    })
    stops.push(() => {
      store.server.close()
      store.server.closeAllConnections()
    })

    // A seat's dev Space already has the catalog that team creation reads.
    if (wantsApi) {
      await publishPictureCatalog(space, join(root, 'src/app/assets/sports'))
    }

    let webDir: string | undefined
    if (wantsWeb) {
      webDir = join(dir, 'web')
      buildWeb(root, webDir, store.url)
    }

    const apiPort = wantsApi ? await freePort() : await freePort()
    const front = await startFront({
      webDir: webDir ?? dir,
      apiPort,
      host,
      port: 0
    })
    stops.push(() => {
      front.server.close()
      front.server.closeAllConnections()
    })

    if (wantsApi) {
      const places = await startPlacesStub('127.0.0.1')
      stops.push(() => {
        places.server.close()
        places.server.closeAllConnections()
      })
      const databaseName = `e2e_${id.replace(/\W/g, '')}`
      const admin = new Pool({ connectionString: testDatabaseUrl })
      await admin.query(`create database ${databaseName}`)
      const databaseUrl = new URL(testDatabaseUrl)
      databaseUrl.pathname = `/${databaseName}`
      stops.push(async () => {
        await admin.query(
          `drop database if exists ${databaseName} with (force)`
        )
        await admin.end()
      })
      const origin = new URL(front.url)
      writeFileSync(
        join(dir, 'serverConfig.json'),
        JSON.stringify({
          databaseUrl: databaseUrl.toString(),
          listenHost: '127.0.0.1',
          listenPort: apiPort,
          clusterWorkers: 1,
          statsBuilder: false,
          workDir: join(dir, 'work'),
          mediaDir: join(dir, 'media'),
          uploadsDir: join(dir, 'uploads'),
          ffmpegPath: process.env.TS_FFMPEG ?? 'ffmpeg',
          sessionSecret: 's'.repeat(32),
          mediaSecret: 'm'.repeat(32),
          serveMediaLocally: true,
          testSettings: true,
          primaryUrlOverride: origin.host,
          corsOrigins: [front.url],
          space,
          googlePlaces: { apiKey: 'stub', baseUrl: places.url },
          redis: {
            url: process.env.TS_TEST_REDIS_URL ?? 'redis://127.0.0.1:6379/15',
            prefix: `ts:e2e-${id}`,
            caFile: ''
          },
          live: { enabled: false },
          logRequests: true
        })
      )
      const register = require.resolve('sucrase/register')
      const migrated = spawnSync(
        process.execPath,
        ['-r', register, join(root, 'src/migrate/cli.ts')],
        { cwd: dir, encoding: 'utf8', env: serverEnv() }
      )
      if (migrated.status !== 0) {
        throw new HarnessError(`Migration failed: ${migrated.stderr}`)
      }
      const api = spawn(
        process.execPath,
        ['-r', register, join(root, 'src/server/index.ts')],
        { cwd: dir, env: serverEnv(), stdio: 'ignore' }
      )
      stops.push(async () => {
        api.kill('SIGTERM')
        await new Promise(resolve => setTimeout(resolve, 200))
        api.kill('SIGKILL')
      })
      await untilHealthy(front.url, api)
    }

    if (options.native === true) {
      const metro = spawn(
        process.execPath,
        ['node_modules/.bin/react-native', 'start', '--port', '0'],
        {
          cwd: root,
          env: { ...process.env, TS_API_BASE_URL: `${front.url}/api/v1` },
          stdio: 'ignore'
        }
      )
      stops.push(() => {
        metro.kill('SIGTERM')
      })
    }

    let origin = front.url
    return {
      id,
      dir,
      kind: 'isolated',
      get origin() {
        return origin
      },
      webDir,
      adopt: adopted => {
        origin = adopted
        return adopted
      },
      stop
    }
  } catch (error) {
    await stop()
    throw error
  }
}
