import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { expect } from 'chai'
import { describe, it } from 'mocha'

import { HttpError } from '../../common/errors'
import { userIdOfGumbo } from '../../common/userId'
import { startServerLogging } from '../observability/logging'
import type { TessSettings } from '../serverConfig'
import {
  ANTHROPIC_VERSION,
  type ContentBlock,
  countTokens,
  createMessage,
  isTooLarge,
  isTooLong,
  MAX_TOKENS,
  type MessagesRequest
} from './messagesApi'

const SETTINGS: TessSettings = {
  apiKey: 'tess-placeholder-key',
  baseUrl: 'https://anthropic.example.test/v1/',
  model: 'claude-sonnet-5-5'
}

const REQUEST: MessagesRequest = {
  system: [
    { text: 'You are Tess.', cached: true },
    { text: '{"routes":[]}', cached: true },
    { text: 'The user is Tony Gwynn.' }
  ],
  messages: [{ role: 'user', content: 'Where is our schedule?' }],
  tools: [
    {
      name: 'api_get',
      description: 'Read the API',
      input_schema: { type: 'object', properties: { path: { type: 'string' } } }
    }
  ]
}

/** What the provider answers for a message. */
const ANSWER = {
  id: 'msg_01',
  type: 'message',
  role: 'assistant',
  content: [
    { type: 'text', text: 'Let me look.' },
    {
      type: 'tool_use',
      id: 'toolu_01',
      name: 'api_get',
      input: { path: '/me' }
    }
  ],
  stop_reason: 'tool_use',
  usage: {
    input_tokens: 120,
    cache_creation_input_tokens: 9000,
    cache_read_input_tokens: 400,
    output_tokens: 75
  }
}

interface Sent {
  url: string
  headers: Headers
  body: Record<string, unknown>
}

/** A fetch answering each call from the list, and keeping what was sent. */
function provider(...answers: Array<() => Response | Promise<Response>>): {
  fetch: typeof fetch
  sent: Sent[]
} {
  const sent: Sent[] = []
  return {
    sent,
    fetch: async (url, init) => {
      sent.push({
        url: url as string,
        headers: new Headers(init?.headers),
        body: JSON.parse(init?.body as string)
      })
      const answer = answers.shift()
      if (answer == null) throw new Error('No answer scripted')
      return await answer()
    }
  }
}

const json =
  (body: unknown, status = 200) =>
  () =>
    new Response(typeof body === 'string' ? body : JSON.stringify(body), {
      status,
      headers: { 'content-type': 'application/json' }
    })

/** The error a promise rejects with. */
async function failure(promise: Promise<unknown>): Promise<HttpError> {
  try {
    await promise
  } catch (error) {
    expect(error).instanceOf(HttpError)
    return error as HttpError
  }
  throw new Error('Expected a rejection')
}

describe('Tess Messages API client', function () {
  it('sends the key, the version, the model and the cached blocks, and maps the answer', async () => {
    const { fetch, sent } = provider(json(ANSWER))
    const response = await createMessage(SETTINGS, REQUEST, { fetch })
    expect(sent).length(1)
    const [call] = sent
    expect(call.url).equals('https://anthropic.example.test/v1/messages')
    expect(call.headers.get('x-api-key')).equals('tess-placeholder-key')
    expect(call.headers.get('anthropic-version')).equals(ANTHROPIC_VERSION)
    expect(call.headers.get('anthropic-beta')).equals(
      'thinking-binding-controls-2026-08-01'
    )
    expect(call.headers.get('content-type')).equals('application/json')
    expect(call.body).deep.equals({
      model: 'claude-sonnet-5-5',
      max_tokens: MAX_TOKENS,
      thinking: {
        type: 'adaptive',
        block_binding: { prefix_mismatch_behavior: 'drop_block' }
      },
      system: [
        {
          type: 'text',
          text: 'You are Tess.',
          cache_control: { type: 'ephemeral' }
        },
        {
          type: 'text',
          text: '{"routes":[]}',
          cache_control: { type: 'ephemeral' }
        },
        { type: 'text', text: 'The user is Tony Gwynn.' }
      ],
      messages: [{ role: 'user', content: 'Where is our schedule?' }],
      tools: REQUEST.tools,
      tool_choice: { type: 'auto' }
    })
    expect(MAX_TOKENS).equals(8192)
    expect(response).deep.equals({
      content: ANSWER.content,
      stopReason: 'tool_use',
      usage: {
        inputTokens: 120,
        cacheCreationInputTokens: 9000,
        cacheReadInputTokens: 400,
        outputTokens: 75
      }
    })
  })

  it('ends a cached prefix at the last block of the conversation when asked', async () => {
    const { fetch, sent } = provider(
      json(ANSWER),
      json(ANSWER),
      json({ input_tokens: 9000 })
    )
    // A turn's first call: the person's message is a string.
    await createMessage(
      SETTINGS,
      { ...REQUEST, cacheMessages: true },
      { fetch }
    )
    expect(sent[0].body.messages).deep.equals([
      {
        role: 'user',
        content: [
          {
            type: 'text',
            text: 'Where is our schedule?',
            cache_control: { type: 'ephemeral' }
          }
        ]
      }
    ])
    // A later round: the newest tool result ends the prefix, and nothing
    // before it is marked.
    const round: MessagesRequest = {
      ...REQUEST,
      cacheMessages: true,
      messages: [
        { role: 'user', content: [{ type: 'text', text: 'Where is it?' }] },
        { role: 'assistant', content: ANSWER.content as ContentBlock[] },
        {
          role: 'user',
          content: [
            { type: 'tool_result', tool_use_id: 'toolu_01', content: 'a' },
            { type: 'tool_result', tool_use_id: 'toolu_02', content: 'b' }
          ]
        }
      ]
    }
    await createMessage(SETTINGS, round, { fetch })
    await countTokens(SETTINGS, round, { fetch })
    for (const call of sent.slice(1)) {
      const messages = call.body.messages as Array<{ content: unknown[] }>
      expect(messages.slice(0, 2)).deep.equals(round.messages.slice(0, 2))
      expect(messages[2].content).deep.equals([
        { type: 'tool_result', tool_use_id: 'toolu_01', content: 'a' },
        {
          type: 'tool_result',
          tool_use_id: 'toolu_02',
          content: 'b',
          cache_control: { type: 'ephemeral' }
        }
      ])
    }
    // The caller's request is left as it was.
    expect(round.messages[2].content).deep.equals([
      { type: 'tool_result', tool_use_id: 'toolu_01', content: 'a' },
      { type: 'tool_result', tool_use_id: 'toolu_02', content: 'b' }
    ])
  })

  it('closes a round with tool_choice none, and sends no tools or choice without tools', async () => {
    const { fetch, sent } = provider(
      json(ANSWER),
      json(ANSWER),
      json({ ...ANSWER, usage: { input_tokens: 5, output_tokens: 2 } })
    )
    await createMessage(SETTINGS, { ...REQUEST, toolChoice: 'none' }, { fetch })
    expect(sent[0].body.tool_choice).deep.equals({ type: 'none' })
    expect(sent[0].body.tools).deep.equals(REQUEST.tools)

    await createMessage(
      SETTINGS,
      { system: REQUEST.system, messages: REQUEST.messages },
      { fetch }
    )
    const summary = await createMessage(
      SETTINGS,
      { ...REQUEST, tools: [], toolChoice: 'none' },
      { fetch }
    )
    for (const call of sent.slice(1)) {
      expect(call.body).not.has.property('tools')
      expect(call.body).not.has.property('tool_choice')
    }
    // Counts the provider leaves out read as none.
    expect(summary.usage).deep.equals({
      inputTokens: 5,
      cacheCreationInputTokens: 0,
      cacheReadInputTokens: 0,
      outputTokens: 2
    })
  })

  it('counts a request’s input tokens', async () => {
    const { fetch, sent } = provider(json({ input_tokens: 151234 }))
    expect(await countTokens(SETTINGS, REQUEST, { fetch })).equals(151234)
    expect(sent[0].url).equals(
      'https://anthropic.example.test/v1/messages/count_tokens'
    )
    expect(sent[0].headers.get('x-api-key')).equals('tess-placeholder-key')
    // count_tokens replays the same thinking blocks, so it drops a stale one
    // the same way rather than refusing the whole count.
    expect(sent[0].headers.get('anthropic-beta')).equals(
      'thinking-binding-controls-2026-08-01'
    )
    expect(sent[0].body).not.has.property('max_tokens')
    expect(sent[0].body).deep.include({
      model: 'claude-sonnet-5-5',
      thinking: {
        type: 'adaptive',
        block_binding: { prefix_mismatch_behavior: 'drop_block' }
      },
      messages: REQUEST.messages,
      tool_choice: { type: 'auto' }
    })

    for (const answer of [{}, { input_tokens: -1 }, { input_tokens: 'many' }]) {
      const bad = provider(json(answer))
      const error = await failure(
        countTokens(SETTINGS, REQUEST, { fetch: bad.fetch })
      )
      expect(error.status).equals(503)
      expect(error.message).equals("Tess's model sent an unreadable answer")
    }
  })

  it('names the provider’s status and error type, never its body', async () => {
    const canary = 'the request quoted back: private-canary'
    const { fetch } = provider(
      json(
        {
          type: 'error',
          error: { type: 'overloaded_error', message: canary }
        },
        529
      ),
      json({ type: 'error', error: { type: canary, message: canary } }, 400),
      json('<html>private-canary</html>', 502),
      json({ error: 'private-canary' }, 401)
    )
    const overloaded = await failure(
      createMessage(SETTINGS, REQUEST, { fetch })
    )
    expect(overloaded.status).equals(503)
    expect(overloaded.code).equals('unavailable')
    expect(overloaded.message).equals(
      "Tess's model answered 529 overloaded_error"
    )
    expect(overloaded.details).deep.equals({
      status: 529,
      type: 'overloaded_error'
    })
    for (const status of [400, 502, 401]) {
      const error = await failure(createMessage(SETTINGS, REQUEST, { fetch }))
      expect(error.message).equals(
        `Tess's model answered ${status} unknown_error`
      )
      expect(JSON.stringify(error.toApiError())).not.contains('private-canary')
    }
  })

  it('says when the provider refused the request for its length, and nothing of why', async () => {
    const { fetch } = provider(
      json(
        {
          type: 'error',
          error: {
            type: 'invalid_request_error',
            message: 'prompt is too long: 208114 tokens > 200000 maximum'
          }
        },
        400
      ),
      json(
        {
          type: 'error',
          error: {
            type: 'invalid_request_error',
            message:
              'input length and `max_tokens` exceed context limit: 195000 + 8192 > 200000, decrease input length or `max_tokens` and try again'
          }
        },
        400
      ),
      json(
        {
          type: 'error',
          error: {
            type: 'invalid_request_error',
            message: 'prompt is too long'
          }
        },
        413
      ),
      json(
        {
          type: 'error',
          error: { type: 'invalid_request_error', message: 'tools: bad schema' }
        },
        400
      )
    )
    for (const expected of [true, true, false, false]) {
      const error = await failure(createMessage(SETTINGS, REQUEST, { fetch }))
      expect(isTooLong(error)).equals(expected)
      expect(JSON.stringify(error.toApiError())).not.contains('208114')
      expect(JSON.stringify(error.toApiError())).not.contains('schema')
    }
    expect(isTooLong(new Error('prompt is too long'))).equals(false)
  })

  it('says when the provider refused the request for its bytes, from either endpoint', async () => {
    const tooLarge = json(
      {
        type: 'error',
        error: {
          type: 'request_too_large',
          message: 'Request exceeds the maximum allowed number of bytes.'
        }
      },
      413
    )
    const { fetch } = provider(
      tooLarge,
      tooLarge,
      json(
        {
          type: 'error',
          error: {
            type: 'invalid_request_error',
            message: 'prompt is too long: 208114 tokens > 200000 maximum'
          }
        },
        400
      )
    )
    const sent = await failure(createMessage(SETTINGS, REQUEST, { fetch }))
    expect(isTooLarge(sent)).equals(true)
    expect(isTooLong(sent)).equals(false)
    expect(sent.message).equals("Tess's model answered 413 request_too_large")
    expect(sent.details).deep.equals({
      status: 413,
      type: 'request_too_large',
      tooLarge: true
    })
    const counted = await failure(countTokens(SETTINGS, REQUEST, { fetch }))
    expect(isTooLarge(counted)).equals(true)
    const tooLong = await failure(createMessage(SETTINGS, REQUEST, { fetch }))
    expect(isTooLarge(tooLong)).equals(false)
    expect(isTooLarge(new Error('request_too_large'))).equals(false)
  })

  it('refuses an answer that is not a message', async () => {
    for (const body of [
      'not json',
      '[]',
      { content: 'text', stop_reason: 'end_turn', usage: {} },
      { content: [{ text: 'no type' }], stop_reason: 'end_turn', usage: {} },
      { content: [], stop_reason: null, usage: {} },
      { content: [], stop_reason: 'end_turn' }
    ]) {
      const { fetch } = provider(json(body))
      const error = await failure(createMessage(SETTINGS, REQUEST, { fetch }))
      expect(error.message, JSON.stringify(body)).equals(
        "Tess's model sent an unreadable answer"
      )
    }
  })

  it('gives up at the deadline, and says when the provider cannot be reached', async () => {
    const hanging: typeof fetch = async (_url, init) =>
      await new Promise<Response>((resolve, reject) => {
        init?.signal?.addEventListener('abort', () => {
          reject(new Error('aborted'))
        })
      })
    const late = await failure(
      createMessage(SETTINGS, REQUEST, { fetch: hanging, deadlineMs: 20 })
    )
    expect(late.status).equals(503)
    expect(late.message).equals("Tess's model gave no answer within 0s")

    const down = await failure(
      createMessage(SETTINGS, REQUEST, {
        fetch: async () => {
          throw new TypeError('fetch failed')
        }
      })
    )
    expect(down.message).equals("Tess's model could not be reached")
    const uncounted = await failure(
      countTokens(SETTINGS, REQUEST, { fetch: hanging, deadlineMs: 20 })
    )
    expect(uncounted.message).equals("Tess's model gave no answer within 0s")
  })

  it('logs each call as tess_request, with its tokens and never its text', async function () {
    this.timeout(15000)
    const directory = await mkdtemp(join(tmpdir(), 'tess-request-logs-'))
    const sent: string[] = []
    const stop = startServerLogging({
      directory,
      role: 'server',
      dsn: 'https://public@logs.example.test/1',
      writeToken: 'fixture-write-token'.repeat(3),
      request: async (_url, init) => {
        sent.push(init?.body as string)
        return new Response('', { status: 202 })
      }
    })
    const actor = userIdOfGumbo(4501)
    try {
      const { fetch } = provider(
        json(ANSWER),
        json({ type: 'error', error: { type: 'rate_limit_error' } }, 429),
        json({ error: {} }, 403),
        json({ error: {} }, 500),
        json('not json'),
        json({ content: [], usage: {} })
      )
      await createMessage(SETTINGS, REQUEST, { fetch, actor })
      for (let i = 0; i < 5; i += 1)
        await createMessage(SETTINGS, REQUEST, { fetch, actor }).catch(
          () => undefined
        )
      await createMessage(SETTINGS, REQUEST, {
        fetch: async () => {
          throw new TypeError('fetch failed')
        }
      }).catch(() => undefined)
      await stop()
      const rows = sent
        .join('')
        .trim()
        .split('\n')
        .map(line => JSON.parse(line))
        .filter(row => row.E === 'tess_request')
      expect(rows).length(7)
      const [ok, ...failed] = rows
      expect(ok.L).equals('info')
      expect(ok.U).equals(actor)
      expect(ok.P).deep.include({
        op: 'assistant',
        status: 200,
        it: 9520,
        ot: 75
      })
      expect(ok.P.ms).a('number')
      expect(ok.P).not.has.property('ec')
      expect(failed.map(row => [row.L, row.P.status, row.P.ec])).deep.equals([
        ['error', 429, 'rate_limited'],
        ['error', 403, 'permission'],
        ['error', 500, 'internal'],
        ['error', 200, 'invalid'],
        ['error', 200, 'invalid'],
        ['error', undefined, 'offline']
      ])
      expect(failed.every(row => row.P.it == null && row.P.ot == null)).equals(
        true
      )
      const text = sent.join('')
      expect(text).not.contains('Where is our schedule?')
      expect(text).not.contains('Let me look.')
      expect(text).not.contains('tess-placeholder-key')
    } finally {
      await stop()
      await rm(directory, { recursive: true, force: true })
    }
  })
})
