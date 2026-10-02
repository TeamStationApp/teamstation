import { expect } from 'chai'
import { describe, it } from 'mocha'

import { ACTION_TYPES, toolSchema } from '../../common/scoring/actions'
import { DICTATION_VOCABULARY } from '../../common/scoring/vocabulary'
import {
  ASK_SCORER,
  asOpenAiTools,
  callsWrittenAsText,
  followUp,
  gamePrompt,
  Interpretation,
  type InterpreterConfig,
  MAX_FOLLOW_UPS,
  RESULT_MISSING,
  systemPrompt,
  UNDO
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
      'askScorer',
      'undo'
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
    // A ball in play comes with its result.
    expect(system).includes(
      '"pop up to the shortstop", "pops out to the second baseman"'
    )
    expect(system).includes('goes\n  alone, with no result')
    // Only what was said, every call a tool call, undo only when asked.
    expect(system).includes('it is not a list of events')
    expect(system).includes('never call pitch once for each of its codes')
    expect(system).includes('Never write a call, or its JSON')
    expect(system).match(
      /"caught stealing", "picked off",\s+"out" — never call undo/
    )
    expect(system).includes(DICTATION_VOCABULARY)
    expect(system).match(/Never call gameFlow with kind closePlay/)
    // With no cache key, no routing hint.
    expect(sent.headers).not.to.have.property('x-grok-conv-id')
    expect(sent.body).not.to.have.property('prompt_cache_key')
    // "Number six" is a shirt; digits in a chain are positions.
    expect(system).includes('is the player the game lists as #6')
    // A double play is two outs, the usual ones unless others are said.
    expect(system).match(
      /the runner from first out at second and the\s+batter out at first/
    )
    expect(system).includes('Do not ask which runners were out')
    expect(system).match(
      /A double play said with no kind of ball is\s+a ground ball/
    )
    expect(system).match(/never ask which one happened/)
    expect(system).match(/is only the out\s+the scorer says/)
    expect(system).match(/never send\s+a result or an out after it/)
    expect(system).match(
      /A runner who tags up on a catch says the catch happened/
    )
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
      'askScorer',
      'undo'
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

/** Anthropic, answering each request with the next canned content blocks. */
function anthropic(...replies: Array<Array<Record<string, unknown>>>): {
  fetch: typeof fetch
  sent: Array<{
    url: string
    body: Record<string, any>
    headers: Record<string, string>
  }>
} {
  const sent: Array<{
    url: string
    body: Record<string, any>
    headers: Record<string, string>
  }> = []
  const fake = async (url: unknown, init?: RequestInit): Promise<Response> => {
    sent.push({
      url: String(url),
      body: JSON.parse(init?.body as string),
      headers: init?.headers as Record<string, string>
    })
    return new Response(JSON.stringify({ content: replies.shift() ?? [] }), {
      status: 200
    })
  }
  return { fetch: fake, sent }
}

describe('dictation interpreter, calls written as text', function () {
  const names = new Set(['pitch', 'ballInPlay', 'result'])

  it('reads calls a model wrote out as JSON instead of calling', function () {
    expect(
      callsWrittenAsText(
        '{"name": "pitch", "parameters": {"call": "B"}}',
        names
      )
    ).deep.equals([
      {
        id: 'written_1',
        type: 'function',
        function: { name: 'pitch', arguments: '{"call":"B"}' }
      }
    ])
    // Several, back to back, with "type" and "arguments", even as a string;
    // braces inside a string do not end an object.
    const calls = callsWrittenAsText(
      'Scoring: {"type":"function","name":"ballInPlay","arguments":{"contact":"bunt","note":"a } brace"}}{"type":"function","name":"result","arguments":"{\\"eventType\\":\\"single\\"}"}',
      names
    )
    expect(calls.map(call => call.function.name)).deep.equals([
      'ballInPlay',
      'result'
    ])
    expect(JSON.parse(calls[1].function.arguments)).deep.equals({
      eventType: 'single'
    })
    // An unknown tool, plain text and a broken object are not calls.
    expect(
      callsWrittenAsText(
        '{"name": "dance", "parameters": {}} no call here {"name": "pitch"',
        names
      )
    ).deep.equals([])
  })

  it('reads the text when the only call made was a closePlay', async function () {
    const stub = provider({
      status: 200,
      text: JSON.stringify({
        choices: [
          {
            message: {
              content:
                '{"type":"function","name":"ballInPlay","parameters":{"contact":"swing","trajectory":"popup","fielder":13}}{"type":"function","name":"result","parameters":{"eventType":"field_out","outBy":"catch"}}',
              tool_calls: [call('c1', 'gameFlow', { kind: 'closePlay' })]
            }
          }
        ]
      })
    })
    expect(
      await new Interpretation(
        config(stub.fetch),
        'ctx',
        'Pop out to the second baseman.'
      ).start()
    ).deep.equals({
      kind: 'actions',
      actions: [
        {
          type: 'ballInPlay',
          contact: 'swing',
          trajectory: 'popup',
          fielder: 13
        },
        { type: 'result', eventType: 'field_out', outBy: 'catch' }
      ],
      dropped: []
    })
  })

  it('scores a sentence whose calls came back as text', async function () {
    const stub = provider({
      status: 200,
      text: JSON.stringify({
        choices: [
          {
            message: {
              content: '{"name": "pitch", "parameters": {"call": "C"}}'
            }
          }
        ]
      })
    })
    expect(
      await new Interpretation(
        config(stub.fetch),
        'ctx',
        'Struck out looking.'
      ).start()
    ).deep.equals({
      kind: 'actions',
      actions: [{ type: 'pitch', call: 'C' }],
      dropped: []
    })
  })
})

describe('dictation interpreter, a ball in play sent without its result', function () {
  const single = call('c1', 'ballInPlay', {
    contact: 'swing',
    trajectory: 'line_drive'
  })

  it('asks once for the result, and keeps it after its ball in play', async function () {
    const stub = provider(
      [single],
      [call('c2', 'result', { eventType: 'single' })]
    )
    expect(
      await new Interpretation(
        config(stub.fetch),
        'ctx',
        'Single to left.'
      ).start()
    ).deep.equals({
      kind: 'actions',
      actions: [
        { type: 'ballInPlay', contact: 'swing', trajectory: 'line_drive' },
        { type: 'result', eventType: 'single' }
      ],
      dropped: []
    })
    expect(stub.sent).to.have.length(2)
    expect(stub.sent[1].body.tool_choice).equals('auto')
    expect(stub.sent[1].body.messages.at(-1)).deep.equals({
      role: 'tool',
      tool_call_id: 'c1',
      content: RESULT_MISSING
    })
  })

  it('leaves the ball in play when the words say nothing more, and asks only once', async function () {
    const stub = provider([single], [], [])
    const turn = await new Interpretation(
      config(stub.fetch),
      'ctx',
      'Ground ball to short.'
    ).start()
    expect(turn.kind === 'actions' && turn.actions).deep.equals([
      { type: 'ballInPlay', contact: 'swing', trajectory: 'line_drive' }
    ])
    expect(stub.sent).to.have.length(2)
    // With its result, nothing more is asked.
    const whole = provider([
      single,
      call('c2', 'result', { eventType: 'single' })
    ])
    await new Interpretation(config(whole.fetch), 'ctx', 'Single.').start()
    expect(whole.sent).to.have.length(1)
  })

  it('does not ask when the result came first, and adds it to a follow-up', async function () {
    const first = provider([
      call('c1', 'result', { eventType: 'single' }),
      call('c2', 'ballInPlay', { contact: 'swing', trajectory: 'line_drive' })
    ])
    await new Interpretation(config(first.fetch), 'ctx', 'Single.').start()
    expect(first.sent).to.have.length(1)
    // A follow-up model is told what is recorded, and about the result.
    const gpt = provider([single], [])
    await new Interpretation(
      config(gpt.fetch, { followUp: true }),
      'ctx',
      'Ground ball, the runner goes to second.'
    ).start()
    const told = gpt.sent[1].body.messages.at(-1).content!
    expect(told).match(/^Recorded\. So far, in order: /)
    expect(told).includes('The ball in play has no result.')
  })

  it('answers every call of the turn in one message to Anthropic', async function () {
    const { fetch, sent } = anthropic(
      [
        { type: 'tool_use', id: 't1', name: 'pitch', input: { call: 'B' } },
        {
          type: 'tool_use',
          id: 't2',
          name: 'ballInPlay',
          input: { contact: 'swing' }
        }
      ],
      [
        {
          type: 'tool_use',
          id: 't3',
          name: 'result',
          input: { eventType: 'single' }
        }
      ]
    )
    const turn = await new Interpretation(
      config(fetch, { api: 'messages' }),
      'ctx',
      'Ball, then a single.'
    ).start()
    expect(turn.kind === 'actions' && turn.actions.length).equals(3)
    expect(sent[1].body.messages.at(-1)).deep.equals({
      role: 'user',
      content: [
        { type: 'tool_result', tool_use_id: 't1', content: RESULT_MISSING },
        { type: 'tool_result', tool_use_id: 't2', content: RESULT_MISSING }
      ]
    })
    // Claude may now answer with no tool call.
    expect(sent[0].body.tool_choice).deep.equals({ type: 'any' })
    expect(sent[1].body.tool_choice).deep.equals({ type: 'auto' })
  })
})

describe('dictation interpreter, cache routing', function () {
  it('sends a cache key as xAI’s routing header, and to OpenAI as prompt_cache_key', async function () {
    const xai = provider([call('c1', 'pitch', { call: 'B' })])
    await new Interpretation(
      config(xai.fetch, { cacheKey: 'scorer-1' }),
      'ctx',
      'Ball.'
    ).start()
    expect(xai.sent[0].headers['x-grok-conv-id']).equals('scorer-1')
    expect(xai.sent[0].body).not.to.have.property('prompt_cache_key')
    const openai = provider([call('c1', 'pitch', { call: 'B' })])
    await new Interpretation(
      config(openai.fetch, {
        model: 'gpt-6-luna',
        baseUrl: 'https://api.openai.com/v1',
        cacheKey: 'scorer-1'
      }),
      'ctx',
      'Ball.'
    ).start()
    expect(openai.sent[0].body.prompt_cache_key).equals('scorer-1')
  })

  it('puts the game in the user message for a model that caches only so', async function () {
    const gpt = provider([call('c1', 'pitch', { call: 'B' })])
    await new Interpretation(
      config(gpt.fetch, { gameInUserMessage: true }),
      'Top of the 1st.',
      'Ball.'
    ).start()
    expect(gpt.sent[0].body.messages).deep.equals([
      { role: 'system', content: systemPrompt() },
      {
        role: 'user',
        content: `${gamePrompt('Top of the 1st.')}\n\nTHE SCORER SAID\nBall.`
      }
    ])
  })
})

describe('dictation interpreter, other providers', function () {
  it('adds a model’s own fields to a chat request', async function () {
    const { fetch, sent } = provider([call('c1', 'pitch', { call: 'B' })])
    const turn = await new Interpretation(
      config(fetch, {
        model: 'gpt-6-luna',
        baseUrl: 'https://api.openai.com/v1',
        api: 'chat',
        body: { reasoning_effort: 'none' }
      }),
      'ctx',
      'Ball.'
    ).start()
    expect(turn).deep.equals({
      kind: 'actions',
      actions: [{ type: 'pitch', call: 'B' }],
      dropped: []
    })
    expect(sent[0].url).equals('https://api.openai.com/v1/chat/completions')
    expect(sent[0].body).deep.include({
      model: 'gpt-6-luna',
      tool_choice: 'required',
      reasoning_effort: 'none'
    })
  })

  it('asks Anthropic in its own shape and reads its tool uses', async function () {
    const { fetch, sent } = anthropic([
      { type: 'text', text: 'Scoring it.' },
      { type: 'tool_use', id: 't1', name: 'pitch', input: { call: 'B' } },
      { type: 'tool_use', id: 't2', name: 'pitch', input: { call: 'C' } }
    ])
    const turn = await new Interpretation(
      config(fetch, {
        apiKey: 'anthropic-key',
        model: 'claude-haiku-4-5-20251001',
        baseUrl: 'https://api.anthropic.com/v1',
        api: 'messages'
      }),
      'the game',
      'Ball. Called strike.'
    ).start()
    expect(turn).deep.equals({
      kind: 'actions',
      actions: [
        { type: 'pitch', call: 'B' },
        { type: 'pitch', call: 'C' }
      ],
      dropped: []
    })
    const request = sent[0]
    expect(request.url).equals('https://api.anthropic.com/v1/messages')
    expect(request.headers).deep.include({
      'x-api-key': 'anthropic-key',
      'anthropic-version': '2023-06-01'
    })
    // The system prompt is asked to be cached, with the tools before it.
    expect(request.body.system).deep.equals([
      {
        type: 'text',
        text: systemPrompt(),
        cache_control: { type: 'ephemeral' }
      },
      { type: 'text', text: gamePrompt('the game') }
    ])
    expect(request.body.tool_choice).deep.equals({ type: 'any' })
    expect(request.body.temperature).equals(0)
    expect(
      request.body.tools.map((tool: { name: string }) => tool.name)
    ).deep.equals([...ACTION_TYPES, 'askScorer', 'undo'])
    expect(request.body.tools.at(-2).input_schema).deep.equals(
      ASK_SCORER.function.parameters
    )
    expect(request.body.messages).deep.equals([
      { role: 'user', content: 'Ball. Called strike.' }
    ])
  })

  it('carries a question and its answer to Anthropic as a tool use and its result', async function () {
    const { fetch, sent } = anthropic(
      [
        {
          type: 'tool_use',
          id: 'q1',
          name: 'askScorer',
          input: {
            question: 'Which Noah?',
            options: [{ label: 'Noah D.' }, { label: 'Noah K.' }]
          }
        }
      ],
      [{ type: 'tool_use', id: 't1', name: 'pitch', input: { call: 'B' } }]
    )
    const interpretation = new Interpretation(
      config(fetch, { api: 'messages', model: 'claude-haiku-4-5-20251001' }),
      'ctx',
      'Noah took ball one.'
    )
    expect(await interpretation.start()).deep.include({
      kind: 'ask',
      question: 'Which Noah?'
    })
    expect(await interpretation.answer(1)).deep.include({ kind: 'actions' })
    expect(sent[1].body.messages).deep.equals([
      { role: 'user', content: 'Noah took ball one.' },
      {
        role: 'assistant',
        content: [
          {
            type: 'tool_use',
            id: 'q1',
            name: 'askScorer',
            input: {
              question: 'Which Noah?',
              options: [{ label: 'Noah D.' }, { label: 'Noah K.' }]
            }
          }
        ]
      },
      {
        role: 'user',
        content: [
          { type: 'tool_result', tool_use_id: 'q1', content: 'Noah K.' }
        ]
      }
    ])
  })

  it('passes on what Claude wrote when it used no tool, and reads a bare reply', async function () {
    const { fetch } = anthropic([{ type: 'text', text: 'No play there.' }], [])
    const said = await new Interpretation(
      config(fetch, { api: 'messages' }),
      'ctx',
      'Nice weather.'
    ).start()
    expect(said).deep.equals({
      kind: 'error',
      message: 'Nothing to score in "Nice weather.": No play there.'
    })
    expect(
      await new Interpretation(
        config(fetch, { api: 'messages' }),
        'ctx',
        'Hm.'
      ).start()
    ).deep.equals({ kind: 'error', message: 'Nothing to score in "Hm."' })
  })
})

describe('dictation interpreter, a model that makes one call a reply', function () {
  it('answers each call and asks again until nothing is left', async function () {
    const { fetch, sent } = provider(
      [call('c1', 'pitch', { call: 'B' })],
      [call('c2', 'pitch', { call: 'C' })],
      []
    )
    const turn = await new Interpretation(
      config(fetch, { followUp: true }),
      'ctx',
      'Ball, called strike.'
    ).start()
    expect(turn).deep.equals({
      kind: 'actions',
      actions: [
        { type: 'pitch', call: 'B' },
        { type: 'pitch', call: 'C' }
      ],
      dropped: []
    })
    expect(sent.map(each => each.body.tool_choice)).deep.equals([
      'required',
      'auto',
      'auto'
    ])
    expect(sent[1].body.messages.slice(3)).deep.equals([
      {
        role: 'assistant',
        content: null,
        tool_calls: [call('c1', 'pitch', { call: 'B' })]
      },
      {
        role: 'tool',
        tool_call_id: 'c1',
        content: followUp([{ type: 'pitch', call: 'B' }])
      }
    ])
  })

  it('keeps what came before a question, and adds the answer to it', async function () {
    const { fetch } = provider(
      [call('c1', 'pitch', { call: 'B' })],
      [
        call('q1', 'askScorer', {
          question: 'Which Noah?',
          options: [
            {
              label: 'Noah D.',
              actions: [
                { type: 'baseRunning', kind: 'steal', runner: 4, to: '2B' }
              ]
            },
            { label: 'Noah K.' }
          ]
        })
      ]
    )
    const interpretation = new Interpretation(
      config(fetch, { followUp: true }),
      'ctx',
      'Ball, and Noah stole second.'
    )
    expect(await interpretation.start()).deep.include({ kind: 'ask' })
    expect(await interpretation.answer(0)).deep.equals({
      kind: 'actions',
      actions: [
        { type: 'pitch', call: 'B' },
        { type: 'baseRunning', kind: 'steal', runner: 4, to: '2B' }
      ],
      dropped: []
    })
  })

  it('keeps no closePlay and no runner move twice, and ends on a round with nothing new', async function () {
    const steal = {
      type: 'baseRunning',
      kind: 'steal',
      runner: 3,
      to: '3B'
    }
    const { fetch, sent } = provider(
      [
        call('c1', 'baseRunning', steal),
        call('c2', 'gameFlow', { kind: 'closePlay' })
      ],
      [
        call('c3', 'baseRunning', steal),
        call('c4', 'gameFlow', { kind: 'closePlay' })
      ],
      [call('c5', 'pitch', { call: 'B' })]
    )
    const turn = await new Interpretation(
      config(fetch, { followUp: true }),
      'ctx',
      'And he steals third.'
    ).start()
    expect(turn).deep.equals({ kind: 'actions', actions: [steal], dropped: [] })
    expect(sent).to.have.length(2)
  })

  it('tells the model everything recorded so far, so a call said twice counts', async function () {
    const { fetch, sent } = provider(
      [call('c1', 'pitch', { call: 'B' })],
      [call('c2', 'pitch', { call: 'B' })],
      [call('c3', 'pitch', { call: 'S' })],
      []
    )
    expect(
      await new Interpretation(
        config(fetch, { followUp: true }),
        'ctx',
        'Ball, ball, swinging strike.'
      ).start()
    ).deep.equals({
      kind: 'actions',
      actions: [
        { type: 'pitch', call: 'B' },
        { type: 'pitch', call: 'B' },
        { type: 'pitch', call: 'S' }
      ],
      dropped: []
    })
    expect(sent[2].body.messages.at(-1)).deep.equals({
      role: 'tool',
      tool_call_id: 'c2',
      content: followUp([
        { type: 'pitch', call: 'B' },
        { type: 'pitch', call: 'B' }
      ])
    })
  })

  it('keeps a runner move once, whatever fielders a repeat names', async function () {
    const out = (fielders: number[]): object =>
      call('m', 'runnerMovement', { runner: 1, to: '1B', out: true, fielders })
    const { fetch, sent } = provider([out([13, 12])], [out([13, 12, 12])], [])
    const turn = await new Interpretation(
      config(fetch, { followUp: true }),
      'ctx',
      'Six four three.'
    ).start()
    expect(turn.kind === 'actions' && turn.actions).deep.equals([
      {
        type: 'runnerMovement',
        runner: 1,
        to: '1B',
        out: true,
        fielders: [13, 12]
      }
    ])
    expect(sent).to.have.length(2)
  })

  it('stops asking after a few rounds', async function () {
    const replies = Array.from({ length: MAX_FOLLOW_UPS + 3 }, (_, n) => [
      call(`c${n}`, 'pitch', { call: n % 2 === 0 ? 'B' : 'C' })
    ])
    const { fetch, sent } = provider(...replies)
    const turn = await new Interpretation(
      config(fetch, { followUp: true }),
      'ctx',
      'Ball.'
    ).start()
    expect(sent).to.have.length(MAX_FOLLOW_UPS + 1)
    expect(turn.kind === 'actions' && turn.actions.length).equals(
      MAX_FOLLOW_UPS + 1
    )
  })
})

describe('dictation interpreter, undo', function () {
  it('takes back the last thing scored, alone or before what follows', async function () {
    const alone = provider([call('u1', 'undo', {})])
    expect(
      await new Interpretation(config(alone.fetch), 'ctx', 'Undo that.').start()
    ).deep.equals({ kind: 'actions', actions: [], dropped: [], undo: true })
    expect(
      alone.sent[0].body.tools.map(tool => tool.function.name).slice(-2)
    ).deep.equals(['askScorer', 'undo'])
    const then = provider([
      call('u1', 'undo', {}),
      call('c1', 'pitch', { call: 'C' })
    ])
    expect(
      await new Interpretation(
        config(then.fetch),
        'ctx',
        'Scratch that, it was a called strike.'
      ).start()
    ).deep.equals({
      kind: 'actions',
      actions: [{ type: 'pitch', call: 'C' }],
      dropped: [],
      undo: true
    })
  })

  it('takes back the last play when the sentence opens by taking it back, though the model left out undo', async function () {
    for (const words of [
      'Scratch that, it was a called strike.',
      'Undo that last pitch, ball.',
      'Take that back, it was a strike.',
      'Scratch the last pitch, called strike.'
    ]) {
      const left = provider([call('c1', 'pitch', { call: 'C' })])
      expect(
        await new Interpretation(config(left.fetch), 'ctx', words).start(),
        words
      ).deep.equals({
        kind: 'actions',
        actions: [{ type: 'pitch', call: 'C' }],
        dropped: [],
        undo: true
      })
    }
    // A take-back later in the sentence corrects its own words, a scratch
    // hit is a play, and "never mind" is left to the model.
    for (const words of [
      'Ball, no, scratch that, called strike.',
      'Scratch single to third.',
      'Never mind, called strike.'
    ]) {
      const plain = provider([call('c1', 'pitch', { call: 'C' })])
      expect(
        await new Interpretation(config(plain.fetch), 'ctx', words).start(),
        words
      ).not.to.have.property('undo')
    }
  })

  it('keeps an undo said in other take-back words', async function () {
    for (const words of [
      'Strike that, it was a foul ball.',
      'Go back one, that was a strike.',
      'Remove that last pitch.',
      'Undue that last play.'
    ]) {
      const kept = provider([call('u1', 'undo', {})])
      expect(
        await new Interpretation(config(kept.fetch), 'ctx', words).start(),
        words
      ).deep.include({ undo: true })
    }
  })

  it('reads calls written as text beside an undo the words did not ask for', async function () {
    const stub = provider({
      status: 200,
      text: JSON.stringify({
        choices: [
          {
            message: {
              content: '{"name": "pitch", "parameters": {"call": "B"}}',
              tool_calls: [call('u1', 'undo', {})]
            }
          }
        ]
      })
    })
    expect(
      await new Interpretation(config(stub.fetch), 'ctx', 'Ball four.').start()
    ).deep.equals({
      kind: 'actions',
      actions: [{ type: 'pitch', call: 'B' }],
      dropped: []
    })
  })

  it('ignores an undo the words did not ask for', async function () {
    const stray = provider([call('u1', 'undo', {})])
    const turn = await new Interpretation(
      config(stray.fetch),
      'ctx',
      'Double to right center.'
    ).start()
    expect(turn.kind).equals('error')
    expect(turn.kind === 'error' && turn.message).includes(
      'An undo the words did not ask for was ignored'
    )
  })

  it('offers undo to Anthropic too, and counts it once in a follow-up round', async function () {
    const { fetch, sent } = anthropic([
      { type: 'tool_use', id: 'u1', name: 'undo', input: {} }
    ])
    expect(
      await new Interpretation(
        config(fetch, { api: 'messages' }),
        'ctx',
        'Undo.'
      ).start()
    ).deep.include({ undo: true })
    expect(sent[0].body.tools.at(-1)).deep.equals({
      name: 'undo',
      description: UNDO.function.description,
      input_schema: UNDO.function.parameters
    })
    const twice = provider([call('u1', 'undo', {})], [call('u2', 'undo', {})])
    await new Interpretation(
      config(twice.fetch, { followUp: true }),
      'ctx',
      'Undo.'
    ).start()
    expect(twice.sent).to.have.length(2)
  })
})
