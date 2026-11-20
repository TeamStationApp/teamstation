import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse
} from 'node:http'
import type { AddressInfo } from 'node:net'

/**
 * A stand-in for TypeSafe's System One API (`POST /v1/systemone`), for the
 * search engine's tests: a real HTTP server on an OS-assigned port that the
 * server's own Jev client calls, answering every `noul` question from a
 * scripted map instead of a model. Nothing leaves the machine.
 *
 * A question's noul is looked up by its id (`c1`, `l2`), then by the name of
 * the candidate or the label of the location it asks about, and is
 * `defaultNoul` otherwise. It can instead fail with a status, wait before
 * answering, or answer with a body that does not read.
 *
 * Every request is kept, with its Authorization header, for a test to read
 * back.
 */

export const FAKE_JEV_MODEL = 'jev-1.13.0-fake'

export interface FakeJevRequest {
  method: string
  path: string
  authorization?: string
  contentType?: string
  body: {
    model?: string
    state?: {
      query?: string
      candidates?: Record<string, { name?: string }>
      locations?: Record<string, { label?: string }>
      [key: string]: unknown
    }
    questions?: Record<
      string,
      {
        type?: string
        instructions?: string
        criteria?: { true?: string; false?: string }
      }
    >
  }
}

/** How a malformed answer is broken. */
export type FakeJevMalformed =
  /** Not JSON at all. */
  | 'json'
  /** JSON with no `answers`. */
  | 'noAnswers'
  /** One question's answer left out. */
  | 'missing'
  /** A noul outside 0 to 1. */
  | 'range'

export interface FakeJev {
  /** The `jev.baseUrl` to point the server at. */
  baseUrl: string
  requests: FakeJevRequest[]
  /** Nouls by question id, candidate name or location label. */
  setNouls: (nouls: Record<string, number>, defaultNoul?: number) => void
  /** Answer every request with this status, until `reset`. */
  fail: (status: 401 | 429 | 500 | 529) => void
  /** Wait this long before answering each request. */
  delay: (ms: number) => void
  malformed: (how: FakeJevMalformed) => void
  /** Back to answering at once from an empty script. */
  reset: () => void
  close: () => Promise<void>
}

export async function fakeJev(): Promise<FakeJev> {
  let nouls: Record<string, number> = {}
  let defaultNoul = 0.5
  let failure: number | undefined
  let delayMs = 0
  let broken: FakeJevMalformed | undefined
  const requests: FakeJevRequest[] = []
  const pending = new Set<NodeJS.Timeout>()

  const noulFor = (
    id: string,
    state: FakeJevRequest['body']['state']
  ): number => {
    if (id in nouls) return nouls[id]
    const name = state?.candidates?.[id]?.name ?? state?.locations?.[id]?.label
    if (name != null && name in nouls) return nouls[name]
    return defaultNoul
  }

  const server: Server = createServer((req, res) => {
    readBody(req)
      .then(text => {
        let body: FakeJevRequest['body'] = {}
        try {
          body = JSON.parse(text) as FakeJevRequest['body']
        } catch {
          /* Kept as an empty body; answered 400 below. */
        }
        requests.push({
          method: req.method ?? '',
          path: req.url ?? '',
          authorization: req.headers.authorization,
          contentType: req.headers['content-type'],
          body
        })
        const answer = (): void => {
          if (req.method !== 'POST' || req.url !== '/v1/systemone') {
            send(res, 404, { error: 'not found' })
            return
          }
          if (failure != null) {
            send(res, failure, { error: `status ${failure}` })
            return
          }
          if (body.questions == null) {
            send(res, 400, { error: 'questions are required' })
            return
          }
          if (broken === 'json') {
            res.writeHead(200, { 'Content-Type': 'application/json' })
            res.end('{"model": "jev')
            return
          }
          if (broken === 'noAnswers') {
            send(res, 200, { model: FAKE_JEV_MODEL })
            return
          }
          const ids = Object.keys(body.questions)
          const answers: Record<string, { type: 'noul'; noul: number }> = {}
          // A missing answer leaves out the first question's.
          for (const id of broken === 'missing' ? ids.slice(1) : ids)
            answers[id] = { type: 'noul', noul: noulFor(id, body.state) }
          if (broken === 'range' && ids.length > 0)
            answers[ids[0]] = { type: 'noul', noul: 1.5 }
          send(res, 200, {
            model: FAKE_JEV_MODEL,
            answers,
            usage: { input_tokens: text.length, output_tokens: ids.length }
          })
        }
        if (delayMs <= 0) {
          answer()
          return
        }
        const timer = setTimeout(() => {
          pending.delete(timer)
          if (!res.destroyed) answer()
        }, delayMs)
        pending.add(timer)
        res.on('close', () => {
          clearTimeout(timer)
          pending.delete(timer)
        })
      })
      .catch(() => {
        res.destroy()
      })
  })
  await new Promise<void>(resolve => {
    server.listen(0, '127.0.0.1', resolve)
  })
  const { port } = server.address() as AddressInfo

  return {
    baseUrl: `http://127.0.0.1:${port}`,
    requests,
    setNouls(next, fallback = 0.5) {
      nouls = { ...next }
      defaultNoul = fallback
    },
    fail(status) {
      failure = status
    },
    delay(ms) {
      delayMs = ms
    },
    malformed(how) {
      broken = how
    },
    reset() {
      nouls = {}
      defaultNoul = 0.5
      failure = undefined
      delayMs = 0
      broken = undefined
      requests.length = 0
    },
    async close() {
      for (const timer of pending) clearTimeout(timer)
      pending.clear()
      server.closeAllConnections()
      await new Promise<void>(resolve => {
        server.close(() => {
          resolve()
        })
      })
    }
  }
}

async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = []
  for await (const chunk of req) chunks.push(chunk as Buffer)
  return Buffer.concat(chunks).toString('utf8')
}

function send(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'Content-Type': 'application/json' })
  res.end(JSON.stringify(body))
}
