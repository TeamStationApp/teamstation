import { expect } from 'chai'
import { describe, it } from 'mocha'

import { ACTION_TYPES, toolSchema } from '../../common/scoring/actions'
import { DICTATION_VOCABULARY } from '../../common/scoring/vocabulary'
import {
  ASK_SCORER,
  asOpenAiTools,
  gamePrompt,
  Interpretation,
  type InterpreterConfig,
  systemPrompt
} from './interpreter'

interface Sent {
  url: string
  body: {
    model: string
    temperature: number
    parallel_tool_calls: boolean
    tool_choice: string
    tools: Array<{ function: { name: string } }>
    messages: Array<{
      role: string
      content?: string | null
      tool_call_id?: string
    }>
  }
  headers: Record<string, string>
}

function call(id: string, name: string, args: unknown): object {
  return {
    id,
    type: 'function',
    function: {
      name,
      arguments: typeof args === 'string' ? args : JSON.stringify(args)
    }
  }
}

/** A provider that answers each request with the next canned reply. */
function provider(
  ...replies: Array<object | { status: number; text: string } | Error>
): { fetch: typeof fetch; sent: Sent[] } {
  const sent: Sent[] = []
  const fake = async (url: unknown, init?: RequestInit): Promise<Response> => {
    sent.push({
      url: String(url),
      body: JSON.parse(init?.body as string),
      headers: init?.headers as Record<string, string>
    })
    const next = replies.shift()
    if (next instanceof Error) throw next
    if (next != null && 'status' in next)
      return new Response(next.text, { status: next.status })
    return new Response(
      JSON.stringify({ choices: [{ message: { tool_calls: next ?? [] } }] }),
      { status: 200 }
    )
  }
  return { fetch: fake, sent }
}

function config(
  fetchImpl: typeof fetch,
  more: Partial<InterpreterConfig> = {}
): InterpreterConfig {
  return { apiKey: 'key', model: 'grok-4.7', fetch: fetchImpl, ...more }
}

describe('dictation interpreter', function () {
  it('offers the library tools as OpenAI functions, enums and all', function () {
    const tools = asOpenAiTools(toolSchema())
    expect(tools.map(tool => tool.function.name)).deep.equals([...ACTION_TYPES])
    for (const [i, tool] of toolSchema().entries()) {
      expect(tools[i].type).equals('function')
      expect(tools[i].function.description).equals(tool.description)
      expect(tools[i].function.parameters).deep.equals(tool.input_schema)
    }
  })

  it('restores the action type from the tool name before cleaning', async function () {
    const stub = provider([call('c1', 'pitch', { call: 'B' })])
    const turn = await new Interpretation(
      config(stub.fetch),
      'ctx',
      'ball'
    ).start()
    expect(turn).deep.equals({
      kind: 'actions',
      actions: [{ type: 'pitch', call: 'B' }],
      dropped: []
    })
  })

  it('keeps several actions in order, and drops what the library refuses', async function () {
    const stub = provider([
      call('c1', 'pitch', { call: 'C' }),
      call('c2', 'pitch', { call: 'Z' }),
      call('c3', 'nonsense', {}),
      call('c4', 'pitch', 'not json'),
      call('c5', 'pitch', { call: 'S' })
    ])
    const turn = await new Interpretation(
      config(stub.fetch),
      'ctx',
      'x'
    ).start()
    expect(turn.kind).equals('actions')
    if (turn.kind !== 'actions') return
    expect(turn.actions).deep.equals([
      { type: 'pitch', call: 'C' },
      { type: 'pitch', call: 'S' }
    ])
    expect(turn.dropped.map(p => p.code)).deep.equals([
      'malformed',
      'unknownAction',
      'malformed'
    ])
  })

  it('says why when nothing usable comes back', async function () {
    const none = provider([])
    expect(
      await new Interpretation(config(none.fetch), 'ctx', 'hello').start()
    ).deep.equals({
      kind: 'error',
      message: 'Nothing to score in "hello"'
    })
    const bad = provider([call('c1', 'pitch', { call: 'Z' })])
    const turn = await new Interpretation(config(bad.fetch), 'ctx', 'x').start()
    expect(turn.kind).equals('error')
    expect(turn.kind === 'error' && turn.message).match(
      /^Nothing usable came back: pitch/
    )
  })

  it('sends the context, the vocabulary and the rules, with the right request', async function () {
    const stub = provider([call('c1', 'pitch', { call: 'B' })])
    await new Interpretation(
      config(stub.fetch),
      'Top of the 1st.',
      'ball'
    ).start()
    const sent = stub.sent[0]
    expect(sent.url).equals('https://api.x.ai/v1/chat/completions')
    expect(sent.headers.Authorization).equals('Bearer key')
    expect(sent.body.model).equals('grok-4.7')
    expect(sent.body.temperature).equals(0)
    expect(sent.body.parallel_tool_calls).equals(true)
    expect(sent.body.tool_choice).equals('required')
    expect(sent.body.tools.map(t => t.function.name)).deep.equals([
      ...ACTION_TYPES,
      'askScorer'
    ])
    const system = sent.body.messages[0].content ?? ''
    // The system prompt is the same for every sentence, so a provider can
    // cache it with the tools; the game and the words follow it.
    expect(system).equals(systemPrompt())
    expect(system).not.includes('Top of the 1st.')
    expect(sent.body.messages.slice(1)).deep.equals([
      { role: 'system', content: gamePrompt('Top of the 1st.') },
      { role: 'user', content: 'ball' }
    ])
    expect(gamePrompt('X')).equals('GAME\nX')
    // Only what was said, every call a tool call.
    expect(system).includes('it is not a list of events')
    expect(system).includes('never call pitch once for each of its codes')
    expect(system).includes('Never write a call, or its JSON')
    expect(system).includes(DICTATION_VOCABULARY)
    expect(system).match(/Never call gameFlow with kind closePlay/)
    // With no cache key, no routing hint.
    expect(sent.headers).not.to.have.property('x-grok-conv-id')
    expect(sent.body).not.to.have.property('prompt_cache_key')
    // "Number six" is a shirt; digits in a chain are positions.
    expect(system).includes('is the player the game lists as #6')
    expect(system).match(
      /barely use position numbers[^]*double play[^]*6 shortstop/
    )
    expect(system).includes('Read every other number\n  as a jersey.')
    // The game finishes a play by rule; the LLM does not ask about it.
    expect(system).includes('Leave fielders off an out nobody described')
    expect(system).match(
      /On a fielder's choice, send the ball in play and the result/
    )
  })

  it('offers a scope’s own tools when it has them', async function () {
    const stub = provider([call('c1', 'pitch', { call: 'B' })])
    const tools = toolSchema().filter(tool => tool.name === 'pitch')
    await new Interpretation(config(stub.fetch, { tools }), 'c', 'ball').start()
    expect(stub.sent[0].body.tools.map(t => t.function.name)).deep.equals([
      'pitch',
      'askScorer'
    ])
  })

  it('names the provider when it fails, is refused, or is too slow', async function () {
    const refused = provider({ status: 429, text: 'slow down' })
    expect(
      await new Interpretation(config(refused.fetch), 'c', 'x').start()
    ).deep.equals({
      kind: 'error',
      message: 'api.x.ai answered 429: slow down'
    })

    const broken = provider({ status: 503, text: 'down' })
    const five = await new Interpretation(
      config(broken.fetch, { baseUrl: 'https://llm.example/v1' }),
      'c',
      'x'
    ).start()
    expect(five).deep.equals({
      kind: 'error',
      message: 'llm.example answered 503: down'
    })

    const gone = provider(new Error('ECONNREFUSED'))
    const unreached = await new Interpretation(
      config(gone.fetch, { baseUrl: 'not a url' }),
      'c',
      'x'
    ).start()
    expect(unreached.kind === 'error' && unreached.message).equals(
      'not a url could not be reached: ECONNREFUSED'
    )

    const hanging = (async (_url: unknown, init?: RequestInit) =>
      await new Promise((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => {
          reject(new Error('aborted'))
        })
      })) as typeof fetch
    const late = await new Interpretation(
      config(hanging, { deadlineMs: 20 }),
      'c',
      'x'
    ).start()
    expect(late).deep.equals({
      kind: 'error',
      message: 'api.x.ai gave no answer within 0s'
    })
  })

  it('passes on what the LLM wrote when it called no tool', async function () {
    const talking = (async () =>
      new Response(
        JSON.stringify({
          choices: [
            {
              message: { content: ' Which ball do you mean? ', tool_calls: [] }
            }
          ]
        }),
        { status: 200 }
      )) as unknown as typeof fetch
    expect(
      await new Interpretation(config(talking), 'c', 'Ball.').start()
    ).deep.equals({
      kind: 'error',
      message: 'Nothing to score in "Ball.": Which ball do you mean?'
    })
  })

  it('reads a reply with no choices as no calls', async function () {
    const empty = (async () =>
      new Response(JSON.stringify({}), {
        status: 200
      })) as unknown as typeof fetch
    const turn = await new Interpretation(config(empty), 'c', 'x').start()
    expect(turn.kind).equals('error')
  })

  describe('askScorer', function () {
    const ball = { type: 'pitch', call: 'B' }
    const ask = (options: unknown, question = 'Which Chase?'): object =>
      call('q1', 'askScorer', { question, options })

    it('is offered beside the library tools and never reaches cleanAction', async function () {
      expect(ASK_SCORER.function.name).equals('askScorer')
      const stub = provider([
        ask([{ label: 'Chase L.' }, { label: 'Chase M.' }])
      ])
      const turn = await new Interpretation(
        config(stub.fetch),
        'c',
        'Chase singled'
      ).start()
      expect(turn).deep.equals({
        kind: 'ask',
        question: 'Which Chase?',
        options: [{ label: 'Chase L.' }, { label: 'Chase M.' }]
      })
    })

    it('keeps an option’s actions only when they all clean', async function () {
      const stub = provider([
        ask([
          { label: 'A ball', actions: [ball] },
          { label: 'Half good', actions: [ball, { type: 'pitch', call: 'Z' }] },
          { label: 'No actions', actions: [] },
          { label: '' },
          'not an object'
        ])
      ])
      const turn = await new Interpretation(
        config(stub.fetch),
        'c',
        'x'
      ).start()
      expect(turn).deep.equals({
        kind: 'ask',
        question: 'Which Chase?',
        options: [
          { label: 'A ball', actions: [ball] },
          { label: 'Half good' },
          { label: 'No actions' }
        ]
      })
    })

    it('caps a question at five options', async function () {
      const seven = Array.from({ length: 7 }, (_, i) => ({
        label: `option ${i}`
      }))
      const stub = provider([ask(seven)])
      const turn = await new Interpretation(
        config(stub.fetch),
        'c',
        'x'
      ).start()
      expect(turn.kind === 'ask' && turn.options).to.have.length(5)
    })

    it('refuses a question with nothing to choose', async function () {
      const stub = provider([ask([]), ask([{ label: 'a' }], '  ')])
      expect(
        (await new Interpretation(config(stub.fetch), 'c', 'x').start()).kind
      ).equals('error')
      expect(
        (await new Interpretation(config(stub.fetch), 'c', 'x').start()).kind
      ).equals('error')
      const garbled = provider([call('q1', 'askScorer', 'nope')])
      expect(
        (await new Interpretation(config(garbled.fetch), 'c', 'x').start()).kind
      ).equals('error')
    })

    it('answers with an option’s actions and calls nobody', async function () {
      const stub = provider([
        ask([{ label: 'A ball', actions: [ball] }, { label: 'Other' }])
      ])
      const it = new Interpretation(config(stub.fetch), 'c', 'x')
      await it.start()
      expect(it.asking).equals(true)
      expect(await it.answer(0)).deep.equals({
        kind: 'actions',
        actions: [ball],
        dropped: []
      })
      expect(stub.sent).to.have.length(1)
      expect(it.asking).equals(false)
    })

    it('puts a plain answer back to the LLM as the question’s result', async function () {
      const stub = provider(
        [
          call('other', 'pitch', { call: 'C' }),
          ask([{ label: 'Chase L.' }, { label: 'Chase M.' }])
        ],
        [call('c2', 'result', { eventType: 'single' })]
      )
      const it = new Interpretation(config(stub.fetch), 'c', 'Chase singled')
      await it.start()
      const turn = await it.answer(1)
      expect(turn).deep.equals({
        kind: 'actions',
        actions: [{ type: 'result', eventType: 'single' }],
        dropped: []
      })
      const second = stub.sent[1].body.messages
      expect(second.slice(-2)).deep.equals([
        {
          role: 'assistant',
          content: null,
          tool_calls: [
            call('q1', 'askScorer', {
              question: 'Which Chase?',
              options: [{ label: 'Chase L.' }, { label: 'Chase M.' }]
            })
          ]
        },
        { role: 'tool', tool_call_id: 'q1', content: 'Chase M.' }
      ])
    })

    it('refuses an answer with no question open or no such option', async function () {
      const stub = provider([ask([{ label: 'a' }])])
      const it = new Interpretation(config(stub.fetch), 'c', 'x')
      expect(await it.answer(0)).deep.equals({
        kind: 'error',
        message: 'No question is open'
      })
      await it.start()
      expect(await it.answer(4)).deep.equals({
        kind: 'error',
        message: 'There is no option 4'
      })
      expect(it.asking).equals(true)
    })

    it('gives up after a third question about one sentence', async function () {
      const stub = provider(
        [ask([{ label: 'a' }])],
        [ask([{ label: 'b' }])],
        [ask([{ label: 'c' }])]
      )
      const it = new Interpretation(config(stub.fetch), 'c', 'x')
      expect((await it.start()).kind).equals('ask')
      expect((await it.answer(0)).kind).equals('ask')
      expect(await it.answer(0)).deep.equals({
        kind: 'error',
        message: 'The model asked more than 2 questions about one sentence'
      })
    })
  })
})

describe('dictation interpreter, cache routing', function () {
  it('sends a cache key as xAI’s routing header', async function () {
    const xai = provider([call('c1', 'pitch', { call: 'B' })])
    await new Interpretation(
      config(xai.fetch, { cacheKey: 'scorer-1' }),
      'ctx',
      'Ball.'
    ).start()
    expect(xai.sent[0].headers['x-grok-conv-id']).equals('scorer-1')
    expect(xai.sent[0].body).not.to.have.property('prompt_cache_key')
  })
})
