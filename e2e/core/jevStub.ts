import type { IncomingMessage, ServerResponse } from 'node:http'

/**
 * The Jev stand-in a droplet stack runs on its Places stand-in's listener:
 * TypeSafe's System One API (`POST /v1/systemone`), which the stack's
 * `jev.baseUrl` points at. It answers every `noul` question from a script a
 * scenario sets through the fault server's `/__e2e/jev`, or passes the
 * request through to TypeSafe with the request's own Authorization.
 *
 * A question's noul is looked up by its id (`c1`, `l2`), then by the name of
 * the candidate or the label of the location it asks about, and is the
 * rule's `defaultNoul` (0.5) otherwise. A rule may instead answer with a
 * status, or wait before answering. A rule under `queries` applies to the
 * request whose `state.query` is that text, over the general one.
 *
 * Every request is kept, without its Authorization, for a scenario to read
 * back: its query, how many candidates it had, its status and model, how
 * long it took, and whether the caller gave up on it first.
 */
export const JEV_PATH = '/v1/systemone'

/** Where a pass-through request goes. */
export const TYPESAFE_ORIGIN = 'https://api.typesafe.ai'

/** The model a scripted answer names. */
export const JEV_STUB_MODEL = 'jev-e2e-stand-in'

/** The requests kept, newest last. */
export const JEV_REQUESTS_KEPT = 200

const BODY_MAX = 1 << 20
const DELAY_MAX_MS = 30000
const DEFAULT_NOUL = 0.5

export interface JevRule {
  /** Nouls by question id, candidate name or location label. */
  nouls?: Record<string, number>
  defaultNoul?: number
  /** Answers with this status and no answers. */
  status?: number
  /** Waits this long before answering. */
  delayMs?: number
}

export interface JevControl {
  /** Sends each request on to TypeSafe instead of answering it. */
  passThrough: boolean
  rule: JevRule
  /** Rules by `state.query`, over `rule`. */
  queries: Record<string, JevRule>
}

/** One request the stand-in was sent. */
export interface JevSeen {
  at: number
  query: string
  candidates: number
  status: number
  model?: string
  latencyMs: number
  /** The caller closed the request before it was answered. */
  aborted: boolean
  passedThrough: boolean
}

export interface JevView extends JevControl {
  requests: JevSeen[]
}

export const JEV_SCRIPT_DEFAULT: JevControl = {
  passThrough: false,
  rule: {},
  queries: {}
}

function isRecord(raw: unknown): raw is Record<string, unknown> {
  return raw != null && typeof raw === 'object' && !Array.isArray(raw)
}

function asRule(raw: unknown, where: string): JevRule {
  if (raw == null) return {}
  if (!isRecord(raw)) throw new Error(`${where} is not an object`)
  const rule: JevRule = {}
  const noul = (value: unknown, name: string): number => {
    if (typeof value !== 'number' || !(value >= 0 && value <= 1)) {
      throw new Error(`${name} is not a noul from 0 to 1`)
    }
    return value
  }
  if (raw.nouls != null) {
    if (!isRecord(raw.nouls)) throw new Error(`${where}.nouls is not an object`)
    rule.nouls = {}
    for (const [key, value] of Object.entries(raw.nouls)) {
      rule.nouls[key] = noul(value, `${where}.nouls["${key}"]`)
    }
  }
  if (raw.defaultNoul != null) {
    rule.defaultNoul = noul(raw.defaultNoul, `${where}.defaultNoul`)
  }
  if (raw.status != null) {
    const status = raw.status
    if (
      typeof status !== 'number' ||
      !Number.isInteger(status) ||
      status < 200 ||
      status > 599
    ) {
      throw new Error(`${where}.status is not an HTTP status`)
    }
    rule.status = status
  }
  if (raw.delayMs != null) {
    const delay = raw.delayMs
    if (typeof delay !== 'number' || !(delay >= 0 && delay <= DELAY_MAX_MS)) {
      throw new Error(`${where}.delayMs is not 0 to ${DELAY_MAX_MS}`)
    }
    rule.delayMs = delay
  }
  return rule
}

/** A control as `PUT /__e2e/jev` takes it; what it leaves out is the default. */
export function asJevControl(raw: unknown): JevControl {
  if (!isRecord(raw)) throw new Error('the Jev script is not an object')
  if (raw.passThrough != null && typeof raw.passThrough !== 'boolean') {
    throw new Error('passThrough is not true or false')
  }
  const queries: Record<string, JevRule> = {}
  if (raw.queries != null) {
    if (!isRecord(raw.queries)) throw new Error('queries is not an object')
    for (const [query, rule] of Object.entries(raw.queries)) {
      queries[query] = asRule(rule, `queries["${query}"]`)
    }
  }
  return {
    passThrough: raw.passThrough === true,
    rule: asRule(raw.rule, 'rule'),
    queries
  }
}

interface SystemOneBody {
  state?: {
    query?: unknown
    candidates?: Record<string, { name?: unknown }>
    locations?: Record<string, { label?: unknown }>
  }
  questions?: Record<string, unknown>
}

/** The answers a rule gives a request's questions. */
export function scriptedAnswers(
  body: SystemOneBody,
  rule: JevRule
): Record<string, { type: 'noul'; noul: number }> {
  const answers: Record<string, { type: 'noul'; noul: number }> = {}
  const nouls = rule.nouls ?? {}
  for (const id of Object.keys(body.questions ?? {})) {
    const name =
      body.state?.candidates?.[id]?.name ?? body.state?.locations?.[id]?.label
    const noul =
      nouls[id] ??
      (typeof name === 'string' ? nouls[name] : undefined) ??
      rule.defaultNoul ??
      DEFAULT_NOUL
    answers[id] = { type: 'noul', noul }
  }
  return answers
}

async function readBody(req: IncomingMessage): Promise<string> {
  return await new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    let size = 0
    req.on('data', (chunk: Buffer) => {
      size += chunk.length
      if (size > BODY_MAX) {
        reject(new Error('the body is too large'))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => {
      resolve(Buffer.concat(chunks).toString('utf8'))
    })
    req.on('error', reject)
  })
}

function send(res: ServerResponse, status: number, body: string): void {
  if (res.destroyed || res.headersSent) return
  res.writeHead(status, { 'content-type': 'application/json' })
  res.end(body)
}

export interface JevStubOptions {
  /** TypeSafe's origin, for pass-through. */
  upstream?: string
  fetchFn?: typeof fetch
  now?: () => number
}

export class JevStub {
  private control: JevControl = JEV_SCRIPT_DEFAULT
  private readonly requests: JevSeen[] = []
  private readonly upstream: string
  private readonly fetchFn: typeof fetch
  private readonly now: () => number

  constructor(options: JevStubOptions = {}) {
    this.upstream = (options.upstream ?? TYPESAFE_ORIGIN).replace(/\/$/, '')
    this.fetchFn = options.fetchFn ?? fetch
    this.now = options.now ?? Date.now
  }

  view(): JevView {
    return { ...this.control, requests: [...this.requests] }
  }

  /** Replaces the script and forgets the requests seen under the last one. */
  set(control: JevControl): JevView {
    this.control = control
    this.requests.length = 0
    return this.view()
  }

  private record(seen: JevSeen): void {
    this.requests.push(seen)
    if (this.requests.length > JEV_REQUESTS_KEPT) this.requests.shift()
  }

  /** Answers `POST /v1/systemone`. */
  handle(req: IncomingMessage, res: ServerResponse): void {
    const started = this.now()
    let closed = false
    res.on('close', () => {
      closed = !res.writableFinished
    })
    readBody(req).then(
      text => {
        this.answer(req, res, text, started, () => closed)
      },
      () => {
        send(res, 413, JSON.stringify({ error: 'the body is too large' }))
      }
    )
  }

  private answer(
    req: IncomingMessage,
    res: ServerResponse,
    text: string,
    started: number,
    closed: () => boolean
  ): void {
    if (req.method !== 'POST') {
      send(res, 405, JSON.stringify({ error: 'POST only' }))
      return
    }
    let body: SystemOneBody | undefined
    try {
      body = JSON.parse(text) as SystemOneBody
    } catch {
      body = undefined
    }
    const query = typeof body?.state?.query === 'string' ? body.state.query : ''
    const seen = (status: number, more: Partial<JevSeen> = {}): JevSeen => ({
      at: started,
      query,
      candidates: Object.keys(body?.state?.candidates ?? {}).length,
      status,
      latencyMs: this.now() - started,
      aborted: false,
      passedThrough: false,
      ...more
    })
    const control = this.control
    if (control.passThrough) {
      this.passThrough(req, res, text, seen)
      return
    }
    if (body?.questions == null || !isRecord(body.questions)) {
      this.record(seen(400))
      send(res, 400, JSON.stringify({ error: 'questions are required' }))
      return
    }
    const rule = { ...control.rule, ...control.queries[query] }
    const reply = (): void => {
      if (closed()) {
        this.record(seen(0, { aborted: true }))
        return
      }
      if (rule.status != null && rule.status !== 200) {
        this.record(seen(rule.status))
        send(
          res,
          rule.status,
          JSON.stringify({ error: `status ${rule.status}` })
        )
        return
      }
      const answers = scriptedAnswers(body, rule)
      this.record(seen(200, { model: JEV_STUB_MODEL }))
      send(
        res,
        200,
        JSON.stringify({
          model: JEV_STUB_MODEL,
          answers,
          usage: {
            input_tokens: text.length,
            output_tokens: Object.keys(answers).length
          }
        })
      )
    }
    if ((rule.delayMs ?? 0) <= 0) {
      reply()
      return
    }
    const timer = setTimeout(reply, rule.delayMs)
    // A caller that gives up is recorded at once, not when the wait ends.
    res.on('close', () => {
      if (!closed()) return
      clearTimeout(timer)
      reply()
    })
  }

  private passThrough(
    req: IncomingMessage,
    res: ServerResponse,
    text: string,
    seen: (status: number, more?: Partial<JevSeen>) => JevSeen
  ): void {
    const abort = new AbortController()
    res.on('close', () => {
      if (!res.writableFinished) abort.abort()
    })
    const authorization = req.headers.authorization
    this.fetchFn(`${this.upstream}${JEV_PATH}`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(authorization == null ? {} : { authorization })
      },
      body: text,
      signal: abort.signal
    })
      .then(async reply => {
        const answer = await reply.text()
        let model: string | undefined
        try {
          const parsed = JSON.parse(answer) as { model?: unknown }
          if (typeof parsed.model === 'string') model = parsed.model
        } catch {
          model = undefined
        }
        this.record(
          seen(reply.status, {
            passedThrough: true,
            ...(model == null ? {} : { model })
          })
        )
        send(res, reply.status, answer)
      })
      .catch((error: unknown) => {
        const aborted = abort.signal.aborted
        this.record(seen(aborted ? 0 : 502, { passedThrough: true, aborted }))
        send(
          res,
          502,
          JSON.stringify({
            error: `TypeSafe did not answer: ${error instanceof Error ? error.message : String(error)}`
          })
        )
      })
  }
}
