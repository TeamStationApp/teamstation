import { expect } from 'chai'
import { after, before, beforeEach, describe, it } from 'mocha'

import { HttpError } from '../../common/errors'
import {
  callTools,
  expectValidRequest,
  type FakeModel,
  say,
  type TessWorld,
  tessWorld
} from '../../test/tessFakes'
import { MAX_TOOL_ROUNDS, runTurn, TOO_LARGE_NOW, TOOL_LIMIT } from './agent'
import { storeAttachment } from './attachments'
import { loadConversation } from './conversation'
import { PROPOSED } from './tools'
import { usageWeeks } from './usage'

type Block = Record<string, any>
interface Message {
  role: string
  content: Block[]
}

describe("Tess's agent loop", function () {
  this.timeout(60000)
  let w: TessWorld
  let model: FakeModel

  before(async () => {
    w = await tessWorld()
    model = w.model
  })
  after(async () => {
    await w?.close()
  })
  beforeEach(async () => {
    for (const table of [
      'tess_messages',
      'tess_changes',
      'tess_attachments',
      'tess_conversations',
      'tess_usage_weeks'
    ] as const)
      await w.h.db.deleteFrom(table).execute()
    model.calls.length = 0
    expect(model.pending()).equals(0)
  })

  const stored = async (gumbo = 101): Promise<Message[]> =>
    (await loadConversation(w.h.db, w.userId(gumbo))).messages.map(message => ({
      role: message.role,
      content: message.content
    }))

  it('stores a text answer, with the cached system prompt, the tools and auto tool choice', async () => {
    model.reply(say('Hello! What can I find for you?'))
    const id = await runTurn(w.deps(), w.user(101), { text: '  Hi Tess  ' })
    expect(id).to.be.a('number')
    expect(await stored()).deep.equals([
      { role: 'user', content: [{ type: 'text', text: 'Hi Tess' }] },
      {
        role: 'assistant',
        content: [{ type: 'text', text: 'Hello! What can I find for you?' }]
      }
    ])
    const [request] = model.messageCalls()
    expect(request.model).equals('claude-sonnet-5-5')
    expect(request.system).length(3)
    expect(request.system[0].cache_control).deep.equals({ type: 'ephemeral' })
    expect(request.system[1].cache_control).deep.equals({ type: 'ephemeral' })
    expect(request.system[2].cache_control).equals(undefined)
    expect(request.tools.map((tool: Block) => tool.name)).deep.equals([
      'api_get',
      'confirmChange'
    ])
    expect(request.tool_choice).deep.equals({ type: 'auto' })
    expect(
      (await loadConversation(w.h.db, w.userId(101))).contextTokens
    ).equals(1000)
  })

  it('reads the API with api_get as the person, and sends the result back', async () => {
    model.reply(
      callTools([
        { name: 'api_get', input: { path: '/me/roles' }, id: 'toolu_roles' }
      ]),
      say('You hold no roles yet.')
    )
    await runTurn(w.deps(), w.user(101), { text: 'What may I do?' })
    const calls = model.messageCalls()
    expect(calls).length(2)
    const result = calls[1].messages.at(-1).content[0]
    expect(result).deep.include({
      type: 'tool_result',
      tool_use_id: 'toolu_roles'
    })
    expect(result.content).match(/^HTTP 200\n\{"teams":/)
    expectValidRequest(calls[1].messages)
    const messages = await stored()
    expect(messages.map(message => message.role)).deep.equals([
      'user',
      'assistant',
      'user',
      'assistant'
    ])
    // Every call counted, input and output apart.
    const [week] = await usageWeeks(w.h.db, w.userId(101))
    expect(week).deep.include({
      inputTokens: 2000,
      outputTokens: 50,
      requests: 2
    })
  })

  it('answers a refused or malformed tool call with an error the model reads', async () => {
    model.reply(
      callTools([
        { name: 'api_get', input: { path: '/me/account' }, id: 'toolu_a' },
        { name: 'api_get', input: { route: '/teams' }, id: 'toolu_b' },
        { name: 'confirmChange', input: { method: 'GET' }, id: 'toolu_c' },
        { name: 'sing', input: {}, id: 'toolu_d' },
        {
          name: 'api_get',
          input: { path: '/teams/tem_none/games' },
          id: 'toolu_e'
        },
        {
          name: 'confirmChange',
          input: { method: 'PUT', path: '/me/follows/team/t1', summary: ' ' },
          id: 'toolu_f'
        },
        {
          name: 'confirmChange',
          input: {
            method: 'PUT',
            path: '/me/follows/team/t1',
            summary: 'Follow',
            body: { note: 'x'.repeat(100001) }
          },
          id: 'toolu_g'
        },
        {
          name: 'confirmChange',
          input: {
            method: 'POST',
            path: '/me/account/emails/request',
            summary: 'Add an address'
          },
          id: 'toolu_h'
        }
      ]),
      say('I cannot do that.')
    )
    await runTurn(w.deps(), w.user(101), { text: 'Change my password' })
    const results = model.messageCalls()[1].messages.at(-1).content as Block[]
    expect(results.map(result => result.is_error)).deep.equals(
      Array(8).fill(true)
    )
    expect(results[0].content).includes('account')
    expect(results[1].content).includes('api_get takes')
    expect(results[2].content).includes('confirmChange takes')
    expect(results[3].content).includes('no tool called sing')
    expect(results[4].content).match(/^HTTP 404/)
    expect(results[5].content).includes('summary')
    expect(results[6].content).includes('too large')
    expect(results[7].content).includes('account')
    expect(
      await w.h.db.selectFrom('tess_changes').select('id').execute()
    ).deep.equals([])
  })

  it('closes the round at the tenth tool response, so the next turn is valid', async () => {
    for (let round = 0; round < MAX_TOOL_ROUNDS; round += 1)
      model.reply(
        callTools([{ name: 'api_get', input: { path: '/me/roles' } }])
      )
    model.reply(say('Here is what I found.'))
    await runTurn(w.deps(), w.user(101), { text: 'Look everything up' })
    const calls = model.messageCalls()
    expect(calls).length(MAX_TOOL_ROUNDS + 1)
    expect(
      calls.slice(0, -1).every(call => call.tool_choice.type === 'auto')
    ).equals(true)
    const closing = calls.at(-1) as Block
    expect(closing.tool_choice).deep.equals({ type: 'none' })
    expect(closing.tools).length(2)
    const limited = closing.messages.at(-1).content[0]
    expect(limited).deep.include({ content: TOOL_LIMIT, is_error: true })
    expectValidRequest(closing.messages)
    const messages = await stored()
    expect(messages.at(-1)).deep.equals({
      role: 'assistant',
      content: [{ type: 'text', text: 'Here is what I found.' }]
    })

    model.reply(say('Anything else?'))
    await runTurn(w.deps(), w.user(101), { text: 'Thanks' })
    expectValidRequest(model.messageCalls().at(-1)?.messages as Message[])
  })

  it('expires the changes the person did not confirm when they say something new', async () => {
    model.reply(
      callTools([
        {
          name: 'confirmChange',
          input: {
            method: 'PUT',
            path: '/me/follows/team/tem_account',
            summary: 'Follow Demo Hawks'
          }
        }
      ]),
      say('Hold Confirm to follow Demo Hawks.')
    )
    await runTurn(w.deps(), w.user(101), { text: 'Follow the Hawks' })
    const result = model.messageCalls()[1].messages.at(-1).content[0]
    expect(result.content).equals(PROPOSED)
    const status = async (): Promise<string[]> =>
      (await w.h.db.selectFrom('tess_changes').select('status').execute()).map(
        row => row.status
      )
    expect(await status()).deep.equals(['pending'])
    model.reply(say('Sure.'))
    await runTurn(w.deps(), w.user(101), { text: 'Never mind' })
    expect(await status()).deep.equals(['expired'])
  })

  it('expands attachments: a picture as an image block, a CSV as text', async () => {
    const picture = await storeAttachment(w.h.db, w.userId(101), {
      name: 'field.png',
      mediaType: 'image/png',
      data: Buffer.concat([
        Buffer.from('89504e470d0a1a0a', 'hex'),
        Buffer.from('pixels')
      ]).toString('base64')
    })
    const runs = await storeAttachment(w.h.db, w.userId(101), {
      name: 'runs.csv',
      mediaType: 'text/csv',
      data: Buffer.from('game,runs\n1,4').toString('base64')
    })
    model.reply(say('Four runs in game one.'))
    await runTurn(w.deps(), w.user(101), {
      text: 'What do these say?',
      attachmentIds: [picture.id, runs.id]
    })
    // Measured before it was sent, because it brought attachments.
    expect(model.calls.map(call => call.path)).deep.equals([
      '/messages/count_tokens',
      '/messages'
    ])
    const content = model.messageCalls()[0].messages.at(-1).content as Block[]
    expect(content.map(block => block.type)).deep.equals([
      'text',
      'image',
      'text'
    ])
    expect(content[1].source.media_type).equals('image/png')
    expect(content[2].text).equals('Attachment runs.csv (csv):\ngame,runs\n1,4')
    expect((await stored())[0].content).deep.equals([
      { type: 'text', text: 'What do these say?' },
      { type: 'attachment', id: picture.id },
      { type: 'attachment', id: runs.id }
    ])
  })

  it('stores an off-topic exchange in which no tool was called as text alone', async () => {
    model.reply(say('I can only help with TeamStation.'))
    await runTurn(w.deps(), w.user(101), { text: 'Write me a poem about cats' })
    const messages = await stored()
    expect(
      messages.flatMap(message => message.content.map(block => block.type))
    ).deep.equals(['text', 'text'])
  })

  it('leaves out a tool call cut off by the token limit, and an empty answer', async () => {
    model.reply({
      content: [
        { type: 'text', text: 'Partly' },
        { type: 'tool_use', id: 'toolu_cut', name: 'api_get', input: {} }
      ],
      stop_reason: 'max_tokens'
    })
    await runTurn(w.deps(), w.user(101), { text: 'Tell me everything' })
    expect((await stored()).at(-1)).deep.equals({
      role: 'assistant',
      content: [{ type: 'text', text: 'Partly' }]
    })
    model.reply({ content: [{ type: 'text', text: ' ' }] })
    await runTurn(w.deps(), w.user(101), { text: 'And?' })
    expect((await stored()).at(-1)?.role).equals('user')
    // Two of the person's messages in a row are sent as one.
    model.reply(say('Yes?'))
    await runTurn(w.deps(), w.user(101), { text: 'Hello?' })
    const last = model.messageCalls().at(-1) as Block
    expectValidRequest(last.messages)
    expect(
      last.messages.at(-1).content.map((block: Block) => block.text)
    ).deep.equals(['And?', 'Hello?'])
  })

  it('replaces a tool result that would take the request over the ceiling', async () => {
    model.reply(
      callTools([{ name: 'api_get', input: { path: '/me/roles' } }], {
        input_tokens: 189990
      }),
      say('That was too much to read.')
    )
    await runTurn(w.deps(), w.user(101), { text: 'Read all of it' })
    const result = model.messageCalls()[1].messages.at(-1).content[0]
    expect(result).deep.include({ content: TOO_LARGE_NOW, is_error: true })
  })

  it('refuses an empty message, and passes on the model’s failure', async () => {
    try {
      await runTurn(w.deps(), w.user(101), { text: '   ' })
      expect.fail('an empty message was taken')
    } catch (error) {
      expect((error as HttpError).code).equals('badRequest')
    }
    model.reply({ status: 529, error: 'overloaded_error' })
    try {
      await runTurn(w.deps(), w.user(101), { text: 'Hello' })
      expect.fail('the failure was swallowed')
    } catch (error) {
      expect(error).instanceOf(HttpError)
      expect((error as HttpError).status).equals(503)
    }
  })
})
