import { expect } from 'chai'
import { sql } from 'kysely'
import { after, before, beforeEach, describe, it } from 'mocha'

import { TESS_MAX_IMAGE_BYTES } from '../../common/api'
import { HttpError } from '../../common/errors'
import {
  callTools,
  expectValidRequest,
  type FakeModel,
  say,
  type TessWorld,
  tessWorld,
  TOO_LONG
} from '../../test/tessFakes'
import {
  confirmTurn,
  MAX_TOOL_ROUNDS,
  runTurn,
  TOO_LARGE_NOW,
  TOOL_LIMIT,
  type TurnEvent
} from './agent'
import { storeAttachment } from './attachments'
import {
  DESCRIBE_SYSTEM,
  MAX_PICTURES,
  PICTURE_BYTES,
  SUMMARY_SYSTEM
} from './compaction'
import { loadConversation } from './conversation'
import { READING_API, stepLabel } from './stepLabels'
import { PROPOSED } from './tools'
import { TURN_RUNNING } from './turns'
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
    w.setNow(undefined)
  })

  /** The stored conversation, without the moment each message ends with. */
  const stored = async (gumbo = 101): Promise<Message[]> =>
    (await loadConversation(w.h.db, w.userId(gumbo))).messages.map(message => ({
      role: message.role,
      content: message.content.filter(block => block.type !== 'moment')
    }))

  it('stores a text answer, with the cached system prompt, the tools and auto tool choice', async () => {
    const now = new Date('2026-05-02T15:04:31.250Z')
    w.setNow(now)
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
    // The message ends with when it was sent, and the conversation is
    // cached to there.
    expect(request.messages.at(-1).content).deep.equals([
      { type: 'text', text: 'Hi Tess' },
      {
        type: 'text',
        text: `(Sent ${now.toISOString().slice(0, 16)}Z.)`,
        cache_control: { type: 'ephemeral' }
      }
    ])
    // The size of the request and its answer: the next request holds both.
    expect(
      (await loadConversation(w.h.db, w.userId(101))).contextTokens
    ).equals(1020)
  })

  it('sends the same system blocks and earlier messages every turn, so the next turn reads them from the cache', async () => {
    const screen = {
      path: '/teams/tem_account',
      title: 'Demo Hawks',
      stack: [{ path: '/', title: 'Home' }]
    }
    w.setNow(new Date('2026-05-02T15:04:31Z'))
    model.reply(say('Hello!'))
    await runTurn(w.deps(), w.user(101), { text: 'Hi Tess', screen })
    w.setNow(new Date('2026-05-02T17:45:02Z'))
    model.reply(say('Your schedule is on the team page.'))
    await runTurn(w.deps(), w.user(101), {
      text: 'Where is the schedule?',
      screen: { ...screen, path: '/teams/tem_account?tab=schedule' }
    })
    const [first, second] = model.messageCalls()
    expect(JSON.stringify(second.system)).equals(JSON.stringify(first.system))
    expect(JSON.stringify(first.system)).not.includes('2026-05-02')
    expect(JSON.stringify(first.system)).not.includes('tem_account?')
    // The first request, its breakpoint aside, is where the second begins.
    const unmarked = (messages: Block[]): string =>
      JSON.stringify(messages).replace(
        /,"cache_control":\{"type":"ephemeral"\}/g,
        ''
      )
    expect(unmarked(second.messages.slice(0, 1))).equals(
      unmarked(first.messages)
    )
    const moment = first.messages[0].content.at(-1).text as string
    expect(moment).match(
      /^\(Sent 2026-05-02T15:04Z\. Beside this chat they have this page open, reached through these pages: \{.*\}\)$/
    )
    expect(JSON.parse(moment.slice(moment.indexOf('{'), -1))).deep.equals(
      screen
    )
    expect(second.messages.at(-1).content.at(-1).text).match(
      /^\(Sent 2026-05-02T17:45Z\. .*tab=schedule/
    )
    // Neither moment shows in the app.
    const shown = (await loadConversation(w.h.db, w.userId(101))).messages
    expect(
      shown.flatMap(message => message.content.map(block => block.type))
    ).deep.equals(['text', 'moment', 'text', 'text', 'moment', 'text'])
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
    // The round's result ends the cached prefix, and only it.
    expect(result.cache_control).deep.equals({ type: 'ephemeral' })
    expect(JSON.stringify(calls[1].messages.slice(0, -1))).not.includes(
      'cache_control'
    )
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
      'text',
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

  it('clears uploads a day old that no message names before a message, but for the ones it sends', async () => {
    const upload = async (name: string): Promise<string> =>
      (
        await storeAttachment(w.h.db, w.userId(101), {
          name,
          mediaType: 'text/csv',
          data: Buffer.from('game,runs\n1,4').toString('base64')
        })
      ).id
    const forgotten = await upload('forgotten.csv')
    const sending = await upload('sending.csv')
    await w.h.db
      .updateTable('tess_attachments')
      .set({ created_at: sql<Date>`now() - interval '2 days'` })
      .execute()
    model.reply(say('Four runs.'))
    await runTurn(w.deps(), w.user(101), {
      text: 'Read this',
      attachmentIds: [sending]
    })
    expect(
      (await w.h.db.selectFrom('tess_attachments').select('id').execute()).map(
        row => row.id
      )
    ).deep.equals([sending])
    expect(forgotten).not.equals(sending)
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
      last.messages
        .at(-1)
        .content.map((block: Block) => block.text)
        .filter((text: string) => !text.startsWith('(Sent '))
    ).deep.equals(['And?', 'Hello?'])
  })

  it('replaces a tool result that would take the request over the ceiling', async () => {
    model.reply(
      callTools([{ name: 'api_get', input: { path: '/me/roles' } }], {
        input_tokens: 191790
      }),
      say('That was too much to read.')
    )
    await runTurn(w.deps(), w.user(101), { text: 'Read all of it' })
    const result = model.messageCalls()[1].messages.at(-1).content[0]
    expect(result).deep.include({ content: TOO_LARGE_NOW, is_error: true })
  })

  it('counts a round that takes the request near the ceiling, and drops the largest result until it fits', async () => {
    model.reply(
      callTools(
        [
          { name: 'api_get', input: { path: '/me/roles' }, id: 'toolu_small' },
          {
            name: 'api_get',
            input: { path: '/teams/tem_none/games' },
            id: 'toolu_large'
          }
        ],
        { input_tokens: 160000 }
      ),
      say('Here is part of it.')
    )
    // Both fit at their estimate; counted, the round is over the ceiling
    // until the larger result gives way.
    model.count(195000)
    await runTurn(w.deps(), w.user(101), { text: 'Read both' })
    expect(model.calls.map(call => call.path)).deep.equals([
      '/messages',
      '/messages/count_tokens',
      '/messages/count_tokens',
      '/messages'
    ])
    const results = model.messageCalls()[1].messages.at(-1).content as Block[]
    const byId = new Map(results.map(result => [result.tool_use_id, result]))
    const small = byId.get('toolu_small')!
    const large = byId.get('toolu_large')!
    // One gave way, and the other was sent as it was.
    const replaced = [small, large].filter(
      result => result.content === TOO_LARGE_NOW
    )
    expect(replaced).length(1)
    expect(replaced[0].is_error).equals(true)
    expect(
      [small, large].find(result => result !== replaced[0])?.content
    ).match(/^HTTP \d{3}\n/)
  })

  it('compacts and sends again when the provider refuses a request for its length, after a stored round', async () => {
    for (const text of ['one', 'two', 'three']) {
      model.reply(say(`About ${text}`))
      await runTurn(w.deps(), w.user(101), { text })
    }
    model.calls.length = 0
    model.reply(
      callTools([{ name: 'api_get', input: { path: '/me/roles' } }]),
      TOO_LONG,
      say('They said one.'),
      say('You hold no roles.')
    )
    model.count(40000)
    await runTurn(w.deps(), w.user(101), { text: 'What may I do?' })
    expect(model.calls.map(call => call.path)).deep.equals([
      '/messages',
      '/messages',
      '/messages',
      '/messages/count_tokens',
      '/messages'
    ])
    expect(model.messageCalls()[2].system[0].text).equals(SUMMARY_SYSTEM)
    // Sent again from the compacted conversation, with the round kept.
    const retried = model.messageCalls()[3]
    expectValidRequest(retried.messages)
    expect(retried.messages[0].content[0].text).match(/^A summary/)
    expect(retried.messages.at(-1).content[0].type).equals('tool_result')
    const conversation = await loadConversation(w.h.db, w.userId(101))
    expect(conversation.summary).equals('They said one.')
    expect(conversation.messages.at(-1)?.content).deep.equals([
      { type: 'text', text: 'You hold no roles.' }
    ])
    expect(conversation.contextTokens).equals(1020)
  })

  it('marks a conversation still refused once compacted, and the resend compacts it first', async () => {
    model.reply(say('About one'))
    await runTurn(w.deps(), w.user(101), { text: 'one' })
    model.reply(
      callTools([{ name: 'api_get', input: { path: '/me/roles' } }]),
      TOO_LONG,
      TOO_LONG
    )
    model.count(40000)
    try {
      await runTurn(w.deps(), w.user(101), { text: 'What may I do?' })
      expect.fail('the refusal was swallowed')
    } catch (error) {
      expect((error as HttpError).status).equals(503)
    }
    // The round is kept, and the conversation will be compacted before the
    // next message rather than taken at the size it had.
    const marked = await loadConversation(w.h.db, w.userId(101))
    expect(marked.messages.map(message => message.role)).deep.equals([
      'user',
      'assistant',
      'user',
      'assistant',
      'user'
    ])
    expect(marked.contextTokens).greaterThan(150000)

    model.calls.length = 0
    model.reply(say('They asked about one.'), say('You hold no roles.'))
    // The conversation with the message, the message alone, then compacted.
    model.count(160000, 1000, 160000, 30000)
    const compacting: TurnEvent[] = []
    await runTurn(w.deps(), w.user(101), { text: 'Try again' }, event => {
      compacting.push(event)
    })
    // Told before compacting, a model call that takes a while.
    expect(kinds(compacting).slice(0, 2)).deep.equals(['preparing', 'stored'])
    expect(model.calls.map(call => call.path)).deep.equals([
      '/messages/count_tokens',
      '/messages/count_tokens',
      '/messages/count_tokens',
      '/messages',
      '/messages/count_tokens',
      '/messages'
    ])
    expect(model.messageCalls()[0].system[0].text).equals(SUMMARY_SYSTEM)
    const sent = model.messageCalls().at(-1) as Block
    expectValidRequest(sent.messages)
    expect(sent.messages[0].content[0].text).match(/^A summary/)
  })

  /** A PNG of `bytes` bytes, stored for user 101; answers its id. */
  const picture = async (name: string, bytes: number): Promise<string> => {
    const data = Buffer.alloc(bytes, name.length)
    Buffer.from('89504e470d0a1a0a', 'hex').copy(data)
    return (
      await storeAttachment(w.h.db, w.userId(101), {
        name,
        mediaType: 'image/png',
        data: data.toString('base64')
      })
    ).id
  }

  /** What a request's pictures come to in base64, and how many there are. */
  const picturesOf = (
    body: Record<string, any>
  ): { bytes: number; count: number } => {
    let bytes = 0
    let count = 0
    for (const message of body.messages as Message[])
      for (const block of message.content)
        if (block.type === 'image') {
          bytes += String(block.source.data).length
          count += 1
        }
    return { bytes, count }
  }

  const describedIds = async (): Promise<string[]> =>
    (
      await w.h.db
        .selectFrom('tess_attachments')
        .select('id')
        .where('data', 'is', null)
        .orderBy('created_at')
        .execute()
    ).map(row => row.id)

  it('describes the oldest pictures before a request would carry more than one message of them, and answers', async () => {
    const at = TESS_MAX_IMAGE_BYTES
    const first = [] as string[]
    for (const n of [1, 2, 3, 4, 5])
      first.push(await picture(`photo${n}.png`, at))
    model.reply(say('Five photos of the field.'))
    await runTurn(w.deps(), w.user(101), {
      text: 'Here is the field',
      attachmentIds: first
    })
    const later = [
      await picture('dugout.png', at),
      await picture('mound.png', at)
    ]
    model.reply(
      say('Photo one: the infield from home plate.'),
      say('Photo two: the outfield fence.'),
      say('Two more.')
    )
    // Told before the descriptions, model calls that take a while, once.
    const describing: TurnEvent[] = []
    await runTurn(
      w.deps(),
      w.user(101),
      { text: 'And these', attachmentIds: later },
      event => {
        describing.push(event)
      }
    )
    expect(kinds(describing).slice(0, 2)).deep.equals(['preparing', 'stored'])
    expect(kinds(describing).filter(kind => kind === 'preparing')).length(1)
    model.reply(say('The mound looks dry.'))
    const plain: TurnEvent[] = []
    await runTurn(
      w.deps(),
      w.user(101),
      { text: 'How is the mound?' },
      event => {
        plain.push(event)
      }
    )
    expect(kinds(plain)[0]).equals('stored')

    // Seven pictures at the limit are 35 MiB of base64; the two oldest gave
    // way to their descriptions before the second message was measured.
    expect(await describedIds()).deep.equals(first.slice(0, 2))
    const descriptions = model
      .messageCalls()
      .filter(body => body.system[0].text === DESCRIBE_SYSTEM)
    expect(descriptions).length(2)
    for (const call of model.calls) {
      // The whole body, well under the provider's 32 MB.
      expect(JSON.stringify(call.body).length).below(28 * 1000 * 1000)
      expect(picturesOf(call.body).bytes).at.most(PICTURE_BYTES)
    }
    const [, , , second, third] = model.messageCalls()
    for (const body of [second, third]) {
      expectValidRequest(body.messages)
      expect(picturesOf(body)).deep.equals({ bytes: PICTURE_BYTES, count: 5 })
      expect(JSON.stringify(body.messages)).includes(
        'Attachment photo1.png (described): Photo one: the infield from home plate.'
      )
    }
    expect((await stored()).at(-1)?.content).deep.equals([
      { type: 'text', text: 'The mound looks dry.' }
    ])
  })

  it('keeps a request to twenty pictures, the oldest described', async () => {
    const all = [] as string[]
    for (const batch of [0, 1, 2, 3, 4]) {
      const ids = [] as string[]
      for (let n = 0; n < (batch < 4 ? 5 : 1); n += 1)
        ids.push(await picture(`play${batch}${n}.png`, 64))
      all.push(...ids)
      model.reply(
        ...(batch < 4 ? [] : [say('The first play.')]),
        say('Got it.')
      )
      await runTurn(w.deps(), w.user(101), {
        text: `Plays, part ${batch + 1}`,
        attachmentIds: ids
      })
    }
    expect(all).length(MAX_PICTURES + 1)
    expect(await describedIds()).deep.equals([all[0]])
    const last = model.messageCalls().at(-1)!
    expect(picturesOf(last).count).equals(MAX_PICTURES)
    expectValidRequest(last.messages)
  })

  it('describes the attachments and sends again, once, when the provider refuses a request for its bytes', async () => {
    const field = await picture('field.png', 64)
    model.reply(say('A ball field.'))
    await runTurn(w.deps(), w.user(101), {
      text: 'What is this?',
      attachmentIds: [field]
    })
    model.calls.length = 0
    model.reply(
      { status: 413, error: 'request_too_large', message: 'Too many bytes' },
      say('A ball field with a dirt infield.'),
      say('It has a dirt infield.')
    )
    await runTurn(w.deps(), w.user(101), { text: 'Grass or dirt?' })
    expect(model.messageCalls().map(body => body.system[0].text)).deep.equals([
      model.messageCalls()[0].system[0].text,
      DESCRIBE_SYSTEM,
      model.messageCalls()[0].system[0].text
    ])
    expect(picturesOf(model.messageCalls()[0]).count).equals(1)
    const retried = model.messageCalls()[2]
    expectValidRequest(retried.messages)
    expect(picturesOf(retried).count).equals(0)
    expect(JSON.stringify(retried.messages)).includes(
      'Attachment field.png (described): A ball field with a dirt infield.'
    )
    // The conversation is kept whole: nothing was summarized.
    const conversation = await loadConversation(w.h.db, w.userId(101))
    expect(conversation.summary).equals(null)
    expect(conversation.messages.map(message => message.role)).deep.equals([
      'user',
      'assistant',
      'user',
      'assistant'
    ])
    expect((await stored()).at(-1)?.content).deep.equals([
      { type: 'text', text: 'It has a dirt infield.' }
    ])

    // Refused again once described, the turn fails and the message is taken
    // back, so the next one is not wedged behind it.
    model.reply(
      { status: 413, error: 'request_too_large' },
      { status: 413, error: 'request_too_large' }
    )
    try {
      await runTurn(w.deps(), w.user(101), { text: 'And the outfield?' })
      expect.fail('the refusal was swallowed')
    } catch (error) {
      expect((error as HttpError).message).equals(
        "Tess's model answered 413 request_too_large"
      )
    }
    expect((await stored()).length).equals(4)
  })

  it('answers with what she said when the compaction after it fails, and compacts before the next message', async () => {
    for (const text of ['one', 'two', 'three']) {
      model.reply(say(`About ${text}`))
      await runTurn(w.deps(), w.user(101), { text })
    }
    model.reply(say('About four', { input_tokens: 160000 }), {
      status: 529,
      error: 'overloaded_error'
    })
    await runTurn(w.deps(), w.user(101), { text: 'four' })
    const kept = await loadConversation(w.h.db, w.userId(101))
    expect(kept.summary).equals(null)
    expect(kept.messages.at(-1)?.content).deep.equals([
      { type: 'text', text: 'About four' }
    ])
    expect(kept.contextTokens).equals(160020)

    model.calls.length = 0
    model.reply(say('They said one.'), say('About five'))
    model.count(160000, 1000, 30000)
    await runTurn(w.deps(), w.user(101), { text: 'five' })
    expect(model.messageCalls()[0].system[0].text).equals(SUMMARY_SYSTEM)
    expect((await loadConversation(w.h.db, w.userId(101))).summary).equals(
      'They said one.'
    )
  })

  it('leaves out a tool round’s text of nothing but white space, in the next round as in the stored conversation', async () => {
    model.reply(
      {
        content: [
          { type: 'text', text: '\n\n' },
          {
            type: 'tool_use',
            id: 'toolu_blank',
            name: 'api_get',
            input: { path: '/me/roles' }
          }
        ],
        stop_reason: 'tool_use'
      },
      say('You hold no roles.')
    )
    await runTurn(w.deps(), w.user(101), { text: 'What may I do?' })
    const [first, second] = model.messageCalls()
    expectValidRequest(first.messages)
    expectValidRequest(second.messages)
    expect(second.messages.at(-2)).deep.equals({
      role: 'assistant',
      content: [
        {
          type: 'tool_use',
          id: 'toolu_blank',
          name: 'api_get',
          input: { path: '/me/roles' }
        }
      ]
    })
    // The next turn, built from storage, sends the round the same way.
    model.reply(say('Anything else?'))
    await runTurn(w.deps(), w.user(101), { text: 'Thanks' })
    const next = model.messageCalls().at(-1) as Block
    expectValidRequest(next.messages)
    expect(next.messages[1]).deep.equals(second.messages.at(-2))
  })

  it('refuses a file too large for the conversation on its own at once, leaving the conversation as it was', async () => {
    const picture = await storeAttachment(w.h.db, w.userId(101), {
      name: 'chart.png',
      mediaType: 'image/png',
      data: Buffer.concat([
        Buffer.from('89504e470d0a1a0a', 'hex'),
        Buffer.from('pixels')
      ]).toString('base64')
    })
    for (const [text, attachmentIds] of [
      ['one', [picture.id]],
      ['two', []],
      ['three', []],
      ['four', []]
    ] as const) {
      model.reply(say(`About ${text}`))
      await runTurn(w.deps(), w.user(101), { text, attachmentIds })
    }
    const before = await loadConversation(w.h.db, w.userId(101))
    const big = await storeAttachment(w.h.db, w.userId(101), {
      name: 'season.csv',
      mediaType: 'text/csv',
      data: Buffer.from('x,y\n'.repeat(100)).toString('base64')
    })
    model.calls.length = 0
    // With the conversation, then alone: alone it leaves no room for the
    // summary compaction would write.
    model.count(250000, 190000)
    try {
      await runTurn(w.deps(), w.user(101), {
        text: 'Read this',
        attachmentIds: [big.id]
      })
      expect.fail('the attachment was taken')
    } catch (error) {
      expect((error as HttpError).status).equals(413)
      expect((error as HttpError).message).equals(
        'That attachment is too large for the conversation'
      )
    }
    // Two counts and nothing else: nothing described, nothing summarized.
    expect(model.calls.map(call => call.path)).deep.equals([
      '/messages/count_tokens',
      '/messages/count_tokens'
    ])
    expect(model.calls[1].body.messages).deep.equals([
      {
        role: 'user',
        content: [
          { type: 'text', text: 'Read this' },
          {
            type: 'text',
            text: `Attachment season.csv (csv):\n${'x,y\n'.repeat(100)}`
          },
          {
            type: 'text',
            text: model.calls[0].body.messages.at(-1).content.at(-1).text,
            cache_control: { type: 'ephemeral' }
          }
        ]
      }
    ])
    expect(await loadConversation(w.h.db, w.userId(101))).deep.equals(before)
    const pictures = await w.h.db
      .selectFrom('tess_attachments')
      .select(['id', 'description'])
      .where(sql<boolean>`data is not null`)
      .orderBy('created_at')
      .execute()
    expect(pictures.map(row => row.id)).deep.equals([picture.id, big.id])
    expect(pictures.map(row => row.description)).deep.equals([null, null])
  })

  it('takes one turn at a time for a person: a message or a confirm meanwhile is 409, and runs nothing', async () => {
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
    const { id: changeId } = await w.h.db
      .selectFrom('tess_changes')
      .select('id')
      .executeTakeFirstOrThrow()

    let release = (): void => undefined
    const held = new Promise<void>(resolve => {
      release = resolve
    })
    model.reply(async () => {
      await held
      return say('Here you are.')
    })
    const first = runTurn(w.deps(), w.user(101), { text: 'What else?' })
    while (model.messageCalls().length < 3)
      await new Promise(resolve => setTimeout(resolve, 5))
    const refused = async (turn: Promise<unknown>): Promise<HttpError> => {
      try {
        await turn
      } catch (error) {
        return error as HttpError
      }
      return expect.fail('a second turn ran beside the first')
    }
    const second = await refused(
      runTurn(w.deps(), w.user(101), { text: 'And another' })
    )
    expect(second.status).equals(409)
    expect(second.message).equals(TURN_RUNNING)
    const confirm = await refused(confirmTurn(w.deps(), w.user(101), changeId))
    expect(confirm.status).equals(409)
    // The confirm ran nothing: the change is as the first turn left it.
    expect(
      (
        await w.h.db
          .selectFrom('tess_changes')
          .select('status')
          .executeTakeFirstOrThrow()
      ).status
    ).equals('expired')

    // Another person is not held up.
    model.reply(say('Hello.'))
    await runTurn(w.deps(), w.user(102), { text: 'Hi' })

    release()
    await first
    expect(model.messageCalls().length).equals(4)
    model.reply(say('Sure.'))
    await runTurn(w.deps(), w.user(101), { text: 'And another' })
    expect((await stored()).map(message => message.role)).deep.equals([
      'user',
      'assistant',
      'user',
      'assistant',
      'user',
      'assistant',
      'user',
      'assistant'
    ])
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

  it('takes a message back when the model fails before answering, so a resend is its only copy', async () => {
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
    const before = await stored()
    const status = async (): Promise<string[]> =>
      (await w.h.db.selectFrom('tess_changes').select('status').execute()).map(
        row => row.status
      )
    expect(await status()).deep.equals(['pending'])

    model.reply({ status: 529, error: 'overloaded_error' })
    const told: TurnEvent[] = []
    // What is stored when `takenBack` is told: told once it is so.
    let atTakenBack: { messages: number; status: string[] } | undefined
    try {
      await runTurn(
        w.deps(),
        w.user(101),
        { text: 'And the Eagles?' },
        async event => {
          told.push(event)
          if (event.type === 'takenBack')
            atTakenBack = {
              messages: (await stored()).length,
              status: await status()
            }
        }
      )
      expect.fail('the failure was swallowed')
    } catch (error) {
      expect((error as HttpError).status).equals(503)
    }
    expect(told.map(event => event.type)).deep.equals(['stored', 'takenBack'])
    expect(atTakenBack).deep.equals({
      messages: before.length,
      status: ['pending']
    })
    // Nothing of the failed turn is kept, and the card can still be held.
    expect(await stored()).deep.equals(before)
    expect(await status()).deep.equals(['pending'])

    // The app gave the draft back; sent again, it is there once.
    model.reply(say('Following the Eagles needs their page.'))
    await runTurn(w.deps(), w.user(101), { text: 'And the Eagles?' })
    const after = await stored()
    expect(after.slice(0, before.length)).deep.equals(before)
    expect(after.slice(before.length)).deep.equals([
      { role: 'user', content: [{ type: 'text', text: 'And the Eagles?' }] },
      {
        role: 'assistant',
        content: [
          { type: 'text', text: 'Following the Eagles needs their page.' }
        ]
      }
    ])
    expectValidRequest(model.messageCalls().at(-1)?.messages as Message[])
    expect(await status()).deep.equals(['expired'])
  })

  it('keeps a message whose tool round was stored before the model failed', async () => {
    model.reply(
      callTools([{ name: 'api_get', input: { path: '/me/roles' } }]),
      { status: 529, error: 'overloaded_error' }
    )
    const told: string[] = []
    try {
      await runTurn(
        w.deps(),
        w.user(101),
        { text: 'What may I do?' },
        event => {
          told.push(event.type)
        }
      )
      expect.fail('the failure was swallowed')
    } catch (error) {
      expect((error as HttpError).status).equals(503)
    }
    expect(told).includes('stored')
    expect(told).not.includes('takenBack')
    expect((await stored()).map(message => message.role)).deep.equals([
      'user',
      'assistant',
      'user'
    ])
  })

  /** The kinds of `events` in order, a run of one kind told once. */
  const kinds = (events: TurnEvent[]): string[] =>
    events
      .map(event =>
        event.type === 'step' ? `step ${event.id} ${event.status}` : event.type
      )
      .filter((kind, at, all) => at === 0 || all[at - 1] !== kind)
  const joined = (events: TurnEvent[], type: 'thinking' | 'text'): string =>
    events.flatMap(event => (event.type === type ? [event.delta] : [])).join('')

  it('streams every call and tells the turn as it goes: stored, thinking, steps and text', async () => {
    const thinking = (text: string, signature: string): Block => ({
      type: 'thinking',
      thinking: text,
      signature
    })
    const first = [
      thinking('They want their account. I will read it.', 'sig-one'),
      { type: 'text', text: 'Let me check.' },
      {
        type: 'tool_use',
        id: 'toolu_read',
        name: 'api_get',
        input: { path: '/me/roles', query: { team: 'tem_secret_1' } }
      },
      {
        type: 'tool_use',
        id: 'toolu_refused',
        name: 'api_get',
        input: { path: '/me/account' }
      }
    ]
    const last = [
      thinking('One read worked and one was refused.', 'sig-two'),
      { type: 'text', text: 'Here is what I found.' }
    ]
    model.reply(
      { content: first, stop_reason: 'tool_use' },
      { content: last, stop_reason: 'end_turn' }
    )
    const events: TurnEvent[] = []
    const id = await runTurn(
      w.deps(),
      w.user(101),
      { text: 'Who am I?' },
      event => {
        events.push(event)
      }
    )
    expect(kinds(events)).deep.equals([
      'stored',
      'thinking',
      'text',
      'step toolu_read running',
      'step toolu_read done',
      'step toolu_refused running',
      'step toolu_refused failed',
      'thinking',
      'text'
    ])
    expect(events[0]).deep.equals({ type: 'stored', fromId: id })
    // A second block of a kind starts a new paragraph, as the view joins them.
    expect(joined(events, 'thinking')).equals(
      'They want their account. I will read it.\n\nOne read worked and one was refused.'
    )
    expect(joined(events, 'text')).equals(
      'Let me check.\n\nHere is what I found.'
    )
    const steps = events.filter(event => event.type === 'step')
    const reading = stepLabel({ name: 'api_get', input: { path: '/me/roles' } })
    expect(reading).not.equals(READING_API)
    expect(steps.map(step => step.type === 'step' && step.label)).deep.equals([
      reading,
      reading,
      'Not allowed: Tess may not use sign-in, account, device key, test build, OAuth, dictation or Tess routes.',
      'Not allowed: Tess may not use sign-in, account, device key, test build, OAuth, dictation or Tess routes.'
    ])
    expect(JSON.stringify(events)).not.contains('secret')
    // Every call of the turn is streamed, with summarized thinking.
    for (const call of model.messageCalls()) {
      expect(call.stream).equals(true)
      expect(call.thinking.display).equals('summarized')
    }
    // Stored as the model sent it, signatures and all, and sent back so.
    const conversation = await stored()
    expect(conversation[1]).deep.equals({ role: 'assistant', content: first })
    expect(conversation[3]).deep.equals({ role: 'assistant', content: last })
    const replayed = model.messageCalls()[1].messages[1]
    expect(replayed).deep.equals({ role: 'assistant', content: first })
  })

  it('tells a step whose result is too large for the conversation as failed, and streams a turn no one listens to', async () => {
    model.reply(
      callTools(
        [{ name: 'api_get', input: { path: '/me/roles' }, id: 'toolu_big' }],
        { input_tokens: 900000 }
      ),
      say('Too much.')
    )
    const events: TurnEvent[] = []
    await runTurn(w.deps(), w.user(101), { text: 'Everything' }, event => {
      events.push(event)
    })
    expect(kinds(events).filter(kind => kind.startsWith('step'))).deep.equals([
      'step toolu_big running',
      'step toolu_big done',
      'step toolu_big failed'
    ])
    expect((await stored())[2].content[0].content).equals(TOO_LARGE_NOW)
    model.reply(say('Hello.'))
    await runTurn(w.deps(), w.user(102), { text: 'Hi' })
    expect(model.messageCalls().at(-1)!.stream).equals(true)
  })

  it('tells each call at the round cap as a failed step', async () => {
    for (let round = 0; round < MAX_TOOL_ROUNDS; round += 1)
      model.reply(
        callTools([
          { name: 'api_get', input: { path: '/me' }, id: `t${round}` }
        ])
      )
    model.reply(say('That is all I could find.'))
    const events: TurnEvent[] = []
    await runTurn(w.deps(), w.user(101), { text: 'Look everywhere' }, event => {
      events.push(event)
    })
    const last = `t${MAX_TOOL_ROUNDS - 1}`
    expect(
      kinds(events).filter(kind => kind.includes(` ${last} `))
    ).deep.equals([`step ${last} failed`])
    expect(joined(events, 'text').endsWith('That is all I could find.')).equals(
      true
    )
  })

  it('tells a confirmed change as it ended, then Tess’s report on it', async () => {
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
    const proposing: TurnEvent[] = []
    await runTurn(
      w.deps(),
      w.user(101),
      { text: 'Follow the Hawks' },
      event => {
        proposing.push(event)
      }
    )
    expect(
      proposing.flatMap(event => (event.type === 'step' ? [event.label] : []))
    ).deep.equals([
      'Preparing a change for you to confirm',
      'Preparing a change for you to confirm'
    ])
    const { id: changeId } = await w.h.db
      .selectFrom('tess_changes')
      .select('id')
      .executeTakeFirstOrThrow()
    model.reply(say('You now follow Demo Hawks.'))
    const events: TurnEvent[] = []
    const { change, fromId } = await confirmTurn(
      w.deps(),
      w.user(101),
      changeId,
      event => {
        events.push(event)
      }
    )
    expect(kinds(events)).deep.equals(['stored', 'text'])
    expect(events[0]).deep.equals({ type: 'stored', fromId, change })
    expect(change.status).equals('done')
    expect(joined(events, 'text')).equals('You now follow Demo Hawks.')
  })
})
