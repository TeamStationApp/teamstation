import { createReadStream, statSync } from 'node:fs'
import type { IncomingMessage, ServerResponse } from 'node:http'

/**
 * The `pages` stand-in: the stack's second origin (the same name on its pages
 * port, which Caddy hands the fault server marked `X-E2E-Site: pages`), so a
 * link to it is outside the app. A test scripts what each path answers; any
 * other path gets a page that prints its own path, query and fragment.
 *
 *   PUT /__e2e/pages            { [path]: PageScript } replaces the script
 *   GET /__e2e/pages/requests?since=<ms>  { requests } the pages served since
 */
export const PAGES_SITE_HEADER = 'x-e2e-site'

export interface PageScript {
  /** The content type, `text/html; charset=utf-8` when absent. */
  type?: string
  body: string
  /** `base64` for a binary body (an image), sent decoded; text by default. */
  encoding?: 'base64'
  /** Added to the response, so one path can allow a cross-origin read and another not. */
  headers?: Record<string, string>
  /** Holds a GET this long before answering. */
  holdMs?: number
  /**
   * Keys each held GET by its `?probe=` value: a HEAD with that value answers
   * 204 while the GET is held and 404 otherwise.
   */
  probe?: boolean
}

export interface PageRequest {
  at: number
  method: string
  path: string
  query: string
  probe?: string
}

/** What the default page shows: the address the browser really opened, fragment included. */
export const DEFAULT_PAGE =
  '<!doctype html><meta name="viewport" content="width=device-width"><title>Chat link destination</title><h1>Opened chat link</h1><p id="address"></p><script>document.querySelector("p").textContent = location.pathname + location.search + location.hash</script>'

const MAX_HOLD_MS = 120_000
const MAX_HELD = 64

/** Why a script cannot be followed, or undefined when it can. */
export function scriptProblem(body: unknown): string | undefined {
  if (body == null || typeof body !== 'object' || Array.isArray(body)) {
    return 'the script is an object of paths'
  }
  for (const [path, page] of Object.entries(body as Record<string, unknown>)) {
    if (!path.startsWith('/')) return `${path}: a path starts with /`
    if (page == null || typeof page !== 'object') {
      return `${path}: a page is an object`
    }
    const {
      type,
      body: text,
      headers,
      holdMs,
      encoding,
      probe
    } = page as Record<string, unknown>
    if (typeof text !== 'string') return `${path}: body is a string`
    if (type != null && typeof type !== 'string') {
      return `${path}: type is a string`
    }
    if (
      headers != null &&
      (typeof headers !== 'object' ||
        Object.values(headers).some(value => typeof value !== 'string'))
    ) {
      return `${path}: headers are strings`
    }
    if (
      holdMs != null &&
      (typeof holdMs !== 'number' || holdMs < 0 || holdMs > MAX_HOLD_MS)
    ) {
      return `${path}: holdMs is 0 to ${MAX_HOLD_MS}`
    }
    if (encoding != null && encoding !== 'base64') {
      return `${path}: encoding is base64 or absent`
    }
    if (probe != null && typeof probe !== 'boolean') {
      return `${path}: probe is true or false`
    }
  }
  return undefined
}

export class PagesStandIn {
  private script: Record<string, PageScript> = {}
  /** Files the stack made for a test to fetch (`remux`'s programme), by path. */
  private readonly files = new Map<string, { file: string; type: string }>()
  /** The probes of the GETs being held now. */
  private readonly held = new Set<string>()
  readonly requests: PageRequest[] = []

  constructor(private readonly now: () => number = Date.now) {}

  setScript(script: Record<string, PageScript>): void {
    this.script = { ...script }
  }

  /** Serves a file on this machine at `path`, until the server stops; a script cannot. */
  serveFile(path: string, file: string, type: string): void {
    this.files.set(path, { file, type })
  }

  view(): { paths: string[] } {
    return { paths: Object.keys(this.script).sort() }
  }

  since(at: number): PageRequest[] {
    return this.requests.filter(row => row.at >= at)
  }

  /** Answers one request to the pages site. */
  serve(req: IncomingMessage, res: ServerResponse): void {
    const url = new URL(req.url ?? '/', 'http://pages')
    const method = req.method ?? 'GET'
    const probe = url.searchParams.get('probe') ?? undefined
    this.requests.push({
      at: this.now(),
      method,
      path: url.pathname,
      query: url.search,
      ...(probe == null ? {} : { probe })
    })
    const served = this.files.get(url.pathname)
    if (served != null && (method === 'GET' || method === 'HEAD')) {
      res.writeHead(200, {
        'content-type': served.type,
        'content-length': String(statSync(served.file).size),
        'cache-control': 'no-store'
      })
      if (method === 'HEAD') res.end()
      else createReadStream(served.file).pipe(res)
      return
    }
    const page = this.script[url.pathname]
    if (page?.probe === true && method === 'HEAD') {
      res.writeHead(probe != null && this.held.has(probe) ? 204 : 404)
      res.end()
      return
    }
    if (method !== 'GET' && method !== 'HEAD') {
      res.writeHead(405, { allow: 'GET, HEAD' })
      res.end()
      return
    }
    const answer = (): void => {
      res.writeHead(200, {
        'content-type': page?.type ?? 'text/html; charset=utf-8',
        'cache-control': 'no-store',
        ...(page?.headers ?? {})
      })
      const body =
        page == null
          ? DEFAULT_PAGE
          : page.encoding === 'base64'
            ? Buffer.from(page.body, 'base64')
            : page.body
      res.end(method === 'HEAD' ? undefined : body)
    }
    const holdMs = page?.holdMs ?? 0
    if (holdMs <= 0 || method === 'HEAD') {
      answer()
      return
    }
    if (page?.probe === true) {
      if (probe == null || this.held.has(probe) || this.held.size >= MAX_HELD) {
        res.writeHead(429)
        res.end()
        return
      }
      this.held.add(probe)
    }
    const timer = setTimeout(answer, holdMs)
    // A GET the client gave up on frees its probe at once.
    res.on('close', () => {
      clearTimeout(timer)
      if (probe != null) this.held.delete(probe)
    })
  }
}

/** Whether a request came in on the stack's pages site. */
export function isPagesRequest(req: IncomingMessage): boolean {
  return String(req.headers[PAGES_SITE_HEADER] ?? '').toLowerCase() === 'pages'
}
