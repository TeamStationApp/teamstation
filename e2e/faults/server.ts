import { spawn } from 'node:child_process'
import { timingSafeEqual } from 'node:crypto'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { asJevControl, JevStub } from '../core/jevStub'
import { PLACES_ANSWERS, startPlacesStub } from '../core/placesStub'
import { FAULTS } from './catalogue'
import {
  clearRateLimits,
  rateLimitsAsk,
  setRateLimitScale,
  sqlProblem,
  type StackDatabase,
  stackDatabase
} from './database'
import {
  isPagesRequest,
  type PageScript,
  PagesStandIn,
  scriptProblem
} from './pages'
import { type FaultProxy, startFaultProxy } from './proxy'
import { RemuxError, type RemuxHandler, stackRemux } from './remux'
import {
  beaconRoute,
  delayFor,
  logForwarded,
  standInRoute,
  type StandIns,
  startStandIns
} from './standIns'

/**
 * The fault server a droplet stack runs between Caddy and its API, with the
 * Places stand-in beside it, which also answers as the Jev stand-in
 * (`e2e/core/jevStub.ts`):
 *
 *   node -r sucrase/register e2e/faults/server.ts --listen 127.0.0.1:9200 \
 *     --target http://127.0.0.1:9100 --places 127.0.0.1:9300 --token-file <file>
 *
 * It forwards everything to the API, recording each 5xx, and breaks the
 * matched routes while a fault is set. Its control routes, under /__e2e/,
 * need the stack's token as a bearer, except the health check:
 *
 *   GET  /__e2e/health                    no token
 *   GET  /__e2e/fault                     { fault }
 *   PUT  /__e2e/fault  { fault | null }   a proxy fault from the catalogue, or none
 *   GET  /__e2e/errors?since=<ms>         { errors } newer than `since`
 *   GET  /__e2e/injections?since=<ms>     { injections } newer than `since`
 *   GET  /__e2e/jev                       the Jev stand-in's script and requests
 *   PUT  /__e2e/jev    { passThrough?, rule?, queries? }
 *                                         replaces the script, forgetting the requests
 *   POST /__e2e/seed   { world, mailbox } seeds a scripted world on the stack's
 *                                         database and answers its manifest
 *   POST /__e2e/sql    { text, values? }  runs a statement on the stack's database
 *   POST /__e2e/rate-limits { clear?, scale? }  clears sign-in limits' rows, scales the limits
 *   POST /__e2e/remux  { action, ... }    media work on the stack (`remux.ts`)
 *   PUT  /__e2e/pages  { [path]: page }   scripts the pages stand-in (`pages.ts`)
 *   GET  /__e2e/pages                     the scripted paths
 *   GET  /__e2e/pages/requests?since=<ms> { requests } the pages site served
 *
 * A request Caddy marks `X-E2E-Site: pages` (the stack's pages port) is the
 * pages stand-in's, whatever its path, and never reaches the API.
 *
 * On a stack it also hosts the stand-ins `standIns.ts` describes, the
 * scripted model and the recogniser on their own ports, with their routes
 * under /__e2e/ (model, speech, delay, beacon, requests) and the public
 * /__tess/beacon.
 */
const CONTROL = '/__e2e/'

/** The catalogue's faults this server can apply: the proxy's. */
export const PROXY_FAULTS = Object.entries(FAULTS)
  .filter(([, fault]) => fault.how === 'proxy')
  .map(([name]) => name)

function json(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json' })
  res.end(JSON.stringify(body))
}

function authorized(req: IncomingMessage, token: string): boolean {
  const given = Buffer.from(String(req.headers.authorization ?? ''))
  const wanted = Buffer.from(`Bearer ${token}`)
  return given.length === wanted.length && timingSafeEqual(given, wanted)
}

/** Reads a JSON body, answering 400 for one that is not JSON. */
function withJson(
  req: IncomingMessage,
  res: ServerResponse,
  then: (body: unknown) => void
): void {
  const chunks: Buffer[] = []
  req.on('data', (chunk: Buffer) => chunks.push(chunk))
  req.on('end', () => {
    let body: unknown
    try {
      body = JSON.parse(Buffer.concat(chunks).toString())
    } catch {
      json(res, 400, { error: 'the body is not JSON' })
      return
    }
    then(body)
  })
}

/** Seeds a world and answers the manifest the fixtures CLI printed. */
export type Seeder = (world: string, mailbox: string) => Promise<unknown>

/**
 * Runs the checkout's `src/server/dev/fixtures/cli.ts <world> --json
 * --mailbox <m>` against `databaseUrl`, from a scratch directory whose
 * server config names that database and allows fixtures, as `seedOnStack`
 * does over SSH. The config names the database's password, so it goes as
 * soon as the seed does.
 */
export function fixtureSeeder(
  checkout: string,
  databaseUrl: string,
  spawnFn: typeof spawn = spawn
): Seeder {
  return async (world, mailbox) => {
    const scratch = mkdtempSync(join(tmpdir(), 'e2e-seed-'))
    writeFileSync(
      join(scratch, 'serverConfig.json'),
      JSON.stringify({ testSettings: true, databaseUrl }),
      { mode: 0o600 }
    )
    try {
      const child = spawnFn(
        process.execPath,
        [
          '-r',
          join(checkout, 'node_modules/sucrase/register'),
          join(checkout, 'src/server/dev/fixtures/cli.ts'),
          world,
          '--json',
          '--mailbox',
          mailbox
        ],
        { cwd: scratch, stdio: ['ignore', 'pipe', 'pipe'] }
      )
      let stdout = ''
      let stderr = ''
      child.stdout?.on('data', (bytes: Buffer) => (stdout += String(bytes)))
      child.stderr?.on('data', (bytes: Buffer) => (stderr += String(bytes)))
      const status = await new Promise<number | null>((resolve, reject) => {
        child.once('error', reject)
        child.once('close', resolve)
      })
      if (status !== 0) {
        throw new Error(`the fixtures CLI failed: ${stderr.slice(-2000)}`)
      }
      return JSON.parse(stdout)
    } finally {
      rmSync(scratch, { recursive: true, force: true })
    }
  }
}

const WORLD_NAME = /^[a-z0-9][a-z0-9-]*$/

/** POST /__e2e/seed: a world name and a plain mailbox, then the seeder's manifest. */
function seedRoute(
  req: IncomingMessage,
  res: ServerResponse,
  seed: Seeder | undefined
): void {
  if (seed == null) {
    json(res, 501, {
      error:
        'this fault server has no database to seed: start it with DATABASE_URL'
    })
    return
  }
  withJson(req, res, body => {
    const { world, mailbox } = (body ?? {}) as {
      world?: unknown
      mailbox?: unknown
    }
    if (typeof world !== 'string' || !WORLD_NAME.test(world)) {
      json(res, 400, { error: 'world is a fixture world name' })
      return
    }
    if (typeof mailbox !== 'string' || !/^[^@+\s]+@[^@\s]+$/.test(mailbox)) {
      json(res, 400, { error: 'mailbox is a plain mailbox address' })
      return
    }
    seed(world, mailbox).then(
      manifest => {
        json(res, 200, manifest)
      },
      (error: unknown) => {
        json(res, 500, {
          error: error instanceof Error ? error.message : String(error)
        })
      }
    )
  })
}

/** POST /__e2e/sql and /__e2e/rate-limits, on the stack's own database. */
function databaseRoute(
  route: 'sql' | 'rate-limits',
  req: IncomingMessage,
  res: ServerResponse,
  database: StackDatabase | undefined
): void {
  if (database == null) {
    json(res, 501, {
      error: 'this fault server has no database: start it with DATABASE_URL'
    })
    return
  }
  withJson(req, res, body => {
    const answer = (work: Promise<unknown>): void => {
      work.then(
        result => {
          json(res, 200, result)
        },
        (error: unknown) => {
          json(res, 500, {
            error: error instanceof Error ? error.message : String(error)
          })
        }
      )
    }
    if (route === 'sql') {
      const problem = sqlProblem(body)
      if (problem != null) {
        json(res, 400, { error: problem })
        return
      }
      const { text, values } = body as { text: string; values?: unknown[] }
      answer(database.query(text, values ?? []))
      return
    }
    const ask = rateLimitsAsk(body)
    if (typeof ask === 'string') {
      json(res, 400, { error: ask })
      return
    }
    answer(
      (async () => {
        if (ask.scale != null) await setRateLimitScale(database, ask.scale)
        const cleared = await clearRateLimits(database, ask.clear)
        return { cleared, ...(ask.scale == null ? {} : { scale: ask.scale }) }
      })()
    )
  })
}

/** POST /__e2e/remux: one media action on the stack, or why it cannot run. */
function remuxRoute(
  req: IncomingMessage,
  res: ServerResponse,
  remux: RemuxHandler | undefined
): void {
  if (remux == null) {
    json(res, 501, { error: 'this fault server does no media work' })
    return
  }
  withJson(req, res, body => {
    remux(body).then(
      result => {
        json(res, 200, result)
      },
      (error: unknown) => {
        json(res, error instanceof RemuxError ? error.status : 500, {
          error: error instanceof Error ? error.message : String(error)
        })
      }
    )
  })
}

/** The /__e2e/ routes, for `startFaultProxy`'s `control`. */
export function controlRoutes(
  proxy: () => FaultProxy,
  token: string,
  jev?: JevStub,
  standIns?: StandIns,
  seed?: Seeder,
  pages?: PagesStandIn,
  database?: StackDatabase,
  remux?: RemuxHandler
): (req: IncomingMessage, res: ServerResponse) => boolean {
  return (req, res) => {
    if (pages != null && isPagesRequest(req)) {
      pages.serve(req, res)
      return true
    }
    const url = new URL(req.url ?? '/', 'http://faults')
    if (standIns != null && beaconRoute(standIns, req, res)) return true
    if (!url.pathname.startsWith(CONTROL)) return false
    const route = url.pathname.slice(CONTROL.length)
    if (route === 'health' && req.method === 'GET') {
      json(res, 200, { ok: true })
      return true
    }
    if (!authorized(req, token)) {
      json(res, 401, { error: 'the stack token is needed' })
      return true
    }
    const since = Number(url.searchParams.get('since') ?? 0)
    if (route === 'fault' && req.method === 'GET') {
      json(res, 200, { fault: proxy().fault() })
    } else if (route === 'fault' && req.method === 'PUT') {
      withJson(req, res, body => {
        const fault = (body as { fault?: unknown } | null)?.fault
        if (
          fault !== null &&
          (typeof fault !== 'string' || !PROXY_FAULTS.includes(fault))
        ) {
          json(res, 400, {
            error: `fault is null or one of ${PROXY_FAULTS.join(', ')}`
          })
          return
        }
        proxy().setFault(fault)
        json(res, 200, { fault })
      })
    } else if (route === 'errors' && req.method === 'GET') {
      json(res, 200, { errors: proxy().errors.filter(row => row.at >= since) })
    } else if (route === 'injections' && req.method === 'GET') {
      json(res, 200, {
        injections: proxy().injections.filter(row => row.at >= since)
      })
    } else if (route === 'seed' && req.method === 'POST') {
      seedRoute(req, res, seed)
    } else if (
      (route === 'sql' || route === 'rate-limits') &&
      req.method === 'POST'
    ) {
      databaseRoute(route, req, res, database)
    } else if (route === 'remux' && req.method === 'POST') {
      remuxRoute(req, res, remux)
    } else if (route.startsWith('pages') && pages == null) {
      json(res, 404, { error: 'this fault server has no pages stand-in' })
    } else if (route === 'pages' && req.method === 'GET') {
      json(res, 200, pages!.view())
    } else if (route === 'pages' && req.method === 'PUT') {
      withJson(req, res, body => {
        const problem = scriptProblem(body)
        if (problem != null) {
          json(res, 400, { error: problem })
          return
        }
        pages!.setScript(body as Record<string, PageScript>)
        json(res, 200, pages!.view())
      })
    } else if (route === 'pages/requests' && req.method === 'GET') {
      json(res, 200, { requests: pages!.since(since) })
    } else if (route === 'jev' && jev == null) {
      json(res, 404, { error: 'this fault server has no Jev stand-in' })
    } else if (route === 'jev' && req.method === 'GET') {
      json(res, 200, jev!.view())
    } else if (route === 'jev' && req.method === 'PUT') {
      withJson(req, res, body => {
        let control
        try {
          control = asJevControl(body)
        } catch (error) {
          json(res, 400, { error: (error as Error).message })
          return
        }
        json(res, 200, jev!.set(control))
      })
    } else if (
      standIns == null ||
      !standInRoute(standIns, route, req, res, url)
    ) {
      json(res, 404, { error: `no route ${req.method} ${url.pathname}` })
    }
    return true
  }
}

export interface FaultServerOptions {
  listen: { host: string; port: number }
  target: string
  places?: { host: string; port: number }
  token: string
  /** The stand-ins' ports, their own fixed ones by default (tests use 0). */
  modelPort?: number
  speechPort?: number
  /** Seeds worlds for `POST /__e2e/seed`; without it the route answers 501. */
  seed?: Seeder
  /** The stack's database, for `sql` and `rate-limits`; without it they answer 501. */
  database?: StackDatabase
  /** Makes the `remux` route's handler on the server's pages; without it the route answers 501. */
  remux?: (pages: PagesStandIn) => RemuxHandler
}

export async function startFaultServer(
  options: FaultServerOptions,
  jev: JevStub = new JevStub()
): Promise<{
  proxy: FaultProxy
  placesUrl?: string
  jev?: JevStub
  standIns?: StandIns
  pages: PagesStandIn
  close: () => Promise<void>
}> {
  if (options.token.length < 32) throw new Error('the stack token is too short')
  // The routes are made before the proxy they answer for, so they find it here.
  const holder: { proxy?: FaultProxy } = {}
  const current = (): FaultProxy => {
    if (holder.proxy == null) throw new Error('the fault proxy has not started')
    return holder.proxy
  }
  // On a stack, beside the Places stand-in: the scripted model, the
  // recogniser, the read delay and the request log (`standIns.ts`).
  const standIns =
    options.places == null
      ? undefined
      : await startStandIns({
          ...(options.modelPort == null
            ? {}
            : { modelPort: options.modelPort }),
          ...(options.speechPort == null
            ? {}
            : { speechPort: options.speechPort })
        })
  const pages = new PagesStandIn()
  const proxy = await startFaultProxy({
    target: options.target,
    host: options.listen.host,
    port: options.listen.port,
    // The Jev stand-in answers on the Places listener, so only with one.
    control: controlRoutes(
      current,
      options.token,
      options.places == null ? undefined : jev,
      standIns,
      options.seed,
      pages,
      options.database,
      options.remux?.(pages)
    ),
    ...(standIns == null
      ? {}
      : {
          delay: path => delayFor(standIns, path),
          onRequest: (method, path) => {
            logForwarded(standIns, method, path)
          }
        })
  })
  holder.proxy = proxy
  const places =
    options.places == null
      ? undefined
      : await startPlacesStub(
          options.places.host,
          PLACES_ANSWERS,
          options.places.port,
          jev
        )
  return {
    proxy,
    ...(places == null ? {} : { placesUrl: places.url, jev }),
    ...(standIns == null ? {} : { standIns }),
    pages,
    close: async () => {
      places?.server.close()
      await standIns?.close()
      await options.database?.close()
      await proxy.close()
    }
  }
}

/** `host:port`. */
export function hostPort(
  value: string,
  flag: string
): { host: string; port: number } {
  const at = value.lastIndexOf(':')
  const port = Number(value.slice(at + 1))
  if (at < 1 || !Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`${flag} wants host:port, not ${value}`)
  }
  return { host: value.slice(0, at), port }
}

/**
 * The command line's options. With `DATABASE_URL` set, the seed route seeds
 * that database from the checkout the server runs from (`--checkout`, by
 * default the working directory).
 */
export function parseFaultServerArgs(
  argv: string[],
  env: Record<string, string | undefined> = process.env,
  cwd = process.cwd()
): FaultServerOptions {
  const values: Record<string, string> = {}
  for (let i = 0; i < argv.length; i += 2) {
    const flag = argv[i]
    if (
      ![
        '--listen',
        '--target',
        '--places',
        '--token-file',
        '--checkout'
      ].includes(flag) ||
      argv[i + 1] == null
    ) {
      throw new Error(`unknown or empty option ${flag}`)
    }
    values[flag] = argv[i + 1]
  }
  for (const flag of ['--listen', '--target', '--token-file']) {
    if (values[flag] == null) throw new Error(`${flag} is needed`)
  }
  const checkout = values['--checkout'] ?? cwd
  const database =
    env.DATABASE_URL == null || env.DATABASE_URL === ''
      ? undefined
      : stackDatabase(env.DATABASE_URL)
  return {
    listen: hostPort(values['--listen'], '--listen'),
    target: values['--target'],
    ...(values['--places'] == null
      ? {}
      : { places: hostPort(values['--places'], '--places') }),
    token: readFileSync(values['--token-file'], 'utf8').trim(),
    ...(database == null
      ? {}
      : {
          seed: fixtureSeeder(checkout, env.DATABASE_URL!),
          database
        }),
    // The media work reads the checkout's own server config, for its Space and FFmpeg.
    remux: pages => stackRemux(checkout, database, pages)
  }
}

if (require.main === module) {
  startFaultServer(parseFaultServerArgs(process.argv.slice(2))).then(
    started => {
      console.log(
        `fault server on ${started.proxy.url}${started.placesUrl == null ? '' : `, Places and Jev on ${started.placesUrl}`}`
      )
    },
    (error: unknown) => {
      console.error(error instanceof Error ? error.message : String(error))
      process.exit(1)
    }
  )
}
