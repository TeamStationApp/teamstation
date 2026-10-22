import { expect } from 'chai'
import { describe, it } from 'mocha'

import { ACTION_TYPES, toolSchema } from '../../common/scoring/actions'
import { tagOf, writtenTag } from '../../common/scoring/playerTags'
import {
  ROSTER_COMMAND_TYPES,
  rosterToolSchema,
  type SaidRosterCommand
} from '../../common/scoring/rosterCommands'
import { DICTATION_VOCABULARY } from '../../common/scoring/vocabulary'
import {
  ASK_SCORER,
  asOpenAiTools,
  callsWrittenAsText,
  type DictationExchange,
  dictationExchangeLines,
  followUp,
  gamePrompt,
  Interpretation,
  type InterpreterConfig,
  MAX_FOLLOW_UPS,
  RESULT_MISSING,
  ROSTER_NOT_ASKED,
  systemPrompt,
  UNDO,
  UNDO_NOT_ASKED,
  withTags
} from './interpreter'

interface Sent {
  url: string
  body: {
    model: string
    temperature: number
    parallel_tool_calls: boolean
    tool_choice: string
    prompt_cache_key?: string
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
  for (const reason of [
    "Fielder's Choice",
    'Fielders Choice',
    'Fielder’s choice',
    'Out at first',
    'Out at second',
    'Out at third'
  ])
    it(`keeps the FC runner call when the model labels its optional reason ${reason}`, async function () {
      const out = reason.startsWith('Out')
      const stub = provider([
        call('c1', 'runnerMovement', {
          runner: tagOf(3),
          to: '2B',
          out,
          reason
        })
      ])
      const turn = await new Interpretation(
        config(stub.fetch),
        `On first: ${writtenTag(3)}`,
        'The runner advances on the choice.'
      ).start()
      expect(turn.kind, JSON.stringify(turn)).equals('actions')
      if (turn.kind !== 'actions') return
      expect(turn.dropped).deep.equals([])
      expect(turn.actions).deep.equals([
        { type: 'runnerMovement', runner: 3, to: '2B', out }
      ])
    })

  for (const raw of [
    { runner: tagOf(3), to: '2B', out: false, reason: 'Out at second' },
    { runner: tagOf(3), to: '2B', reason: 'Invented reason' },
    { runner: tagOf(3), to: 'sixth', out: true, reason: 'Out at third' },
    { runner: tagOf(999), to: '2B', out: true, reason: 'Out at second' }
  ])
    it(`still rejects malformed FC movement ${JSON.stringify(raw)}`, async function () {
      const stub = provider([call('c1', 'runnerMovement', raw)])
      const turn = await new Interpretation(
        config(stub.fetch),
        `On first: ${writtenTag(3)}`,
        'The runner advances.'
      ).start()
      expect(turn.kind, JSON.stringify(turn)).equals('error')
    })
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

  for (const gameInUserMessage of [false, true])
    it(`scopes extra FC relay instructions to the spoken play (${gameInUserMessage})`, async function () {
      for (const transcript of ["Fielder's choice, everyone safe", 'ball']) {
        const stub = provider([call('c1', 'pitch', { call: 'B' })])
        await new Interpretation(
          { ...config(stub.fetch), gameInUserMessage },
          'Top of the 1st.',
          transcript
        ).start()
        const messages = stub.sent[0].body.messages
        expect(messages[0].content).equals(systemPrompt())
        expect(messages[0].content).not.includes('FIELDER CHOICE RELAYS')
        expect(messages[1].content?.includes('FIELDER CHOICE RELAYS')).equals(
          transcript !== 'ball'
        )
        if (transcript !== 'ball')
          expect(messages[1].content).includes('including late throws')
      }
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
      /"thrown to first for the out, the runner at third scores" is\s+ballInPlay, result field_out and runnerMovement of the runner on third to\s+home/
    )
    expect(system).match(
      /is result hit_by_pitch alone: never send a\s+pitch or a ballInPlay with it/
    )
    expect(system).match(
      /A runner who tags up on a catch says the catch happened/
    )
    // A tag-up on a foul pop is its catch, its out and the move, with no
    // question about who caught it.
    expect(system).match(
      /the runner's move: ballInPlay, result field_out with outBy catch and\s+foulCaught, and runnerMovement of the runner on second to third/
    )
    expect(system).match(
      /never an\s+ordinary fly out\. Leave out who caught it when the scorer does not say;\s+do not ask/
    )
    // A number is a jersey and a base is not a number; a player comes back
    // as his tag.
    expect(system).match(
      /not a batter or runner who wears it\s+too, and his tag is the one GAME gives that fielder/
    )
    expect(system).match(
      /in "SS Mike T\. #27 \(tag QV2\)", SS is where he plays and QV2 is\s+his tag\. Wherever a tool takes a player, give his tag, QV2: never a\s+jersey, a position, a base or any other number/
    )
    expect(system).match(
      /A tag's digit is part\s+of its name and says nothing about bases: QV2 need not be on second/
    )
    expect(system).match(
      /A base is not a number: "steals third" names no #3,\s+and the runner on second is whoever the game lists on second, not #2/
    )
    expect(system).match(
      /His tag is the one GAME gives on that base's\s+line: "On second: …" for the runner on second/
    )
    expect(system).match(
      /"He steals third", "the runner steals third" or "steals third", with\s+runners on first and second, is the runner on second; the runner on\s+first stays on first\. Do not send him to third, and do not ask who/
    )
    expect(system).match(
      /"1st", "2nd" and "3rd", and the words "first", "second" and "third", are\s+first base, second base and third base/
    )
    expect(system).match(
      /"Third" is not "three": third is the base, three is jersey 3/
    )
    expect(system).match(
      /"Caught\s+by the third baseman" is that 3B's tag, never the tag of #3/
    )
    expect(system).match(/"one", "two", "three", "four", "five", "six"/)
    expect(system).match(
      /"the shortstop boots it"[\s\S]*fieldingPlay with error set to the same tag/
    )
    expect(system).match(/"He steals third" is only that "On second" runner/)
    expect(system).match(/Never the batter, not even when he wears #3/)
    expect(system).match(
      /"bats 1st", "bats 2nd" and\s+"bats 3rd" are his place in the batting order/
    )
    expect(system).match(
      /a tag ending in 3 is not on third and does not steal third/
    )
    expect(system).match(
      /"he steals", "and he steals" or "steals",\s+with no base and no name, is that runner stealing the next base: a\s+runner alone on first steals second\. Call baseRunning for him, and\s+never ask, not even to confirm/
    )
    expect(system).match(
      /the runner on first to\s+second\. Never both to the same base, and never the runner on first to\s+third: that runner steals second\. Do not ask\. Call the lead runner's\s+steal first: third before second, home before third/
    )
    expect(system).not.match(/\bids?\b/)
    expect(system).match(
      /A steal takes one base: "he steals, and scores when the throw gets away"\s+is his steal of the next base, then runnerMovement of him to home\. The\s+throw that gets away is not a wild pitch/
    )
    expect(system).match(
      /barely use position numbers[^]*double play[^]*6 shortstop/
    )
    expect(system).includes('Read every other number\n  as a jersey.')
    // The game finishes a play by rule; the LLM does not ask about it.
    expect(system).includes('Leave fielders off an out nobody described')
    expect(system).match(
      /the second baseman takes\s+the throw when the shortstop or the third baseman fielded the ball/
    )
    expect(system).match(
      /the shortstop takes it when the first baseman or anyone else did/
    )
    expect(system).includes("Pop fly to right center field, it's caught")
    expect(system).includes("Sol's throw to first is late")
    expect(system).match(
      /runnerMovement of\s+the runner on third to home, out true/
    )
    expect(system).includes('fielders left off')
    expect(system).includes('result catcher_interference')
    expect(system).includes('Leave side out on each of these.')
    expect(system).includes('Jared comes in for Sol.')
    expect(system).includes('But Casey scores.')
    expect(system).includes('Casey tags up and takes third.')
    expect(system).includes('robbing the home run.')
    expect(system).includes(
      'Line drive, triple to right center field, and Casey takes home.'
    )
    expect(system).includes(
      'Sacrifice bunt to the shortstop, and Casey takes third.'
    )
    expect(system).includes("Third pickoff attempt and he's still safe.")
    expect(system).match(
      /On a fielder's choice, send the ball in play and the\s+result/
    )
    expect(system).includes('never fielders_choice')
    expect(system).includes("he's safe at first")
    expect(system).match(/Never send a runner\s+to the base batter/)
    expect(system).includes('throws him out at first')
    expect(system).includes('contact is only swing or bunt')
    expect(system).includes('Never invent a name, a tag or a placeholder')
    expect(system).includes('Four pitches, a strike')
    expect(system).match(
      /pitch B, pitch B, pitch B, pitch C invents three\s+balls/
    )
    expect(system).includes('when the count is 0-0')
    expect(system).includes('third disengagement')
    // A runner who went further than the hit took him is the LLM's to report.
    expect(system).match(
      /went further than the\s+hit's bases[^]*runnerMovement/
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

    it('takes the prompt’s tags, and an old app’s ids, out of the question and the labels', async function () {
      const stub = provider([
        ask(
          [
            { label: `Freeman F. #5 ${writtenTag(6)}, Visitors` },
            { label: `Freeman T. (#13) (${tagOf(16)}) (id 16)` },
            { label: writtenTag(7) }
          ],
          `Which Freeman ${writtenTag(6)} or (id 16)?`
        )
      ])
      const turn = await new Interpretation(
        config(stub.fetch),
        'c',
        'Freeman at first'
      ).start()
      expect(turn).deep.equals({
        kind: 'ask',
        question: 'Which Freeman or?',
        options: [
          { label: 'Freeman F. #5, Visitors' },
          { label: 'Freeman T. (#13)' }
        ]
      })
    })

    it('tells the model a shared first name is a question, by example', function () {
      expect(systemPrompt()).contains(
        '"Chase was picked\n  off" asks which Chase'
      )
      expect(systemPrompt()).contains('never a tag')
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
              content: `{"type":"function","name":"ballInPlay","parameters":{"contact":"swing","trajectory":"popup","fielder":"${tagOf(13)}"}}{"type":"function","name":"result","parameters":{"eventType":"field_out","outBy":"catch"}}`,
              tool_calls: [call('c1', 'gameFlow', { kind: 'closePlay' })]
            }
          }
        ]
      })
    })
    expect(
      await new Interpretation(
        config(stub.fetch),
        `2B Ian K. #4 ${writtenTag(13)}`,
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

  it('keeps one ball in play when it is said again before its result, the later words winning', async function () {
    const stub = provider(
      [
        call('c1', 'ballInPlay', {
          contact: 'swing',
          trajectory: 'ground_ball',
          depth: 'infield'
        }),
        call('c2', 'ballInPlay', { contact: 'swing', trajectory: 'chopper' }),
        // A piece of the same ball, with no contact of its own.
        call('c3', 'ballInPlay', {})
      ],
      // Asked for the result, the model takes its calls back and sends it.
      [call('u1', 'undo', {}), call('c3', 'result', { eventType: 'single' })]
    )
    expect(
      await new Interpretation(
        config(stub.fetch),
        'ctx',
        'Chopper over the mound, single.'
      ).start()
    ).deep.equals({
      kind: 'actions',
      actions: [
        {
          type: 'ballInPlay',
          contact: 'swing',
          trajectory: 'chopper',
          depth: 'infield'
        },
        { type: 'result', eventType: 'single' }
      ],
      dropped: []
    })
    // A ball after its result is the next batter's.
    const two = provider([
      single,
      call('c2', 'result', { eventType: 'single' }),
      call('c3', 'ballInPlay', { contact: 'bunt' }),
      call('c4', 'result', { eventType: 'sac_bunt' })
    ])
    const turn = await new Interpretation(
      config(two.fetch),
      'ctx',
      'Single. Then a sacrifice bunt.'
    ).start()
    expect(
      turn.kind === 'actions' &&
        turn.actions.filter(action => action.type === 'ballInPlay')
    ).to.have.length(2)
  })

  it('tells a model once that undo is not for its own calls, and keeps what it sends next', async function () {
    const stub = provider(
      [single],
      // Asked for the result, the model takes its calls back.
      [call('u1', 'undo', {})],
      [call('c2', 'result', { eventType: 'single' })]
    )
    expect(
      await new Interpretation(
        config(stub.fetch),
        'ctx',
        'Line drive single to left.'
      ).start()
    ).deep.equals({
      kind: 'actions',
      actions: [
        { type: 'ballInPlay', contact: 'swing', trajectory: 'line_drive' },
        { type: 'result', eventType: 'single' }
      ],
      dropped: []
    })
    expect(stub.sent).to.have.length(3)
    expect(stub.sent[2].body.messages.at(-1)).deep.equals({
      role: 'tool',
      tool_call_id: 'u1',
      content: UNDO_NOT_ASKED
    })
    // Only once.
    const twice = provider(
      [single],
      [call('u1', 'undo', {})],
      [call('u2', 'undo', {})]
    )
    await new Interpretation(config(twice.fetch), 'ctx', 'Single.').start()
    expect(twice.sent).to.have.length(3)
  })

  it('replaces what a model sends again after taking back its own calls', async function () {
    const ball = (id: string, fielder?: string): object =>
      call(id, 'ballInPlay', {
        contact: 'swing',
        trajectory: 'ground_ball',
        ...(fielder == null ? {} : { fielder })
      })
    // Asked for the result, it takes its calls back and sends them again,
    // and, told they stand, sends the result a second time: one of each.
    const stub = provider(
      [ball('c1')],
      [
        call('u1', 'undo', {}),
        ball('c2'),
        call('r1', 'result', { eventType: 'single' })
      ],
      [call('r2', 'result', { eventType: 'single' })]
    )
    expect(
      await new Interpretation(config(stub.fetch), 'ctx', 'Single.').start()
    ).deep.equals({
      kind: 'actions',
      actions: [
        { type: 'ballInPlay', contact: 'swing', trajectory: 'ground_ball' },
        { type: 'result', eventType: 'single' }
      ],
      dropped: []
    })
    // An undo before any call of its own is only dropped, and not answered:
    // the same calls sent again are a second plate appearance's only if new.
    const first = provider([
      call('u1', 'undo', {}),
      ball('c1'),
      call('r1', 'result', { eventType: 'single' })
    ])
    const leading = await new Interpretation(
      config(first.fetch),
      'ctx',
      'Single.'
    ).start()
    expect(first.sent).to.have.length(1)
    expect(leading.kind === 'actions' && leading.actions).to.have.length(2)
    // Told its calls stand, the same ball and result sent again are the
    // same play.
    const again = provider(
      [
        ball('a'),
        call('ra', 'result', { eventType: 'single' }),
        call('u1', 'undo', {})
      ],
      [ball('b'), call('rb', 'result', { eventType: 'single' })]
    )
    const same = await new Interpretation(
      config(again.fetch),
      'ctx',
      'Line drive single to left.'
    ).start()
    expect(same.kind === 'actions' && same.actions).deep.equals([
      { type: 'ballInPlay', contact: 'swing', trajectory: 'ground_ball' },
      { type: 'result', eventType: 'single' }
    ])
    // One undo and one pitch take back the last pitch.
    const pitches = provider([
      call('p1', 'pitch', { call: 'B' }),
      call('p2', 'pitch', { call: 'F' }),
      call('u1', 'undo', {}),
      call('p3', 'pitch', { call: 'S' })
    ])
    const counted = await new Interpretation(
      config(pitches.fetch),
      'ctx',
      'Ball, then a swinging strike.'
    ).start()
    expect(counted.kind === 'actions' && counted.actions).deep.equals([
      { type: 'pitch', call: 'B' },
      { type: 'pitch', call: 'S' }
    ])
    // After its own undo, a second batter in a later reply is his own.
    const next = provider(
      [
        ball('a'),
        call('ra', 'result', { eventType: 'single' }),
        call('u1', 'undo', {})
      ],
      [
        call('b', 'ballInPlay', { contact: 'swing', trajectory: 'fly_ball' }),
        call('rb', 'result', { eventType: 'field_out', outBy: 'catch' })
      ]
    )
    const two = await new Interpretation(
      config(next.fetch),
      'ctx',
      'Smith singles. Jones flies out.'
    ).start()
    expect(two.kind === 'actions' && two.actions).deep.equals([
      { type: 'ballInPlay', contact: 'swing', trajectory: 'ground_ball' },
      { type: 'result', eventType: 'single' },
      { type: 'ballInPlay', contact: 'swing', trajectory: 'fly_ball' },
      { type: 'result', eventType: 'field_out', outBy: 'catch' }
    ])
    // A ball corrected, then taken back and sent a third time: the third.
    const thrice = provider([
      ball('c1'),
      call('c2', 'ballInPlay', { contact: 'swing', trajectory: 'chopper' }),
      call('r1', 'result', { eventType: 'single' }),
      call('u1', 'undo', {}),
      call('c3', 'ballInPlay', { contact: 'swing', trajectory: 'line_drive' }),
      call('r2', 'result', { eventType: 'single' })
    ])
    const third = await new Interpretation(
      config(thrice.fetch),
      'ctx',
      'Single.'
    ).start()
    expect(third.kind === 'actions' && third.actions).deep.equals([
      { type: 'ballInPlay', contact: 'swing', trajectory: 'line_drive' },
      { type: 'result', eventType: 'single' }
    ])
    // In one reply: the play, an undo, and the play again is one play, its
    // pitch too; a batter after it is the next one.
    const once = provider([
      call('p1', 'pitch', { call: 'B' }),
      ball('c1'),
      call('r1', 'result', { eventType: 'single' }),
      call('u1', 'undo', {}),
      call('p2', 'pitch', { call: 'B' }),
      call('c2', 'ballInPlay', { contact: 'swing', trajectory: 'line_drive' }),
      call('r2', 'result', { eventType: 'single' }),
      call('c3', 'ballInPlay', { contact: 'swing', trajectory: 'fly_ball' }),
      call('r3', 'result', { eventType: 'double' })
    ])
    const turn = await new Interpretation(
      config(once.fetch),
      'ctx',
      'Single.'
    ).start()
    expect(turn.kind === 'actions' && turn.actions).deep.equals([
      { type: 'pitch', call: 'B' },
      { type: 'ballInPlay', contact: 'swing', trajectory: 'line_drive' },
      { type: 'result', eventType: 'single' },
      { type: 'ballInPlay', contact: 'swing', trajectory: 'fly_ball' },
      { type: 'result', eventType: 'double' }
    ])
  })

  it("keeps two batters apart when their balls come before their results, and drops a corrected ball's old place", async function () {
    const two = provider([
      call('a', 'ballInPlay', { contact: 'swing', trajectory: 'line_drive' }),
      call('b', 'ballInPlay', { contact: 'swing', trajectory: 'fly_ball' }),
      call('ra', 'result', { eventType: 'single' }),
      call('rb', 'result', { eventType: 'double' })
    ])
    const turn = await new Interpretation(
      config(two.fetch),
      'ctx',
      'Single. Then a double.'
    ).start()
    expect(turn.kind === 'actions' && turn.actions).deep.equals([
      { type: 'ballInPlay', contact: 'swing', trajectory: 'line_drive' },
      { type: 'ballInPlay', contact: 'swing', trajectory: 'fly_ball' },
      { type: 'result', eventType: 'single' },
      { type: 'result', eventType: 'double' }
    ])
    // Two singles are two batters', whichever order they come in.
    const ball = (id: string, trajectory: string): object =>
      call(id, 'ballInPlay', { contact: 'swing', trajectory })
    const single = (id: string): object =>
      call(id, 'result', { eventType: 'single' })
    for (const replies of [
      [
        [
          ball('a', 'line_drive'),
          ball('b', 'fly_ball'),
          single('ra'),
          single('rb')
        ]
      ],
      [
        [ball('a', 'line_drive'), ball('b', 'fly_ball')],
        [single('ra'), single('rb')]
      ],
      [
        [
          single('ra'),
          ball('a', 'line_drive'),
          single('rb'),
          ball('b', 'fly_ball')
        ]
      ]
    ]) {
      const singles = await new Interpretation(
        config(provider(...replies).fetch),
        'ctx',
        'Smith singles to left, Jones singles to right.'
      ).start()
      const actions = singles.kind === 'actions' ? singles.actions : []
      expect(
        actions.filter(action => action.type === 'ballInPlay'),
        JSON.stringify(actions)
      ).to.have.length(2)
      expect(
        actions.filter(action => action.type === 'result'),
        JSON.stringify(actions)
      ).to.have.length(2)
    }
    // The same over two replies: two balls, then, asked, their results.
    const later = provider(
      [
        call('a', 'ballInPlay', { contact: 'swing', trajectory: 'line_drive' }),
        call('b', 'ballInPlay', { contact: 'swing', trajectory: 'fly_ball' })
      ],
      [
        call('ra', 'result', { eventType: 'single' }),
        call('rb', 'result', { eventType: 'double' })
      ]
    )
    const split = await new Interpretation(
      config(later.fetch),
      'ctx',
      'Single. Then a double.'
    ).start()
    expect(split.kind === 'actions' && split.actions).deep.equals([
      { type: 'ballInPlay', contact: 'swing', trajectory: 'line_drive' },
      { type: 'ballInPlay', contact: 'swing', trajectory: 'fly_ball' },
      { type: 'result', eventType: 'single' },
      { type: 'result', eventType: 'double' }
    ])
    const moved = provider([
      call('a', 'ballInPlay', {
        contact: 'swing',
        direction: 'left',
        location: { x: -30, z: -60 }
      }),
      call('b', 'ballInPlay', { contact: 'swing', direction: 'right' }),
      call('r', 'result', { eventType: 'single' })
    ])
    const fixed = await new Interpretation(
      config(moved.fetch),
      'ctx',
      'Single to right.'
    ).start()
    expect(fixed.kind === 'actions' && fixed.actions[0]).deep.equals({
      type: 'ballInPlay',
      contact: 'swing',
      direction: 'right'
    })
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
    const told = gpt.sent[1].body.messages.at(-1)!.content!
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

describe('dictation interpreter, the prompt log', function () {
  it('logs the model, the prompt and the tool calls', async function () {
    const exchanges: DictationExchange[] = []
    const stub = provider([call('c1', 'pitch', { call: 'B' })])
    await new Interpretation(
      config(stub.fetch, {
        log: exchange => {
          exchanges.push(exchange)
        }
      }),
      'Top of the 1st.',
      'ball'
    ).start()
    expect(exchanges).to.have.length(1)
    const [exchange] = exchanges
    expect(exchange.model).equals('grok-4.7')
    expect(exchange.said).equals('')
    expect(exchange.calls).deep.equals([
      { name: 'pitch', arguments: { call: 'B' } }
    ])
    expect(
      exchange.messages.map(message => message.content).join('\n')
    ).includes('Top of the 1st.')
    expect(
      exchange.messages.map(message => message.content).join('\n')
    ).includes('ball')
    expect(exchange.messages[0].content).equals(systemPrompt())
    const lines = dictationExchangeLines('utt-1', exchange)
    expect(
      lines.some(line => line.includes('"tag":"dictation-exchange"'))
    ).equals(true)
    expect(lines.some(line => line.includes('"model":"grok-4.7"'))).equals(true)
    expect(lines.some(line => line.includes('"tag":"dictation-calls"'))).equals(
      true
    )
    expect(lines.some(line => line.includes('Bearer'))).equals(false)
    expect(lines.join('\n')).not.includes('"apiKey"')
    for (const line of lines) expect(line.length).to.be.below(48_000)
  })

  it('logs a provider failure with the prompt and no calls', async function () {
    const exchanges: DictationExchange[] = []
    const stub = provider({ status: 500, text: 'nope' })
    const turn = await new Interpretation(
      config(stub.fetch, {
        model: 'claude-haiku-5-5',
        log: exchange => {
          exchanges.push(exchange)
        }
      }),
      'Top of the 1st.',
      'ball'
    ).start()
    expect(turn.kind).equals('error')
    expect(exchanges).to.have.length(1)
    expect(exchanges[0].model).equals('claude-haiku-5-5')
    expect(exchanges[0].calls).deep.equals([])
    expect(exchanges[0].error).includes('answered 500')
    expect(exchanges[0].messages.at(-1)?.content).equals('ball')
  })

  it('splits a prompt message that would overflow one journal line', function () {
    const content = 'x'.repeat(30_000)
    const lines = dictationExchangeLines('utt-2', {
      model: 'claude-haiku-5-5',
      messages: [{ role: 'system', content }],
      calls: [],
      said: ''
    })
    const prompts = lines
      .map(
        line =>
          JSON.parse(line) as {
            tag: string
            content?: string
            part?: number
            parts?: number
          }
      )
      .filter(line => line.tag === 'dictation-prompt')
    expect(prompts.length).to.be.greaterThan(1)
    expect(prompts.map(line => line.content).join('')).equals(content)
    expect(prompts[0].parts).equals(prompts.length)
    for (const line of lines) expect(line.length).to.be.below(48_000)
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
        model: 'claude-haiku-5-5',
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
    // Claude Haiku 5.5 refuses a temperature.
    expect(request.body).not.have.property('temperature')
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
      config(fetch, { api: 'messages', model: 'claude-haiku-5-5' }),
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
                {
                  type: 'baseRunning',
                  kind: 'steal',
                  runner: tagOf(4),
                  to: '2B'
                }
              ]
            },
            { label: 'Noah K.' }
          ]
        })
      ]
    )
    const interpretation = new Interpretation(
      config(fetch, { followUp: true }),
      `On first: Noah D. #4 ${writtenTag(4)}.`,
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
    const said = { ...steal, runner: tagOf(3) }
    const { fetch, sent } = provider(
      [
        call('c1', 'baseRunning', said),
        call('c2', 'gameFlow', { kind: 'closePlay' })
      ],
      [
        call('c3', 'baseRunning', said),
        call('c4', 'gameFlow', { kind: 'closePlay' })
      ],
      [call('c5', 'pitch', { call: 'B' })]
    )
    const turn = await new Interpretation(
      config(fetch, { followUp: true }),
      `On second: Ian K. #9 ${writtenTag(3)}.`,
      'And he steals third.'
    ).start()
    expect(turn).deep.equals({ kind: 'actions', actions: [steal], dropped: [] })
    expect(sent).to.have.length(2)
    // The model is told what it said: the runner by his tag.
    expect(sent[1].body.messages.at(-2)?.content).includes(
      `"runner":"${tagOf(3)}"`
    )
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
      call('m', 'runnerMovement', {
        runner: tagOf(1),
        to: '1B',
        out: true,
        fielders: fielders.map(tagOf)
      })
    const { fetch, sent } = provider([out([13, 12])], [out([13, 12, 12])], [])
    const turn = await new Interpretation(
      config(fetch, { followUp: true }),
      [1, 12, 13].map(writtenTag).join(' '),
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

describe('dictation interpreter, roster commands', function () {
  const rosterTools = rosterToolSchema()
  const ball = { type: 'pitch', call: 'B' }
  // As said: number 3, with no team named; and Betts by name.
  const atThird = {
    type: 'setPositions',
    places: [{ player: { jersey: '3' }, position: '3B' }]
  }
  const pinchHitter = {
    type: 'pinchHitter' as const,
    player: { name: 'Betts' }
  }

  it('offers a scope’s roster tools beside its scoring tools, to either provider', async function () {
    const stub = provider([
      call('c1', 'pinchHitter', { player: { name: 'Betts' } })
    ])
    await new Interpretation(
      config(stub.fetch, { tools: [], rosterTools }),
      'c',
      'Betts pinch hits'
    ).start()
    expect(stub.sent[0].body.tools.map(t => t.function.name)).deep.equals([
      ...ROSTER_COMMAND_TYPES,
      'askScorer',
      'undo'
    ])
    const claude = anthropic([
      {
        type: 'tool_use',
        id: 't1',
        name: 'pinchHitter',
        input: { player: { name: 'Betts' } }
      }
    ])
    const turn = await new Interpretation(
      config(claude.fetch, {
        baseUrl: 'https://api.anthropic.com/v1',
        api: 'messages',
        rosterTools
      }),
      'c',
      'Betts pinch hits'
    ).start()
    expect(
      claude.sent[0].body.tools.map((tool: { name: string }) => tool.name)
    ).deep.equals([
      ...ACTION_TYPES,
      ...ROSTER_COMMAND_TYPES,
      'askScorer',
      'undo'
    ])
    expect(turn).deep.equals({
      kind: 'actions',
      actions: [],
      roster: [pinchHitter],
      dropped: []
    })
  })

  it('returns roster tool calls as said commands, in order, and drops one that does not clean', async function () {
    const stub = provider([
      call('c1', 'setPositions', {
        places: [{ player: { jersey: '3' }, position: '3B' }]
      }),
      call('c2', 'setPositions', { side: 'both', places: [] }),
      call('c3', 'placeInLineup', 'not json'),
      call('c4', 'placeInLineup', {
        side: 'home',
        places: [{ player: { jersey: '6', name: 'Soto' }, slot: 'end' }]
      }),
      // An id is no player as said.
      call('c5', 'pinchHitter', { player: 12 })
    ])
    const turn = await new Interpretation(
      config(stub.fetch, { rosterTools }),
      'c',
      'Number 3 subs in at third base, and the Hosts’ Soto, six, bats last'
    ).start()
    expect(turn).deep.equals({
      kind: 'actions',
      actions: [],
      roster: [
        atThird,
        {
          type: 'placeInLineup',
          side: 'home',
          places: [{ player: { jersey: '6', name: 'Soto' }, slot: 'end' }]
        }
      ],
      dropped: [
        {
          code: 'malformed',
          message:
            'setPositions: Expected one of: "away" | "home", got "both" at .side'
        },
        {
          code: 'malformed',
          message: 'placeInLineup: arguments are not an object'
        },
        {
          code: 'malformed',
          message: 'pinchHitter: Expected an object, got 12 at .player'
        }
      ]
    })
  })

  it('says why when no roster call cleans', async function () {
    const stub = provider([call('c1', 'pinchHitter', { player: 'Betts' })])
    const turn = await new Interpretation(
      config(stub.fetch, { rosterTools }),
      'c',
      'Betts pinch hits'
    ).start()
    expect(turn.kind).equals('error')
    expect(turn.kind === 'error' && turn.message).match(
      /^Nothing usable came back: pinchHitter: /
    )
  })

  it('reads a roster tool the scope does not offer as an unknown action', async function () {
    const stub = provider([
      call('c1', 'pinchHitter', { player: { name: 'Betts' } }),
      call('c2', 'pitch', { call: 'B' })
    ])
    const turn = await new Interpretation(
      config(stub.fetch),
      'c',
      'ball'
    ).start()
    expect(turn.kind === 'actions' && turn.actions).deep.equals([ball])
    expect(turn.kind === 'actions' && turn.roster).equals(undefined)
    expect(turn.kind === 'actions' && turn.dropped[0].code).equals(
      'unknownAction'
    )
  })

  it('passes a sentence of both kinds through, for the client to refuse', async function () {
    const stub = provider([
      call('c1', 'pitch', { call: 'B' }),
      call('c2', 'pinchHitter', { player: { name: 'Betts' } })
    ])
    const turn = await new Interpretation(
      config(stub.fetch, { rosterTools }),
      'c',
      'Ball, and Betts pinch hits'
    ).start()
    expect(turn).deep.equals({
      kind: 'actions',
      actions: [ball],
      roster: [pinchHitter],
      dropped: []
    })
  })

  it('reads roster calls a model wrote out as text', async function () {
    const said =
      '{"name": "pinchHitter", "parameters": {"player": {"name": "Betts"}}}'
    const fetchText = (async () =>
      new Response(
        JSON.stringify({ choices: [{ message: { content: said } }] }),
        { status: 200 }
      )) as unknown as typeof fetch
    const turn = await new Interpretation(
      config(fetchText, { rosterTools }),
      'c',
      'Betts pinch hits'
    ).start()
    expect(turn.kind === 'actions' && turn.roster).deep.equals([pinchHitter])
  })

  it('tells a follow-up model the commands recorded so far', async function () {
    const { fetch, sent } = provider(
      [call('c1', 'pinchHitter', { player: { name: 'Betts' } })],
      []
    )
    const turn = await new Interpretation(
      config(fetch, { followUp: true, rosterTools }),
      'c',
      'Betts pinch hits'
    ).start()
    expect(turn.kind === 'actions' && turn.roster).deep.equals([pinchHitter])
    expect(sent[1].body.messages.at(-1)).deep.equals({
      role: 'tool',
      tool_call_id: 'c1',
      content: followUp([pinchHitter])
    })
  })

  it('tells the model to report a roster change as said, and to leave finding the player to the screen', function () {
    const system = systemPrompt()
    expect(system).includes('\nROSTER\n')
    expect(system).match(
      /Report each player just as the scorer said him: a number as jersey, in\s+digits \("number 3" is jersey "3"\), a name as name/
    )
    expect(system).match(
      /Never add a name or a number the scorer did not say, and never give a\s+tag/
    )
    expect(system).match(/A new player joins only through addPlayer/)
    expect(system).match(/Give side only when the scorer says the team/)
    expect(system).match(
      /even when both teams have the name or number: the\s+screen takes a defensive change from the team in the field/
    )
    expect(system).match(
      /Never call askScorer about a roster change, whatever the rules above say\s+about asking: not which team, not which player, not whether to add him/
    )
    expect(system).match(
      /With Mike T\. and Mike B\. listed, "Mike Trout pitches" is setPositions with\s+name "Mike Trout": no question/
    )
    expect(system).match(/Report a name even when ROSTERS shows nobody by it/)
    expect(system).match(
      /The screen finds the\s+player, and asks the scorer\s+itself/
    )
    expect(system).match(/"moves to short" — is setPositions\. Place only/)
    expect(system).match(
      /A\s+pinch hitter or a pinch runner is the one who comes in/
    )
    expect(system).match(/The runner he replaces is named by base alone/)
    expect(system).includes('"forth" is fourth')
    expect(system).match(
      /"Set this lineup" followed by names is setLineup with every name, in the\s+order said/
    )
    expect(system).includes(
      'A sentence carries roster changes or scoring actions, never both.'
    )
    expect(system).includes('Add Jarrett to the lineup')
    expect(system).includes('name "Jared Hale"')
    expect(system).includes('Substitute A for B in the lineup')
    expect(system).includes('the team ROSTERS lists A on')
    // Nothing tells it to find a player's team or id itself.
    expect(system).not.match(/draws on|team is open|one option for each team/)
    expect(ASK_SCORER.function.description).includes(
      'Never about a roster change: the screen finds its players.'
    )
  })

  describe('a question about a roster change', function () {
    const which = (more: Record<string, unknown> = {}): object =>
      call('q1', 'askScorer', {
        question: 'Which number 3?',
        options: [{ label: 'Visitors' }, { label: 'Hosts' }],
        ...more
      })

    it('is turned back to the model once, which then reports the change as said', async function () {
      const stub = provider(
        [which({ about: 'roster' })],
        [call('c2', 'setPositions', atThird)]
      )
      const turn = await new Interpretation(
        config(stub.fetch, { rosterTools }),
        'c',
        'Number 3 subs in at third base'
      ).start()
      expect(turn).deep.equals({
        kind: 'actions',
        actions: [],
        roster: [atThird],
        dropped: []
      })
      expect(stub.sent).to.have.length(2)
      expect(stub.sent[1].body.messages.slice(-2)).deep.equals([
        {
          role: 'assistant',
          content: null,
          tool_calls: [which({ about: 'roster' })]
        },
        { role: 'tool', tool_call_id: 'q1', content: ROSTER_NOT_ASKED }
      ])
      // It must answer with a call.
      expect(stub.sent[1].body.tool_choice).equals('required')
    })

    it('is any question in the roster scope, and one whose options carry a roster change, ids and all', async function () {
      const scope = provider([which()], [call('c2', 'setPositions', atThird)])
      const sheet = await new Interpretation(
        config(scope.fetch, { tools: [], rosterTools }),
        'c',
        'Number 3 plays third'
      ).start()
      expect(sheet.kind === 'actions' && sheet.roster).deep.equals([atThird])
      const carried = provider(
        [
          which({
            options: [
              {
                label: 'Visitors',
                actions: [
                  {
                    type: 'setPositions',
                    side: 'away',
                    places: [{ player: 4, position: '3B' }]
                  }
                ]
              },
              { label: 'Hosts' }
            ]
          })
        ],
        [call('c2', 'setPositions', atThird)]
      )
      const scoring = await new Interpretation(
        config(carried.fetch, { rosterTools }),
        'c',
        'Number 3 subs in at third base'
      ).start()
      expect(scoring.kind === 'actions' && scoring.roster).deep.equals([
        atThird
      ])
    })

    it('goes to the scorer when asked again, and a play’s question goes at once', async function () {
      const twice = provider(
        [which({ about: 'roster' })],
        [which({ about: 'roster' })]
      )
      const again = await new Interpretation(
        config(twice.fetch, { rosterTools }),
        'c',
        'Number 3 subs in at third base'
      ).start()
      expect(again).deep.include({ kind: 'ask', question: 'Which number 3?' })
      expect(twice.sent).to.have.length(2)
      const play = provider([which({ about: 'play' })])
      expect(
        await new Interpretation(
          config(play.fetch, { rosterTools }),
          'c',
          'Number 3 was picked off'
        ).start()
      ).deep.include({ kind: 'ask' })
      expect(play.sent).to.have.length(1)
      // Without roster tools, a question is never turned back.
      const plays = provider([which({ about: 'roster' })])
      expect(
        await new Interpretation(config(plays.fetch), 'c', 'x').start()
      ).deep.include({ kind: 'ask' })
    })

    it('is told apart by the model, in askScorer’s about', function () {
      const { parameters } = ASK_SCORER.function as {
        parameters: {
          required: string[]
          properties: Record<string, { enum?: string[] }>
        }
      }
      expect(parameters.required).deep.equals(['about', 'question', 'options'])
      expect(parameters.properties.about.enum).deep.equals(['play', 'roster'])
    })
  })

  describe('askScorer', function () {
    const ask = (options: unknown): object =>
      call('q1', 'askScorer', { question: 'Which number 3?', options })
    const awayAtThird = { ...atThird, side: 'away' }
    const homeAtThird = { ...atThird, side: 'home' }

    // Asked a second time: the first is turned back to the model.
    it('lets an option carry roster commands, and keeps them only when all clean', async function () {
      const options = [
        { label: 'Home #3', actions: [homeAtThird] },
        { label: 'Away #3', actions: [awayAtThird] },
        { label: 'Both kinds', actions: [ball, pinchHitter] },
        {
          label: 'Half good',
          actions: [homeAtThird, { type: 'setPositions', side: 'home' }]
        },
        { label: 'By id', actions: [{ type: 'pinchHitter', player: 12 }] }
      ]
      const stub = provider([ask(options)], [ask(options)])
      const turn = await new Interpretation(
        config(stub.fetch, { rosterTools }),
        'c',
        'Number 3 subs in at third base'
      ).start()
      expect(turn).deep.equals({
        kind: 'ask',
        question: 'Which number 3?',
        options: [
          { label: 'Home #3', roster: [homeAtThird] },
          { label: 'Away #3', roster: [awayAtThird] },
          { label: 'Both kinds', actions: [ball], roster: [pinchHitter] },
          { label: 'Half good' },
          { label: 'By id' }
        ]
      })
    })

    it('answers with an option’s roster commands and calls nobody', async function () {
      const options = [
        { label: 'Home #3', actions: [homeAtThird] },
        { label: 'Away #3', actions: [awayAtThird] }
      ]
      const stub = provider([ask(options)], [ask(options)])
      const it = new Interpretation(
        config(stub.fetch, { rosterTools }),
        'c',
        'Number 3 subs in at third base'
      )
      await it.start()
      expect(await it.answer(1)).deep.equals({
        kind: 'actions',
        actions: [],
        roster: [awayAtThird],
        dropped: []
      })
      expect(stub.sent).to.have.length(2)
    })
  })
})

describe('dictation interpreter, player tags', function () {
  const GAME = `On first: Ian K. #4 ${writtenTag(4)}. On second: Joe B. #9 ${writtenTag(3)}.\nFielders: SS Noah D. #5 ${writtenTag(14)}, 3B Liam O. #6 ${writtenTag(15)}.`
  const steal = (runner: unknown, to = '3B'): object =>
    call(`s${String(runner)}`, 'baseRunning', { kind: 'steal', runner, to })

  it('reads each player back from his tag, and hands the client ids', async function () {
    const stub = provider([
      steal(tagOf(3)),
      steal(tagOf(4).toLowerCase(), '2B'),
      call('f', 'fieldingPlay', {
        fielders: [tagOf(14), tagOf(15)],
        error: tagOf(15)
      }),
      call('w', 'batteryEvent', {
        kind: 'wild_pitch',
        advances: [{ runner: tagOf(3), to: 'home' }]
      })
    ])
    const turn = await new Interpretation(
      config(stub.fetch),
      GAME,
      'Double steal, then a wild pitch'
    ).start()
    expect(turn).deep.equals({
      kind: 'actions',
      actions: [
        { type: 'baseRunning', kind: 'steal', runner: 3, to: '3B' },
        { type: 'baseRunning', kind: 'steal', runner: 4, to: '2B' },
        { type: 'fieldingPlay', fielders: [14, 15], error: 15 },
        {
          type: 'batteryEvent',
          kind: 'wild_pitch',
          advances: [{ runner: 3, to: 'home' }]
        }
      ],
      dropped: []
    })
    // The model reads tags, never ids.
    const game = stub.sent[0].body.messages[1].content ?? ''
    expect(game).includes(`Joe B. #9 (tag ${tagOf(3)})`)
    expect(game).not.match(/\bid\b/)
  })

  it('drops a call that names a player by a number, a base or a tag the game does not give', async function () {
    const stub = provider([
      steal(3),
      steal('3'),
      steal('3B'),
      steal(tagOf(5)),
      steal(tagOf(3))
    ])
    const turn = await new Interpretation(
      config(stub.fetch),
      GAME,
      'He steals third'
    ).start()
    expect(turn.kind === 'actions' && turn.actions).deep.equals([
      { type: 'baseRunning', kind: 'steal', runner: 3, to: '3B' }
    ])
    // A tag is never repeated to the scorer, not even one of nobody.
    expect(turn.kind === 'actions' && turn.dropped).deep.equals([
      ...[3, '3', '3B'].map(runner => ({
        code: 'unknownPlayer',
        message: `the steal — the runner ${JSON.stringify(runner)} is no player in the game`
      })),
      {
        code: 'unknownPlayer',
        message: 'the steal — the runner is no player in the game'
      }
    ])
  })

  it('reads a fielder said by his position as the player the game lists there, and never a runner', async function () {
    const stub = provider([
      call('b', 'ballInPlay', {
        contact: 'swing',
        trajectory: 'line_drive',
        direction: 'left',
        fielder: 'LF'
      }),
      call('r', 'result', { eventType: 'single' }),
      call('m', 'runnerMovement', {
        runner: tagOf(3),
        to: 'home',
        fielders: ['the left fielder', 'C']
      }),
      steal('SS', '2B')
    ])
    const turn = await new Interpretation(
      config(stub.fetch),
      `${GAME.slice(0, -1)}, LF Max S. #7 ${writtenTag(16)}, C nobody.`,
      'Single to left. Fielded by the left fielder. The runner at second scored.'
    ).start()
    expect(turn.kind === 'actions' && turn.actions).deep.equals([
      {
        type: 'ballInPlay',
        contact: 'swing',
        trajectory: 'line_drive',
        direction: 'left',
        fielder: 16
      },
      { type: 'result', eventType: 'single' }
    ])
    // Nobody catches, and a position names no runner: each said plainly.
    expect(turn.kind === 'actions' && turn.dropped).deep.equals([
      {
        code: 'unknownPlayer',
        message: `the runner's move — a fielder "C" is no player in the game`
      },
      {
        code: 'unknownPlayer',
        message: 'the steal — the runner "SS" is no player in the game'
      }
    ])
  })

  it('names the players of a question and its labels, and never shows the scorer a tag', async function () {
    const stub = provider([
      call('q1', 'askScorer', {
        about: 'play',
        question: `Did ${tagOf(4)} steal, or Joe B. ${writtenTag(3)}?`,
        options: [
          {
            label: `Yes, ${tagOf(4)} steals second`,
            actions: [
              { type: 'baseRunning', kind: 'steal', runner: tagOf(4), to: '2B' }
            ]
          },
          { label: `${tagOf(3)} (Joe B.) steals third` },
          { label: `Double steal: [${tagOf(3)}] and (${tagOf(4)})` },
          { label: `No, ${tagOf(9)} stays` },
          { label: writtenTag(9) }
        ]
      })
    ])
    expect(
      await new Interpretation(
        config(stub.fetch),
        GAME,
        'And he steals.'
      ).start()
    ).deep.equals({
      kind: 'ask',
      question: 'Did Ian K. steal, or Joe B.?',
      options: [
        {
          label: 'Yes, Ian K. steals second',
          actions: [{ type: 'baseRunning', kind: 'steal', runner: 4, to: '2B' }]
        },
        { label: 'Joe B. steals third' },
        { label: 'Double steal: Joe B. and Ian K.' },
        { label: 'No, stays' }
      ]
    })
  })

  it("replaces a runner's move the model sent again after its own undo", async function () {
    const stub = provider([
      call('m1', 'runnerMovement', { runner: tagOf(4), to: '2B' }),
      call('u1', 'undo', {}),
      call('m2', 'runnerMovement', { runner: tagOf(4), to: '3B' })
    ])
    const turn = await new Interpretation(
      config(stub.fetch),
      GAME,
      'He goes first to third'
    ).start()
    expect(turn.kind === 'actions' && turn.actions).deep.equals([
      { type: 'runnerMovement', runner: 4, to: '3B' }
    ])
  })

  it('keeps a relay to the fielding side when GAME lists the whole defense', async function () {
    const positions = ['P', 'C', '1B', '2B', 'SS', '3B', 'LF', 'CF', 'RF']
    const whole = `At bat: Alex L. #1 ${writtenTag(1)}.\nFielders: ${positions
      .map(
        (position, index) =>
          `${position} F${index} #${index} ${writtenTag(10 + index)}`
      )
      .join(', ')}.`
    const move = (): object =>
      call('m', 'runnerMovement', {
        runner: tagOf(1),
        to: '1B',
        fielders: [tagOf(15), tagOf(1), tagOf(12)]
      })
    const turn = await new Interpretation(
      config(provider([move()]).fetch),
      whole,
      'The batter is safe at first'
    ).start()
    // A relay with a player off the defense is none: the screen finds it.
    expect(turn.kind === 'actions' && turn.actions).deep.equals([
      { type: 'runnerMovement', runner: 1, to: '1B' }
    ])
    // A fielding play keeps its fielders when none of them is a defender.
    const play = await new Interpretation(
      config(
        provider([
          call('f', 'fieldingPlay', { fielders: [tagOf(1)], error: tagOf(1) })
        ]).fetch
      ),
      whole,
      'Error'
    ).start()
    expect(play.kind === 'actions' && play.actions).deep.equals([
      { type: 'fieldingPlay', fielders: [1], error: 1 }
    ])
    // With part of the defense, the relay is the model's.
    const part = await new Interpretation(
      config(
        provider([
          call('m', 'runnerMovement', {
            runner: tagOf(4),
            to: '2B',
            fielders: [tagOf(14), tagOf(3), tagOf(15)]
          })
        ]).fetch
      ),
      GAME,
      'He is safe at second'
    ).start()
    expect(part.kind === 'actions' && part.actions).deep.equals([
      { type: 'runnerMovement', runner: 4, to: '2B', fielders: [14, 3, 15] }
    ])
  })

  it('reads a player the model wrote by his whole name as his tag', async function () {
    const stub = provider([
      steal('ian k.', '2B'),
      call('f', 'fieldingPlay', { fielders: ['Noah D.', tagOf(15)] })
    ])
    expect(
      await new Interpretation(
        config(stub.fetch),
        GAME,
        'He steals second, short to third'
      ).start()
    ).deep.equals({
      kind: 'actions',
      actions: [
        { type: 'baseRunning', kind: 'steal', runner: 4, to: '2B' },
        { type: 'fieldingPlay', fielders: [14, 15] }
      ],
      dropped: []
    })
  })

  it('names the players of what a model wrote in place of a call', async function () {
    const fetch = (async () =>
      new Response(
        JSON.stringify({
          choices: [
            {
              message: {
                content: `Cannot tell whether ${tagOf(4)} or ${writtenTag(9)} ran.`
              }
            }
          ]
        }),
        { status: 200 }
      )) as typeof globalThis.fetch
    expect(
      await new Interpretation(config(fetch), GAME, 'He ran').start()
    ).deep.equals({
      kind: 'error',
      message:
        'Nothing to score in "He ran": Cannot tell whether Ian K. or ran.'
    })
  })

  it('reads an option’s players from their tags, and keeps an option naming nobody as its label', async function () {
    const stub = provider([
      call('q1', 'askScorer', {
        question: 'Who stole?',
        options: [
          {
            label: `Joe B. ${writtenTag(3)}`,
            actions: [
              { type: 'baseRunning', kind: 'steal', runner: tagOf(3), to: '3B' }
            ]
          },
          {
            label: 'Ian K.',
            actions: [
              { type: 'baseRunning', kind: 'steal', runner: 4, to: '2B' }
            ]
          }
        ]
      })
    ])
    expect(
      await new Interpretation(config(stub.fetch), GAME, 'He stole').start()
    ).deep.equals({
      kind: 'ask',
      question: 'Who stole?',
      options: [
        {
          label: 'Joe B.',
          actions: [{ type: 'baseRunning', kind: 'steal', runner: 3, to: '3B' }]
        },
        { label: 'Ian K.' }
      ]
    })
  })

  it('tags the players of an older app’s game, which named them by id', async function () {
    expect(withTags('Batter: Ian K. #4 (id 4). Pitcher: X (id 99999).')).equals(
      `Batter: Ian K. #4 ${writtenTag(4)}. Pitcher: X (id 99999).`
    )
    const stub = provider([steal(tagOf(3))])
    const turn = await new Interpretation(
      config(stub.fetch),
      'On second: Joe B. #9 (id 3).',
      'He steals third'
    ).start()
    expect(turn.kind === 'actions' && turn.actions).deep.equals([
      { type: 'baseRunning', kind: 'steal', runner: 3, to: '3B' }
    ])
    expect(stub.sent[0].body.messages[1].content).equals(
      `GAME\nOn second: Joe B. #9 ${writtenTag(3)}.`
    )
  })

  it('tells a follow-up model what it reported, each player by his tag', function () {
    const said = { type: 'pinchRunner', player: { name: 'Soto' }, base: '2B' }
    expect(
      followUp([
        { type: 'baseRunning', kind: 'steal', runner: 3, to: '3B' },
        said as unknown as SaidRosterCommand
      ])
    ).includes(
      `[{"type":"baseRunning","kind":"steal","runner":"${tagOf(3)}","to":"3B"},${JSON.stringify(said)}]`
    )
  })
})
