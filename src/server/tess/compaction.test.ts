import { expect } from 'chai'
import { after, before, beforeEach, describe, it } from 'mocha'

import { asTessConversation } from '../../common/api'
import {
  callTools,
  expectValidRequest,
  type Reply,
  say,
  type TessWorld,
  tessWorld,
  TEST_SETTINGS
} from '../../test/tessFakes'
import { runTurn } from './agent'
import { storeAttachment } from './attachments'
import {
  compact,
  DESCRIBE_SYSTEM,
  SUMMARY_SYSTEM,
  textOf,
  transcriptOf
} from './compaction'
import { loadConversation, type StoredMessage } from './conversation'
import { countTokens } from './messagesApi'

type Block = Record<string, any>

const PNG = Buffer.concat([
  Buffer.from('89504e470d0a1a0a', 'hex'),
  Buffer.from('pixels')
]).toString('base64')

/** A description, naming the attachment it describes. */
const description: Reply = body =>
  say(
    `Described ${String(
      /attachment (\S+) for/.exec(body.messages[0].content[1].text)?.[1]
    )}`
  )

/**
 * Compaction keeps the conversation under the window: above 150,000 tokens
 * attachments become descriptions and everything before the last three turns
 * becomes the summary; a request is never sent above 200,000.
 */
describe("Tess's compaction", function () {
  this.timeout(60000)
  let w: TessWorld

  before(async () => {
    w = await tessWorld()
  })
  after(async () => {
    await w?.close()
  })
  beforeEach(async () => {
    for (const table of [
      'tess_messages',
      'tess_attachments',
      'tess_conversations',
      'tess_changes'
    ] as const)
      await w.h.db.deleteFrom(table).execute()
    expect(w.model.pending()).equals(0)
    w.model.reset()
  })

  const userId = (): string => w.userId(101)
  const attach = async (
    name: string,
    mediaType: string,
    data: string
  ): Promise<string> =>
    (await storeAttachment(w.h.db, userId(), { name, mediaType, data })).id
  const turn = async (
    text: string,
    reply: Reply = say(`About ${text}`),
    attachmentIds: string[] = []
  ): Promise<void> => {
    w.model.reply(reply)
    await runTurn(w.deps(), w.user(101), { text, attachmentIds })
  }
  const systemOf = (body: Block): string => body.system[0].text

  it('compacts above 150,000: describes attachments, summarizes all but the last 3 turns, and sends the summary first', async () => {
    await turn('first', say('About first'), [
      await attach('old.csv', 'text/csv', Buffer.from('a,b').toString('base64'))
    ])
    await turn('second')
    await turn('third')
    w.model.reply(
      say('About fourth', { input_tokens: 150001 }),
      description,
      say('They asked about first, second and third.')
    )
    w.model.count(40000)
    await runTurn(w.deps(), w.user(101), { text: 'fourth' })

    const bodies = w.model.calls.slice(-4)
    expect(bodies.map(call => call.path)).deep.equals([
      '/messages',
      '/messages',
      '/messages',
      '/messages/count_tokens'
    ])
    // The description and the summary are plain requests.
    for (const body of [bodies[1].body, bodies[2].body]) {
      expect(body.tools).equals(undefined)
      expect(body.tool_choice).equals(undefined)
    }
    expect(systemOf(bodies[1].body)).equals(DESCRIBE_SYSTEM)
    expect(systemOf(bodies[2].body)).equals(SUMMARY_SYSTEM)
    const transcript = bodies[2].body.messages[0].content[0].text as string
    expect(transcript).includes('Person: first')
    expect(transcript).includes('Person attached old.csv: Described old.csv')
    expect(transcript).not.includes('second')

    const conversation = await loadConversation(w.h.db, userId())
    expect(conversation.summary).equals(
      'They asked about first, second and third.'
    )
    expect(conversation.contextTokens).equals(40000)
    expect(
      conversation.messages
        .filter(message => message.role === 'user')
        .map(message => (message.content[0] as Block).text)
    ).deep.equals(['second', 'third', 'fourth'])
    const row = await w.h.db
      .selectFrom('tess_attachments')
      .selectAll()
      .executeTakeFirstOrThrow()
    expect(row.data).equals(null)
    expect(row.description).equals('Described old.csv')

    await turn('fifth')
    const next = w.model.messageCalls().at(-1) as Block
    expect(next.messages[0].content[0].text).equals(
      'A summary of our conversation before the messages that follow:\nThey asked about first, second and third.'
    )
    expect(next.messages[1].role).equals('assistant')
    expect(next.messages[2].content[0].text).equals('second')
    expectValidRequest(next.messages)
  })

  it('sends a kept picture and CSV as two described text blocks, with no image and no empty block', async () => {
    await turn('look', say('Looked'), [
      await attach('field.png', 'image/png', PNG),
      await attach(
        'runs.csv',
        'text/csv',
        Buffer.from('1,4').toString('base64')
      )
    ])
    w.model.reply(description, description)
    await compact(w.deps(), userId(), async () => 1000)
    await turn('again')
    const content = (w.model.messageCalls().at(-1) as Block).messages[0]
      .content as Block[]
    expect(content.map(block => block.type)).deep.equals([
      'text',
      'text',
      'text'
    ])
    expect(
      content
        .slice(1)
        .map(block => block.text as string)
        .sort((a, b) => a.localeCompare(b))
    ).deep.equals([
      'Attachment field.png (described): Described field.png',
      'Attachment runs.csv (described): Described runs.csv'
    ])
    expect(content.every(block => block.text.trim() !== '')).equals(true)
    const shown = asTessConversation(
      await (await w.h.request('GET', '/me/tess')).json()
    ).messages[0].attachments
    expect(shown.map(attachment => attachment.described)).deep.equals([
      true,
      true
    ])
  })

  it('cuts on a turn boundary, never between a tool call and its result', async () => {
    // Each turn asks for a tool, then answers.
    for (const text of ['one', 'two', 'three', 'four'])
      await turn(
        text,
        callTools([{ name: 'api_get', input: { path: '/me/roles' } }])
      )
    w.model.reply(say('Summary of turn one.'))
    await compact(w.deps(), userId(), async () => 1000)
    const conversation = await loadConversation(w.h.db, userId())
    expect((conversation.messages[0].content[0] as Block).text).equals('two')
    await turn('five')
    const request = w.model.messageCalls().at(-1) as Block
    expectValidRequest(request.messages)
    // The summary pair, then turn two's message and its tool call.
    expect(request.messages[2].content[0].text).equals('two')
  })

  it('does nothing below 150,000', async () => {
    await turn('one', say('Fine', { input_tokens: 150000 }))
    expect(w.model.calls.map(call => call.path)).deep.equals(['/messages'])
    expect((await loadConversation(w.h.db, userId())).summary).equals(null)
  })

  it('compacts a long conversation before a message without attachments, from its stored size', async () => {
    for (const text of ['one', 'two', 'three', 'four']) await turn(text)
    await w.h.db
      .updateTable('tess_conversations')
      .set({ context_tokens: 170000 })
      .execute()
    w.model.calls.length = 0
    w.model.reply(say('Summary of one.'), say('About five'))
    w.model.count(30000)
    await runTurn(w.deps(), w.user(101), { text: 'five' })
    expect(w.model.calls.map(call => call.path)).deep.equals([
      '/messages',
      '/messages/count_tokens',
      '/messages'
    ])
    expect(systemOf(w.model.calls[0].body)).equals(SUMMARY_SYSTEM)
  })

  it('keeps only the last turn when the last three are still too large', async () => {
    for (const text of ['one', 'two', 'three', 'four']) await turn(text)
    w.model.calls.length = 0
    w.model.reply(say('Summary of one.'), say('Summary of one to three.'))
    w.model.count(160000, 20000)
    const measure = async (): Promise<number> =>
      await countTokens(
        TEST_SETTINGS,
        { system: [], messages: [] },
        {
          fetch: w.model.fetch
        }
      )
    expect(await compact(w.deps(), userId(), measure)).equals(20000)
    const conversation = await loadConversation(w.h.db, userId())
    expect(conversation.summary).equals('Summary of one to three.')
    expect(
      conversation.messages.map(message => (message.content[0] as Block).text)
    ).deep.equals(['four', 'About four'])
    // The second summary starts from the first.
    expect(w.model.messageCalls()[1].messages[0].content[0].text).match(
      /^The summary so far:\nSummary of one\./
    )
  })

  it('refuses an attachment that would take the conversation over 200,000, and keeps neither it nor the message', async () => {
    await turn('one')
    const big = await attach(
      'huge.csv',
      'text/csv',
      Buffer.from('x,y\n'.repeat(100)).toString('base64')
    )
    const before = (await loadConversation(w.h.db, userId())).messages.length
    w.model.calls.length = 0
    // Over 150,000 with it; compaction finds nothing to summarize and the
    // measure is still over 200,000.
    w.model.count(250000, 230000)
    const answer = await w.h.request('POST', '/me/tess/messages', {
      text: 'Read this',
      attachmentIds: [big]
    })
    expect(answer.status).equals(413)
    expect(((await answer.json()) as { message: string }).message).equals(
      'That attachment is too large for the conversation'
    )
    expect((await loadConversation(w.h.db, userId())).messages.length).equals(
      before
    )
    expect(
      await w.h.db.selectFrom('tess_attachments').select('id').execute()
    ).deep.equals([])
    expect(
      w.model.calls.filter(call => call.path === '/messages').length
    ).equals(0)
  })

  it('writes every kind of block into the summary’s transcript', function () {
    const at = new Date()
    const messages: StoredMessage[] = [
      {
        id: 1,
        role: 'user',
        createdAt: at,
        content: [
          { type: 'text', text: 'Hello' },
          { type: 'text', text: ' ' },
          { type: 'attachment', id: 'att_gone' }
        ]
      },
      {
        id: 2,
        role: 'assistant',
        createdAt: at,
        content: [
          {
            type: 'tool_use',
            id: 't1',
            name: 'api_get',
            input: { path: 'x'.repeat(2000) }
          },
          { type: 'change', id: 'chg_1' }
        ]
      },
      {
        id: 3,
        role: 'user',
        createdAt: at,
        content: [
          {
            type: 'tool_result',
            tool_use_id: 't1',
            content: 'HTTP 404',
            is_error: true
          },
          {
            type: 'tool_result',
            tool_use_id: 't2',
            content: [
              { type: 'text', text: 'rows' },
              {
                type: 'image',
                source: { type: 'base64', media_type: 'image/png', data: '' }
              }
            ]
          }
        ]
      },
      {
        id: 4,
        role: 'user',
        createdAt: at,
        content: [
          { type: 'confirmation', changeId: 'chg_1', text: 'Confirmed' }
        ]
      }
    ]
    const lines = transcriptOf(messages, new Map()).split('\n')
    expect(lines[0]).equals('Person: Hello')
    expect(lines[1]).equals('Person attached a file: not described')
    expect(lines[2]).match(/^Tess used api_get \{"path":"x+…$/)
    expect(lines[2].length).lessThan(1600)
    expect(lines.slice(3)).deep.equals([
      'Tool error: HTTP 404',
      'Tool result: rows [image]',
      'Note: Confirmed'
    ])
    expect(
      textOf({
        content: [],
        stopReason: 'end_turn',
        usage: {
          inputTokens: 0,
          outputTokens: 0,
          cacheCreationInputTokens: 0,
          cacheReadInputTokens: 0
        }
      })
    ).equals('')
  })

  it('keeps a description and a summary even when the model writes nothing', async () => {
    await turn('one', say('ok'), [
      await attach(
        'a.txt',
        'text/plain',
        Buffer.from('note').toString('base64')
      )
    ])
    await turn('two')
    await turn('three')
    await turn('four')
    await w.h.db
      .updateTable('tess_conversations')
      .set({ summary: 'Earlier things.' })
      .execute()
    w.model.reply({ content: [] }, { content: [] })
    await compact(w.deps(), userId(), async () => 1000)
    const row = await w.h.db
      .selectFrom('tess_attachments')
      .select('description')
      .executeTakeFirstOrThrow()
    expect(row.description).equals(
      'a.txt, a text file that could not be described.'
    )
    expect((await loadConversation(w.h.db, userId())).summary).equals(
      'Earlier things.'
    )
  })
})
