import { createServer, type IncomingMessage, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'

import { sseOf, streamEvents } from './anthropicStream'

/**
 * A stand-in for the Messages API, for Tess end to end: a real HTTP server
 * that the server's own client calls, answering from a script instead of a
 * model. Nothing leaves the machine and nothing is paid for.
 *
 * Each answer is chosen by the person's last message, the last user turn
 * whose words are theirs rather than a tool's result, and by how many of
 * Tess's answers already follow it in the request: the first answer of an
 * entry may call a tool, and the next one, sent with the tool's result,
 * replies. A request with no tools, a compaction summary or an attachment's
 * description, gets a plain sentence.
 *
 * A request with `stream: true`, as Tess's turns send, is answered as the
 * provider streams, with a short wait before each piece of thinking and
 * text, so an app shows them arriving; summaries and descriptions are not
 * streamed and are answered at once.
 *
 * Every request is kept, without the system prompt and the tool
 * definitions, which are the same each time, and served at
 * `GET /__tess/requests`.
 */

export type Block = Record<string, unknown>

export interface FakeMessage {
  role: 'user' | 'assistant'
  content: string | Block[]
}

/** What the server sent, as the test reads it back. */
export interface FakeRequest {
  messages: FakeMessage[]
  /** The tools offered, by name. */
  tools: string[]
  toolChoice?: unknown
  /** The person's words the answer was chosen by. */
  said: string
  /** Tess's answers already in the request after those words. */
  round: number
}

export interface FakeAnswer {
  content: Block[]
  stopReason?: 'end_turn' | 'tool_use'
}

export interface ScriptEntry {
  /** Matched against the person's words. */
  match: RegExp
  /** One answer per round, the last repeated for any later round. */
  rounds: Array<FakeAnswer | ((request: FakeRequest) => FakeAnswer)>
}

export interface FakeCall {
  path: string
  model?: string
  request?: FakeRequest
  /** How the answer ended: `tool_use` when it called a tool. */
  stopReason?: string
  /** It was asked for as a stream. */
  stream?: boolean
  usage?: { input_tokens: number; output_tokens: number }
}

export interface FakeAnthropic {
  /** The `baseUrl` Tess's settings point at, ending in `/v1`. */
  baseUrl: string
  calls: FakeCall[]
  /** Every `/messages` call's tokens, added up as the usage week stores them. */
  totals: () => { input: number; output: number; requests: number }
  setScript: (entries: ScriptEntry[]) => void
  close: () => Promise<void>
}

/** Each answer's tokens, the same every time so a test can add them up. */
export const FAKE_INPUT_TOKENS = 1200
export const FAKE_OUTPUT_TOKENS = 40

/** A text answer. */
export const text = (words: string): FakeAnswer => ({
  content: [{ type: 'text', text: words }],
  stopReason: 'end_turn'
})

let ids = 0
/** An answer calling one tool, with a sentence before it. */
export const tool = (
  name: string,
  input: Record<string, unknown>,
  words = 'Let me check.'
): FakeAnswer => ({
  content: [
    { type: 'text', text: words },
    { type: 'tool_use', id: `toolu_fake_${(ids += 1)}`, name, input }
  ],
  stopReason: 'tool_use'
})

/** `answer` with a summary of her thinking before it, signed as the provider signs. */
export const thought = (summary: string, answer: FakeAnswer): FakeAnswer => ({
  ...answer,
  content: [
    {
      type: 'thinking',
      thinking: summary,
      signature: `fake-signature-${(ids += 1)}`
    },
    ...answer.content
  ]
})

/** The answer when no entry matches: what Tess is for. */
export const FALLBACK =
  'I can help you find things and make changes in TeamStation.'

function blocks(content: string | Block[]): Block[] {
  return typeof content === 'string'
    ? [{ type: 'text', text: content }]
    : content
}

/** The person's last words in a request, and Tess's answers since. */
export function whatWasSaid(messages: FakeMessage[]): {
  said: string
  round: number
} {
  for (let at = messages.length - 1; at >= 0; at--) {
    const message = messages[at]
    if (message.role !== 'user') continue
    const content = blocks(message.content)
    if (content.some(block => block.type === 'tool_result')) continue
    const first = content.find(block => block.type === 'text')
    if (first == null) continue
    return {
      said: String(first.text),
      round: messages.slice(at + 1).filter(later => later.role === 'assistant')
        .length
    }
  }
  return { said: '', round: 0 }
}

/** The script's answer to one request. */
export function answerFor(
  entries: readonly ScriptEntry[],
  request: FakeRequest
): FakeAnswer {
  if (request.tools.length === 0)
    return text('A summary of the conversation so far.')
  const entry = entries.find(candidate => candidate.match.test(request.said))
  const choice = (request.toolChoice ?? {}) as { type?: string }
  if (entry == null || choice.type === 'none') return text(FALLBACK)
  const answer = entry.rounds[Math.min(request.round, entry.rounds.length - 1)]
  return typeof answer === 'function' ? answer(request) : answer
}

async function bodyOf(req: IncomingMessage): Promise<Record<string, any>> {
  const chunks: Buffer[] = []
  for await (const chunk of req) chunks.push(Buffer.from(chunk as Buffer))
  const raw = Buffer.concat(chunks).toString('utf8')
  return raw === '' ? {} : (JSON.parse(raw) as Record<string, any>)
}

/** The wait before each streamed piece of thinking or text, by default. */
export const STREAM_DELAY_MS = 60

export async function fakeAnthropic(
  options: {
    host?: string
    script?: ScriptEntry[]
    /** The wait before each streamed piece of thinking or text. */
    streamDelayMs?: number
  } = {}
): Promise<FakeAnthropic> {
  let script = options.script ?? []
  const delayMs = options.streamDelayMs ?? STREAM_DELAY_MS
  const calls: FakeCall[] = []
  const server: Server = createServer((req, res) => {
    const path = new URL(req.url ?? '/', 'http://fake.example.test').pathname
    const send = (status: number, value: unknown): void => {
      res.writeHead(status, { 'content-type': 'application/json' })
      res.end(JSON.stringify(value))
    }
    if (req.method === 'GET' && path === '/__tess/requests') {
      send(200, calls)
      return
    }
    if (req.method !== 'POST' || !path.startsWith('/v1/messages')) {
      send(404, { type: 'error', error: { type: 'not_found_error' } })
      return
    }
    bodyOf(req)
      .then(async body => {
        if (path === '/v1/messages/count_tokens') {
          calls.push({ path, model: body.model })
          send(200, { input_tokens: 2000 })
          return
        }
        const messages = (body.messages ?? []) as FakeMessage[]
        const request: FakeRequest = {
          messages,
          tools: ((body.tools ?? []) as Array<{ name: string }>).map(
            one => one.name
          ),
          ...(body.tool_choice == null ? {} : { toolChoice: body.tool_choice }),
          ...whatWasSaid(messages)
        }
        const answer = answerFor(script, request)
        const usage = {
          input_tokens: FAKE_INPUT_TOKENS,
          output_tokens: FAKE_OUTPUT_TOKENS
        }
        calls.push({
          path,
          model: body.model,
          request,
          stopReason: answer.stopReason ?? 'end_turn',
          usage,
          ...(body.stream === true ? { stream: true } : {})
        })
        const message = {
          id: `msg_fake_${calls.length}`,
          type: 'message',
          role: 'assistant',
          model: body.model,
          content: answer.content,
          stop_reason: answer.stopReason ?? 'end_turn',
          usage: {
            ...usage,
            cache_creation_input_tokens: 0,
            cache_read_input_tokens: 0
          }
        }
        if (body.stream !== true) {
          send(200, message)
          return
        }
        res.writeHead(200, {
          'content-type': 'text/event-stream',
          'cache-control': 'no-cache'
        })
        for (const event of streamEvents(message)) {
          if (event.type === 'content_block_delta' && delayMs > 0)
            await new Promise(resolve => setTimeout(resolve, delayMs))
          if (res.destroyed) return
          res.write(sseOf(event))
        }
        res.end()
      })
      .catch((error: unknown) => {
        send(400, {
          type: 'error',
          error: { type: 'invalid_request_error', message: String(error) }
        })
      })
  })
  const host = options.host ?? '127.0.0.1'
  server.listen(0, host)
  await new Promise<void>(resolve => server.once('listening', resolve))
  const { port } = server.address() as AddressInfo
  return {
    baseUrl: `http://${host}:${port}/v1`,
    calls,
    totals: () => {
      const answered = calls.filter(call => call.usage != null)
      return {
        input: answered.reduce(
          (sum, call) => sum + call.usage!.input_tokens,
          0
        ),
        output: answered.reduce(
          (sum, call) => sum + call.usage!.output_tokens,
          0
        ),
        requests: answered.length
      }
    },
    setScript: entries => {
      script = entries
    },
    close: async () => {
      await new Promise<void>((resolve, reject) => {
        server.close(error => {
          error == null ? resolve() : reject(error)
        })
        server.closeAllConnections()
      })
    }
  }
}
