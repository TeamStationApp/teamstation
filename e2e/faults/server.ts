import { timingSafeEqual } from 'node:crypto'
import { readFileSync } from 'node:fs'
import type { IncomingMessage, ServerResponse } from 'node:http'

import { asJevControl, JevStub } from '../core/jevStub'
import { PLACES_ANSWERS, startPlacesStub } from '../core/placesStub'
import { FAULTS } from './catalogue'
import { type FaultProxy, startFaultProxy } from './proxy'

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

/** The /__e2e/ routes, for `startFaultProxy`'s `control`. */
export function controlRoutes(
  proxy: () => FaultProxy,
  token: string,
  jev?: JevStub
): (req: IncomingMessage, res: ServerResponse) => boolean {
  return (req, res) => {
    const url = new URL(req.url ?? '/', 'http://faults')
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
    } else {
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
}

export async function startFaultServer(
  options: FaultServerOptions,
  jev: JevStub = new JevStub()
): Promise<{
  proxy: FaultProxy
  placesUrl?: string
  jev?: JevStub
  close: () => Promise<void>
}> {
  if (options.token.length < 32) throw new Error('the stack token is too short')
  // The routes are made before the proxy they answer for, so they find it here.
  const holder: { proxy?: FaultProxy } = {}
  const current = (): FaultProxy => {
    if (holder.proxy == null) throw new Error('the fault proxy has not started')
    return holder.proxy
  }
  const proxy = await startFaultProxy({
    target: options.target,
    host: options.listen.host,
    port: options.listen.port,
    // The Jev stand-in answers on the Places listener, so only with one.
    control: controlRoutes(
      current,
      options.token,
      options.places == null ? undefined : jev
    )
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
    close: async () => {
      places?.server.close()
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

/** The command line's options. */
export function parseFaultServerArgs(argv: string[]): FaultServerOptions {
  const values: Record<string, string> = {}
  for (let i = 0; i < argv.length; i += 2) {
    const flag = argv[i]
    if (
      !['--listen', '--target', '--places', '--token-file'].includes(flag) ||
      argv[i + 1] == null
    ) {
      throw new Error(`unknown or empty option ${flag}`)
    }
    values[flag] = argv[i + 1]
  }
  for (const flag of ['--listen', '--target', '--token-file']) {
    if (values[flag] == null) throw new Error(`${flag} is needed`)
  }
  return {
    listen: hostPort(values['--listen'], '--listen'),
    target: values['--target'],
    ...(values['--places'] == null
      ? {}
      : { places: hostPort(values['--places'], '--places') }),
    token: readFileSync(values['--token-file'], 'utf8').trim()
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
