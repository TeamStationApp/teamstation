import { expect } from 'chai'

import { serverSentEvents } from '../common/serverSentEvents'
import { userIdOfGumbo } from '../common/userId'
import { groupRoutes } from '../server/routes/groups'
import { tessRoutes } from '../server/routes/tess'
import type { TessSettings } from '../server/serverConfig'
import type { TessDeps, TessUser } from '../server/tess/agent'
import {
  type AccountHarness,
  accountHarness,
  type MountExtra
} from './accountHarness'
import { sseText } from './anthropicStream'

/**
 * Tess's tests without the model: a scripted Messages API answering through
 * an injected `fetch`, and a harness with the real API, the group routes for
 * a write to confirm, and Tess's routes calling it back over loopback. A
 * request with `stream: true` is answered as the provider streams, from the
 * same script.
 */

export const TEST_SETTINGS: TessSettings = {
  apiKey: 'test-key-placeholder',
  baseUrl: 'http://model.example.test/v1',
  model: 'claude-sonnet-5-5'
}

/** One event of a streamed turn, as the route sent it. */
export interface TurnStreamEvent {
  event: string
  data: any
}

/**
 * Sends a streamed turn's request and reads its events, comments as
 * `comment`, until the server ends the stream. `onEvent` hears each as it
 * comes.
 */
export async function readTurnStream(
  response: Response,
  onEvent: (event: TurnStreamEvent) => void = () => undefined
): Promise<TurnStreamEvent[]> {
  const events: TurnStreamEvent[] = []
  const decoder = new TextDecoder()
  const reader = response.body!.getReader()
  const sse = serverSentEvents()
  for (;;) {
    const chunk = await reader.read()
    if (chunk.done) break
    for (const read of sse.push(
      decoder.decode(chunk.value, { stream: true })
    )) {
      const event =
        read.data == null
          ? { event: 'comment', data: read.comment }
          : { event: read.event, data: JSON.parse(read.data) }
      events.push(event)
      onEvent(event)
    }
  }
  return events
}

/** One request the fake model received: its endpoint and JSON body. */
export interface ModelCall {
  path: string
  body: Record<string, any>
}

export interface Usage {
  input_tokens?: number
  output_tokens?: number
  cache_creation_input_tokens?: number
  cache_read_input_tokens?: number
}

/**
 * A scripted answer, or a function of the request that makes one, at once or
 * when the test lets it.
 */
export type Reply =
  | { content: unknown[]; stop_reason?: string; usage?: Usage }
  | { status: number; error: string; message?: string }
  /** A streamed answer's body exactly as given, events and all. */
  | { sse: string }
  | ((body: Record<string, any>) => Reply | Promise<Reply>)

export interface FakeModel {
  fetch: typeof fetch
  calls: ModelCall[]
  /** The bodies sent to `/messages`, oldest first. */
  messageCalls: () => Array<Record<string, any>>
  reply: (...replies: Reply[]) => void
  /** What the next `count_tokens` calls answer; 1,000 once none is left. */
  count: (...tokens: number[]) => void
  /** Replies not yet used. */
  pending: () => number
  /** Forgets every call, and every reply and count not yet used. */
  reset: () => void
}

let toolIds = 0

/** A text answer. */
export const say = (text: string, usage: Usage = {}): Reply => ({
  content: [{ type: 'text', text }],
  stop_reason: 'end_turn',
  usage: { input_tokens: 1000, output_tokens: 20, ...usage }
})

/** The provider refusing a request longer than its window. */
export const TOO_LONG: Reply = {
  status: 400,
  error: 'invalid_request_error',
  message: 'prompt is too long: 201234 tokens > 200000 maximum'
}

/** An answer asking for these tools, with a little text before them. */
export const callTools = (
  calls: Array<{ name: string; input: unknown; id?: string }>,
  usage: Usage = {}
): Reply => ({
  content: [
    { type: 'text', text: 'Let me check.' },
    ...calls.map(call => ({
      type: 'tool_use',
      id: call.id ?? `toolu_${(toolIds += 1)}`,
      name: call.name,
      input: call.input
    }))
  ],
  stop_reason: 'tool_use',
  usage: { input_tokens: 1000, output_tokens: 30, ...usage }
})

export function fakeModel(): FakeModel {
  const calls: ModelCall[] = []
  const replies: Reply[] = []
  const counts: number[] = []
  const answer = async (
    reply: Reply,
    body: Record<string, any>
  ): Promise<Response> => {
    if (typeof reply === 'function')
      return await answer(await reply(body), body)
    if ('status' in reply)
      return new Response(
        JSON.stringify({
          type: 'error',
          error: { type: reply.error, message: reply.message }
        }),
        { status: reply.status }
      )
    if ('sse' in reply)
      return new Response(reply.sse, {
        status: 200,
        headers: { 'content-type': 'text/event-stream' }
      })
    const message = {
      id: 'msg_test',
      type: 'message',
      role: 'assistant',
      content: reply.content as Array<Record<string, unknown>>,
      stop_reason: reply.stop_reason ?? 'end_turn',
      usage: { input_tokens: 1000, output_tokens: 20, ...reply.usage }
    }
    if (body.stream === true)
      return new Response(sseText(message), {
        status: 200,
        headers: { 'content-type': 'text/event-stream' }
      })
    return new Response(JSON.stringify(message), { status: 200 })
  }
  const fake = (async (url: unknown, init?: { body?: string }) => {
    const path = new URL(String(url)).pathname.replace(/^\/v1/, '')
    const body = JSON.parse(init?.body ?? '{}') as Record<string, any>
    calls.push({ path, body })
    if (path === '/messages/count_tokens')
      return new Response(
        JSON.stringify({ input_tokens: counts.shift() ?? 1000 }),
        { status: 200 }
      )
    return await answer(replies.shift() ?? say('(no scripted reply)'), body)
  }) as unknown as typeof fetch
  return {
    fetch: fake,
    calls,
    messageCalls: () =>
      calls.filter(call => call.path === '/messages').map(call => call.body),
    reply: (...more) => replies.push(...more),
    count: (...more) => counts.push(...more),
    pending: () => replies.length,
    reset: () => {
      calls.length = 0
      replies.length = 0
      counts.length = 0
    }
  }
}

export interface TessWorld {
  h: AccountHarness
  model: FakeModel
  /** The harness's user 101 or 102, as their id. */
  userId: (gumbo: number) => string
  /** User 101 or 102 as Tess answers them, with their bearer token. */
  user: (gumbo: number) => TessUser
  deps: () => TessDeps
  /** Moves Tess's clock; undefined goes back to the real one. */
  setNow: (now: Date | undefined) => void
  close: () => Promise<void>
}

/**
 * The account harness with Tess mounted. Her routes learn the harness's
 * origin only once it listens, through the getter they are built with.
 */
export async function tessWorld(
  options: {
    settings?: TessSettings | null
    mountExtra?: MountExtra
    /** How often a streamed turn sends its keep-alive comment. */
    keepAliveMs?: number
  } = {}
): Promise<TessWorld> {
  const model = fakeModel()
  let origin = ''
  let now: Date | undefined
  const settings =
    options.settings === undefined ? TEST_SETTINGS : options.settings
  const h = await accountHarness(
    undefined,
    undefined,
    '127.0.0.1',
    (app, fixture) => {
      const { db, media } = fixture
      app.use('/api/v1', groupRoutes(db, media))
      app.use(
        '/api/v1',
        tessRoutes(db, {
          settings,
          origin: () => origin,
          fetch: model.fetch,
          now: () => now ?? new Date(),
          keepAliveMs: options.keepAliveMs
        })
      )
      options.mountExtra?.(app, fixture)
    }
  )
  origin = h.origin
  const userId = (gumbo: number): string => userIdOfGumbo(gumbo)
  return {
    h,
    model,
    userId,
    user: gumbo => ({
      userId: userId(gumbo),
      isAdmin: false,
      credentials: { authorization: `Bearer ${h.tokens.get(gumbo) ?? ''}` }
    }),
    deps: () => ({
      db: h.db,
      settings: settings ?? TEST_SETTINGS,
      origin: () => origin,
      fetch: model.fetch,
      now: () => now ?? new Date()
    }),
    setNow: value => {
      now = value
    },
    close: async () => {
      await h.close()
    }
  }
}

type Block = Record<string, any>
interface Message {
  role: string
  content: Block[]
}

/**
 * A request the model accepts: it starts with the person's text, roles
 * alternate, and every tool call is answered in the very next message, by
 * results that answer nothing else.
 */
export function expectValidRequest(messages: Message[]): void {
  expect(messages[0].role).equals('user')
  expect(messages[0].content.some(block => block.type === 'text')).equals(true)
  messages.forEach((message, at) => {
    if (at > 0) expect(message.role).not.equals(messages[at - 1].role)
    const results = message.content
      .filter(block => block.type === 'tool_result')
      .map(block => block.tool_use_id as string)
    const asked =
      at === 0
        ? []
        : messages[at - 1].content
            .filter(block => block.type === 'tool_use')
            .map(block => block.id as string)
    if (message.role === 'user') expect(results).deep.equals(asked)
    for (const block of message.content) {
      expect(['text', 'image', 'tool_use', 'tool_result', 'thinking']).includes(
        block.type
      )
      // The Messages API refuses a text block of nothing but white space.
      if (block.type === 'text')
        expect(String(block.text).trim(), 'an empty text block').not.equals('')
    }
  })
}
