import type { AddressInfo } from 'node:net'

import { expect } from 'chai'
import express from 'express'
import type { KyselyPlugin } from 'kysely'
import { after, before, beforeEach, describe, it } from 'mocha'

import {
  asTessAttachment,
  asTessConversation,
  asTessMessage,
  TeamStationClient,
  TESS_MAX_IMAGE_BYTES as MAX_IMAGE_BYTES
} from '../../common/api'
import { HttpError } from '../../common/errors'
import { userIdOfGumbo } from '../../common/userId'
import {
  callTools,
  readTurnStream,
  say,
  type TessWorld,
  tessWorld,
  TEST_SETTINGS,
  type TurnStreamEvent
} from '../../test/tessFakes'
import { hashToken, makeToken } from '../auth/tokens'
import { jsonBody } from '../jsonBody'
import { TESS_HEADER, withActor } from '../middleware/withAuth'
import { errorHandler } from '../middleware/withErrors'
import type { TurnEvents } from '../tess/agent'
import { ownedAttachments } from '../tess/attachments'
import { appendMessages, saveContextTokens } from '../tess/conversation'
import { weekStartUtc } from '../tess/usage'
import { KEEP_ALIVE_MS, tessRoutes, turnStream } from './tess'

const PNG = Buffer.concat([
  Buffer.from('89504e470d0a1a0a', 'hex'),
  Buffer.from('pixels')
])

/**
 * Tess's routes under `/me/tess`, end to end through the real middleware:
 * a session, the body limits, the conversation and the client's methods.
 */
describe("Tess's routes", function () {
  this.timeout(60000)
  let w: TessWorld
  let off: TessWorld

  before(async () => {
    w = await tessWorld()
    off = await tessWorld({ settings: null })
  })
  after(async () => {
    await w?.close()
    await off?.close()
  })
  beforeEach(async () => {
    for (const table of [
      'tess_messages',
      'tess_attachments',
      'tess_conversations',
      'tess_changes',
      'tess_usage_weeks'
    ] as const)
      await w.h.db.deleteFrom(table).execute()
    expect(w.model.pending()).equals(0)
    w.model.reset()
  })

  const client = (gumbo = 101): TeamStationClient =>
    new TeamStationClient({
      baseUrl: `${w.h.origin}/api/v1`,
      token: w.h.tokens.get(gumbo)
    })

  it('needs a session on every route', async () => {
    for (const [method, path] of [
      ['GET', '/me/tess'],
      ['POST', '/me/tess/messages'],
      ['POST', '/me/tess/attachments'],
      ['POST', '/me/tess/changes/00000000-0000-4000-8000-000000000001/confirm'],
      ['GET', '/me/tess/usage']
    ] as const) {
      const answer = await w.h.request(
        method,
        path,
        method === 'GET' ? undefined : {},
        null
      )
      expect(answer.status, `${method} ${path}`).equals(401)
    }
  })

  it('answers 503 on every route when the server has no key for Tess', async () => {
    for (const [method, path] of [
      ['GET', '/me/tess'],
      ['POST', '/me/tess/messages'],
      ['POST', '/me/tess/attachments'],
      ['POST', '/me/tess/changes/00000000-0000-4000-8000-000000000001/confirm'],
      ['GET', '/me/tess/usage']
    ] as const) {
      const answer = await off.h.request(
        method,
        path,
        method === 'GET' ? undefined : { text: 'Hi' }
      )
      expect(answer.status, `${method} ${path}`).equals(503)
    }
  })

  it('refuses a machine token, and a request Tess’s own tools sent', async () => {
    const token = makeToken()
    await w.h.db
      .insertInto('api_tokens')
      .values({
        id: 'tok_machine',
        user_id: w.userId(101),
        label: 'A script',
        token_hash: hashToken(token)
      })
      .execute()
    const machine = await w.h.request('GET', '/me/tess', undefined, token)
    expect(machine.status).equals(403)
    const own = await fetch(`${w.h.origin}/api/v1/me/tess`, {
      headers: {
        authorization: `Bearer ${w.h.tokens.get(101) ?? ''}`,
        [TESS_HEADER]: '1'
      }
    })
    expect(own.status).equals(403)
  })

  it('holds a conversation: send, read back, and the week’s usage', async () => {
    const api = client()
    expect(await api.tess()).deep.equals({
      available: true,
      messages: [],
      contextTokens: 0,
      answering: false
    })
    w.model.reply(say('Hello!', { input_tokens: 1200, output_tokens: 7 }))
    const sent = await api.sendTessMessage('Hi Tess', {
      screen: {
        path: '/teams/tem_account',
        title: 'Demo Hawks',
        stack: [{ path: '/', title: 'Home' }]
      }
    })
    expect(sent.map(message => [message.role, message.text])).deep.equals([
      ['user', 'Hi Tess'],
      ['assistant', 'Hello!']
    ])
    // The screen goes with the message, not in the system prompt.
    const [request] = w.model.messageCalls()
    expect(JSON.stringify(request.system)).not.includes('tem_account"')
    expect(request.messages.at(-1).content.at(-1).text).includes(
      '"path":"/teams/tem_account"'
    )

    const conversation = await api.tess()
    expect(conversation.messages).deep.equals(sent)
    // The request and its answer, which the next request holds.
    expect(conversation.contextTokens).equals(1207)
    expect(await api.tessUsage()).deep.equals([
      {
        weekStart: weekStartUtc(new Date()),
        inputTokens: 1200,
        outputTokens: 7,
        requests: 1
      }
    ])
    // Another person sees their own, empty, conversation.
    expect((await client(102).tess()).messages).deep.equals([])
  })

  it('says whether Tess is answering, and shows a message with the id the app sent it with', async () => {
    // A reply that takes as long as the test lets it, as a long turn does
    // while the app's request has given up waiting.
    let answer: () => void = () => undefined
    const answered = new Promise<void>(resolve => {
      answer = resolve
    })
    w.model.reply(async () => {
      await answered
      return say('Here it is.')
    })
    const sending = client().sendTessMessage('A long question', {
      clientId: 'msg-1'
    })
    let conversation = await client().tess()
    for (let tries = 0; conversation.messages.length === 0; tries += 1) {
      expect(tries).lessThan(200)
      await new Promise(resolve => setTimeout(resolve, 10))
      conversation = await client().tess()
    }
    expect(conversation.answering).equals(true)
    expect(conversation.messages).length(1)
    expect(conversation.messages[0]).deep.include({
      text: 'A long question',
      clientId: 'msg-1'
    })
    // Another person's conversation is not held.
    expect((await client(102).tess()).answering).equals(false)
    answer()
    await sending
    conversation = await client().tess()
    expect(conversation.answering).equals(false)
    expect(conversation.messages.map(message => message.text)).deep.equals([
      'A long question',
      'Here it is.'
    ])
    // Tess's reply carries none.
    expect(conversation.messages[1]).not.to.have.property('clientId')
    // The model never sees it.
    expect(JSON.stringify(w.model.messageCalls())).not.includes('msg-1')
  })

  it('answers the new message and everything after it, Tess’s tool rounds as one reply', async () => {
    w.model.reply(say('First answer.'))
    await client().sendTessMessage('First')
    w.model.reply(
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
      say('Hold Confirm to follow them.')
    )
    const sent = await client().sendTessMessage('Follow the Hawks')
    expect(sent).length(2)
    expect(sent[1].text).equals('Let me check.\n\nHold Confirm to follow them.')
    expect(sent[1].changes.map(change => change.summary)).deep.equals([
      'Follow Demo Hawks'
    ])
    const confirmed = await client().confirmTessChange(sent[1].changes[0].id)
    expect(confirmed.change.status).equals('done')
  })

  it('links the players Tess names by what the API told her, in every answer, and stores her words as they were', async () => {
    const gwynn = userIdOfGumbo(107)
    await appendMessages(w.h.db, w.userId(101), [
      { role: 'user', content: [{ type: 'text', text: 'Who plays short?' }] },
      {
        role: 'assistant',
        content: [
          {
            type: 'tool_use',
            id: 'toolu_roster',
            name: 'api_get',
            input: { path: '/teams/tem_account/roster' }
          }
        ]
      },
      {
        role: 'user',
        content: [
          {
            type: 'tool_result',
            tool_use_id: 'toolu_roster',
            content: `HTTP 200\n${JSON.stringify([{ userId: gwynn, shortName: 'Tony G', isPlayer: true, section: 'player' }])}`
          }
        ]
      },
      {
        role: 'assistant',
        content: [{ type: 'text', text: 'Tony G plays short.' }]
      }
    ])
    const link = `[Tony G](/players/${gwynn})`
    expect((await client().tess()).messages.map(each => each.text)).deep.equals(
      ['Who plays short?', `${link} plays short.`]
    )
    // A later answer, which the route reads from its own message on, still
    // knows him from the roster read before it.
    w.model.reply(say('Tony G bats left.'))
    const sent = await client().sendTessMessage('How does he bat?')
    expect(sent.map(each => each.text)).deep.equals([
      'How does he bat?',
      `${link} bats left.`
    ])
    const stored = await w.h.db
      .selectFrom('tess_messages')
      .select('content')
      .where('role', '=', 'assistant')
      .orderBy('id')
      .execute()
    expect(JSON.stringify(stored)).not.includes('/players/')
  })

  it('reads the names Tess links once a turn, from the messages that carry them, and none to show a stored message', async () => {
    const gwynn = userIdOfGumbo(107)
    await appendMessages(w.h.db, w.userId(101), [
      { role: 'user', content: [{ type: 'text', text: 'Who plays short?' }] },
      {
        role: 'assistant',
        content: [
          {
            type: 'tool_use',
            id: 'toolu_roster',
            name: 'api_get',
            input: { path: '/teams/tem_account/roster' }
          }
        ]
      },
      {
        role: 'user',
        content: [
          {
            type: 'tool_result',
            tool_use_id: 'toolu_roster',
            content: `HTTP 200\n${JSON.stringify([{ userId: gwynn, shortName: 'Tony G', isPlayer: true, section: 'player' }])}`
          }
        ]
      },
      {
        role: 'assistant',
        content: [{ type: 'text', text: 'Tony G plays short.' }]
      }
    ])
    // The statements this copy of the routes runs.
    const statements: string[] = []
    const spy: KyselyPlugin = {
      transformQuery: args => {
        statements.push(
          w.h.db.getExecutor().compileQuery(args.node, args.queryId).sql
        )
        return args.node
      },
      transformResult: async args => args.result
    }
    const db = w.h.db.withPlugin(spy)
    const app = express()
    app.use(jsonBody)
    app.use(withActor(db))
    app.use(
      '/api/v1',
      tessRoutes(db, {
        settings: TEST_SETTINGS,
        origin: () => w.h.origin,
        fetch: w.model.fetch
      })
    )
    app.use(errorHandler)
    const server = app.listen(0, '127.0.0.1')
    await new Promise(resolve => server.once('listening', resolve))
    const nameReads = (): number =>
      statements.filter(
        statement =>
          statement.includes('"tess_messages"') && statement.includes('@>')
      ).length
    try {
      const { port } = server.address() as AddressInfo
      w.model.reply(say('Tony G bats left.'))
      const events = await readTurnStream(
        await fetch(`http://127.0.0.1:${port}/api/v1/me/tess/messages`, {
          method: 'POST',
          headers: {
            authorization: `Bearer ${w.h.tokens.get(101) ?? ''}`,
            accept: 'text/event-stream',
            'content-type': 'application/json'
          },
          body: JSON.stringify({ text: 'How does he bat?' })
        })
      )
      const stored = events.find(event => event.event === 'stored')!
      expect(
        stored.data.messages.map((each: { text: string }) => each.text)
      ).deep.equals(['How does he bat?'])
      const done = events.at(-1)!
      expect(done.event).equals('done')
      expect(
        done.data.messages.map((each: { text: string }) => each.text)
      ).deep.equals([
        'How does he bat?',
        `[Tony G](/players/${gwynn}) bats left.`
      ])
      expect(nameReads()).equals(1)
      // The whole conversation, read to be shown, gives them itself.
      statements.length = 0
      const whole = await new TeamStationClient({
        baseUrl: `http://127.0.0.1:${port}/api/v1`,
        token: w.h.tokens.get(101)
      }).tess()
      expect(whole.messages.at(-1)!.text).equals(
        `[Tony G](/players/${gwynn}) bats left.`
      )
      expect(nameReads()).equals(0)
    } finally {
      await new Promise(resolve => server.close(resolve))
    }
  })

  it('takes a picture at its limit, 5 MB of base64, and names it in a message', async () => {
    const big = Buffer.alloc(MAX_IMAGE_BYTES)
    PNG.copy(big)
    const uploaded = await client().uploadTessAttachment({
      name: 'field.png',
      mediaType: 'image/png',
      data: big.toString('base64')
    })
    expect(asTessAttachment(uploaded)).deep.include({
      name: 'field.png',
      kind: 'image'
    })
    w.model.reply(say('A field.'))
    const sent = await client().sendTessMessage('What is this?', {
      attachmentIds: [uploaded.id]
    })
    expect(asTessMessage(sent[0]).attachments).deep.equals([
      { id: uploaded.id, name: 'field.png', kind: 'image', described: false }
    ])
    const tooBig = await w.h.request('POST', '/me/tess/attachments', {
      name: 'huge.png',
      mediaType: 'image/png',
      data: 'A'.repeat(9 * 1024 * 1024)
    })
    expect(tooBig.status).equals(413)
    // A 4 MB picture fits the body, and is refused with the reason.
    const four = Buffer.alloc(4 * 1024 * 1024)
    PNG.copy(four)
    const overLimit = await w.h.request('POST', '/me/tess/attachments', {
      name: 'four.png',
      mediaType: 'image/png',
      data: four.toString('base64')
    })
    expect(overLimit.status).equals(413)
    expect(((await overLimit.json()) as { message: string }).message).equals(
      'Pictures for Tess can be up to 3.75 MB'
    )
    // Nobody signed in gets 401 before a byte of it is read.
    const anonymous = await w.h.request(
      'POST',
      '/me/tess/attachments',
      {
        name: 'a.png',
        mediaType: 'image/png',
        data: 'A'.repeat(2 * 1024 * 1024)
      },
      null
    )
    expect(anonymous.status).equals(401)
  })

  it('keeps the 1 MB limit on every other route, a message to Tess included', async () => {
    const answer = await w.h.request('POST', '/me/tess/messages', {
      text: 'x'.repeat(2 * 1024 * 1024)
    })
    expect(answer.status).equals(413)
    const other = await w.h.request('PUT', '/me/account/name', {
      displayName: 'x'.repeat(2 * 1024 * 1024)
    })
    expect(other.status).equals(413)
  })

  it('refuses a malformed message', async () => {
    for (const body of [
      {},
      { text: 'x'.repeat(20001) },
      { text: 'Hi', attachmentIds: 'one' },
      { text: '' }
    ]) {
      const answer = await w.h.request('POST', '/me/tess/messages', body)
      expect(answer.status, JSON.stringify(body).slice(0, 40)).equals(400)
    }
    expect(
      asTessConversation(await (await w.h.request('GET', '/me/tess')).json())
        .messages
    ).deep.equals([])
  })

  it('reads no attachment’s bytes to show the conversation', async () => {
    const ids: string[] = []
    for (const name of ['one.png', 'two.png'])
      ids.push(
        (
          await client().uploadTessAttachment({
            name,
            mediaType: 'image/png',
            data: PNG.toString('base64')
          })
        ).id
      )
    w.model.reply(say('Two pictures.'))
    await client().sendTessMessage('Look', { attachmentIds: ids })
    await w.h.db
      .updateTable('tess_attachments')
      .set({ data: null, description: 'A field.' })
      .where('id', '=', ids[1])
      .execute()

    // Every row the database answers, as this copy of the routes reads it.
    const rows: unknown[] = []
    const spy: KyselyPlugin = {
      transformQuery: args => args.node,
      transformResult: async args => {
        rows.push(...args.result.rows)
        return args.result
      }
    }
    const db = w.h.db.withPlugin(spy)
    const app = express()
    app.use(withActor(db))
    app.use(
      '/api/v1',
      tessRoutes(db, { settings: TEST_SETTINGS, origin: () => w.h.origin })
    )
    app.use(errorHandler)
    const server = app.listen(0, '127.0.0.1')
    await new Promise(resolve => server.once('listening', resolve))
    try {
      const { port } = server.address() as AddressInfo
      const conversation = await new TeamStationClient({
        baseUrl: `http://127.0.0.1:${port}/api/v1`,
        token: w.h.tokens.get(101)
      }).tess()
      expect(conversation.messages[0].attachments).deep.equals([
        { id: ids[0], name: 'one.png', kind: 'image', described: false },
        { id: ids[1], name: 'two.png', kind: 'image', described: true }
      ])
    } finally {
      await new Promise(resolve => server.close(resolve))
    }
    expect(rows.length).greaterThan(0)
    for (const row of rows)
      for (const value of Object.values(row as Record<string, unknown>))
        expect(Buffer.isBuffer(value), JSON.stringify(row)).equals(false)
    // Nor to check the ones a message names.
    expect(await ownedAttachments(w.h.db, w.userId(101), ids)).deep.equals(
      ids.map(id => ({ id }))
    )
  })

  /** A request to Tess's routes as user `gumbo`, asking for a stream. */
  const streamed = async (
    world: TessWorld,
    path: string,
    body?: unknown,
    gumbo = 101
  ): Promise<Response> =>
    await fetch(`${world.h.origin}/api/v1${path}`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${world.h.tokens.get(gumbo) ?? ''}`,
        accept: 'text/event-stream',
        ...(body === undefined ? {} : { 'content-type': 'application/json' })
      },
      body: body === undefined ? undefined : JSON.stringify(body)
    })

  it('streams a turn as server-sent events, and ends with the body the JSON route answers', async () => {
    w.model.reply(
      {
        content: [
          {
            type: 'thinking',
            thinking: 'I will read their roles.',
            signature: 'sig-route'
          },
          { type: 'text', text: 'Let me check.' },
          {
            type: 'tool_use',
            id: 'toolu_roles',
            name: 'api_get',
            input: { path: '/me/roles' }
          }
        ],
        stop_reason: 'tool_use'
      },
      say('You hold no roles yet.')
    )
    const response = await streamed(w, '/me/tess/messages', {
      text: 'What may I do?',
      clientId: 'mStream1'
    })
    expect(response.status).equals(200)
    expect(response.headers.get('content-type')).equals(
      'text/event-stream; charset=utf-8'
    )
    expect(response.headers.get('cache-control')).equals('no-cache')
    expect(response.headers.get('x-accel-buffering')).equals('no')
    const events = await readTurnStream(response)
    const names = events
      .map(event => event.event)
      .filter((name, at, all) => at === 0 || all[at - 1] !== name)
    expect(names).deep.equals([
      'stored',
      'thinking',
      'text',
      'step',
      'text',
      'done'
    ])
    const stored = asTessMessage(events[0].data.messages[0])
    expect(stored).deep.include({
      role: 'user',
      text: 'What may I do?',
      clientId: 'mStream1'
    })
    expect(
      events
        .filter(event => event.event === 'thinking')
        .map(event => event.data.delta)
        .join('')
    ).equals('I will read their roles.')
    expect(
      events
        .filter(event => event.event === 'step')
        .map(event => [event.data.id, event.data.status])
    ).deep.equals([
      ['toolu_roles', 'running'],
      ['toolu_roles', 'done']
    ])
    expect(Object.keys(events.find(e => e.event === 'step')!.data)).deep.equals(
      ['id', 'label', 'status']
    )
    const done = events.at(-1)!
    expect(done.event).equals('done')
    // What the JSON route answers: the message and everything after it.
    const shown = asTessConversation(
      await (await w.h.request('GET', '/me/tess')).json()
    ).messages
    expect(done.data).deep.equals({ messages: shown })
    expect(shown[1]).deep.include({
      role: 'assistant',
      text: 'Let me check.\n\nYou hold no roles yet.',
      thinking: 'I will read their roles.'
    })
    expect(shown[1].steps).length(1)
    expect(shown[1].steps![0].status).equals('done')
  })

  it('answers JSON as before without the Accept, and refuses before a turn as JSON with it', async () => {
    w.model.reply(
      callTools([{ name: 'api_get', input: { path: '/me/account' } }]),
      say('I may not read that.')
    )
    const plain = await w.h.request('POST', '/me/tess/messages', {
      text: 'Hi'
    })
    expect(plain.headers.get('content-type')).match(/^application\/json/)
    const { messages } = (await plain.json()) as {
      messages: Array<Record<string, unknown>>
    }
    expect(messages).length(2)
    // A refused step shows as failed, and a reply without thinking has none.
    expect(messages[1].steps).deep.equals([
      {
        label:
          'Not allowed: Tess may not use sign-in, account, API key, device key, test build, OAuth, dictation or Tess routes.',
        status: 'failed'
      }
    ])
    expect(messages[1]).not.has.property('thinking')
    expect(messages[0]).not.has.property('steps')
    const empty = await streamed(w, '/me/tess/messages', { text: '  ' })
    expect(empty.status).equals(400)
    expect(empty.headers.get('content-type')).match(/^application\/json/)
    const missing = await streamed(
      w,
      '/me/tess/changes/00000000-0000-4000-8000-000000000009/confirm'
    )
    expect(missing.status).equals(404)
    expect(missing.headers.get('content-type')).match(/^application\/json/)
    // A turn already running: 409, as JSON, and nothing streamed.
    let release = (): void => undefined
    const held = new Promise<void>(resolve => {
      release = resolve
    })
    w.model.reply(async () => {
      await held
      return say('Here.')
    })
    // Under way once its call reaches the model.
    const calls = w.model.messageCalls().length
    const first = streamed(w, '/me/tess/messages', { text: 'Wait for me' })
    while (w.model.messageCalls().length <= calls)
      await new Promise(resolve => setTimeout(resolve, 5))
    const second = await streamed(w, '/me/tess/messages', { text: 'Me too' })
    expect(second.status).equals(409)
    expect(second.headers.get('content-type')).match(/^application\/json/)
    expect(((await second.json()) as { code: string }).code).equals('conflict')
    release()
    const events = await readTurnStream(await first)
    expect(events.at(-1)!.event).equals('done')
  })

  it('sends the failure of a turn already begun as an error event, with the status and body it would have had', async () => {
    w.model.reply({ status: 529, error: 'overloaded_error' })
    const response = await streamed(w, '/me/tess/messages', {
      text: 'Hello?'
    })
    expect(response.status).equals(200)
    const events = await readTurnStream(response)
    expect(events.map(event => event.event)).deep.equals(['stored', 'error'])
    expect(events[1].data).deep.equals({
      status: 503,
      code: 'unavailable',
      message: "Tess's model answered 529 overloaded_error",
      details: { status: 529, type: 'overloaded_error' },
      kept: false
    })
    // Taken back, as the JSON route takes it back, and as the event says.
    expect(
      asTessConversation(await (await w.h.request('GET', '/me/tess')).json())
        .messages
    ).deep.equals([])

    // Once a tool round is stored the message stays, and the event says so.
    w.model.reply(
      callTools([{ name: 'api_get', input: { path: '/me/roles' } }]),
      { status: 529, error: 'overloaded_error' }
    )
    const kept = await readTurnStream(
      await streamed(w, '/me/tess/messages', { text: 'What may I do?' })
    )
    expect(kept.at(-1)!.event).equals('error')
    expect(kept.at(-1)!.data).deep.include({ code: 'unavailable', kept: true })
    expect(
      asTessConversation(
        await (await w.h.request('GET', '/me/tess')).json()
      ).messages.map(message => message.text)
    ).includes('What may I do?')
  })

  it('keeps a long turn’s stream open with a comment while Tess works', async () => {
    expect(KEEP_ALIVE_MS).equals(15000)
    const slow = await tessWorld({ keepAliveMs: 40 })
    try {
      let release = (): void => undefined
      const held = new Promise<void>(resolve => {
        release = resolve
      })
      slow.model.reply(async () => {
        await held
        return say('Done at last.')
      })
      const seen: TurnStreamEvent[] = []
      const reading = readTurnStream(
        await streamed(slow, '/me/tess/messages', { text: 'Take your time' }),
        event => {
          seen.push(event)
          if (seen.filter(one => one.event === 'comment').length === 3)
            release()
        }
      )
      const events = await reading
      expect(events[0].event).equals('stored')
      expect(
        events.filter(event => event.event === 'comment').map(e => e.data)
      ).includes('keep-alive')
      expect(events.at(-1)!.event).equals('done')
    } finally {
      await slow.close()
    }
  })

  it('opens the stream before compacting for a message, keeps it open, and refuses once compacted as an error event', async () => {
    const slow = await tessWorld({ keepAliveMs: 40 })
    try {
      const userId = slow.userId(101)
      /** Two stored turns, and a size that needs compacting before the next. */
      const longConversation = async (): Promise<void> => {
        await slow.h.db.deleteFrom('tess_messages').execute()
        for (const text of ['one', 'two'])
          await appendMessages(slow.h.db, userId, [
            { role: 'user', content: [{ type: 'text', text }] },
            {
              role: 'assistant',
              content: [{ type: 'text', text: `About ${text}` }]
            }
          ])
        await saveContextTokens(slow.h.db, userId, 160000)
      }
      // A message that would not fit beside any summary: refused at once,
      // as JSON, and nothing is compacted.
      await longConversation()
      slow.model.count(160000, 250000)
      const refused = await streamed(slow, '/me/tess/messages', {
        text: 'Read all of it'
      })
      expect(refused.status).equals(413)
      expect(refused.headers.get('content-type')).match(/^application\/json/)
      expect(slow.model.messageCalls()).deep.equals([])

      // The summary takes longer than the keep-alive: the stream is open
      // and commenting before the message is stored.
      slow.model.reset()
      await longConversation()
      let release = (): void => undefined
      const held = new Promise<void>(resolve => {
        release = resolve
      })
      slow.model.reply(async () => {
        await held
        return say('They asked about one.')
      }, say('Here it is.'))
      // The conversation with the message, the message alone, then the
      // conversation compacted twice.
      slow.model.count(160000, 1000, 160000, 30000)
      const seen: TurnStreamEvent[] = []
      const events = await readTurnStream(
        await streamed(slow, '/me/tess/messages', { text: 'Go on' }),
        event => {
          seen.push(event)
          if (seen.filter(one => one.event === 'comment').length === 3)
            release()
        }
      )
      const before = events.slice(
        0,
        events.findIndex(event => event.event === 'stored')
      )
      expect(before.length).greaterThanOrEqual(3)
      expect(new Set(before.map(event => event.event))).deep.equals(
        new Set(['comment'])
      )
      expect(events.at(-1)!.event).equals('done')
      expect(
        events.at(-1)!.data.messages.map((each: { text: string }) => each.text)
      ).deep.equals(['Go on', 'Here it is.'])

      // Still too large once compacted: the error event with the JSON
      // route's status and body, and the message not kept.
      slow.model.reset()
      await longConversation()
      slow.model.reply(say('A summary.'), say('A shorter summary.'))
      slow.model.count(160000, 1000, 210000, 210000, 210000)
      const tooLarge = await streamed(slow, '/me/tess/messages', {
        text: 'And again'
      })
      expect(tooLarge.status).equals(200)
      const failed = await readTurnStream(tooLarge)
      expect(failed[0].event).equals('comment')
      expect(failed.at(-1)).deep.equals({
        event: 'error',
        data: {
          status: 413,
          code: 'tooLarge',
          message: 'The conversation is too long to go on',
          kept: false
        }
      })
      expect(failed.filter(event => event.event === 'stored')).deep.equals([])
    } finally {
      await slow.close()
    }
  })

  it('goes on with a turn whose stored message cannot be shown, and leaves its event out', async () => {
    const app = express()
    let finished = false
    app.post('/turn', (_req, res, next) => {
      turnStream(
        res,
        KEEP_ALIVE_MS,
        async () => {
          throw new Error('The view could not be read')
        },
        async onEvent => {
          await onEvent({ type: 'stored', fromId: 1 })
          await onEvent({ type: 'text', delta: 'Still answering.' })
          finished = true
          return { messages: [] }
        }
      ).catch(next)
    })
    const server = app.listen(0, '127.0.0.1')
    await new Promise(resolve => server.once('listening', resolve))
    const logged: unknown[] = []
    const realError = console.error
    console.error = (...args: unknown[]) => {
      logged.push(args)
    }
    try {
      const { port } = server.address() as AddressInfo
      const events = await readTurnStream(
        await fetch(`http://127.0.0.1:${port}/turn`, { method: 'POST' })
      )
      expect(events).deep.equals([
        { event: 'text', data: { delta: 'Still answering.' } },
        { event: 'done', data: { messages: [] } }
      ])
      expect(finished).equals(true)
      expect(logged).length(1)
    } finally {
      console.error = realError
      await new Promise(resolve => server.close(resolve))
    }
  })

  it('says in its error event whether the turn’s message is kept, its stored event shown or not', async () => {
    const app = express()
    const turns: Record<string, (onEvent: TurnEvents) => Promise<unknown>> = {
      // Stored, though its view failed, then failed: kept.
      unseen: async onEvent => {
        await onEvent({ type: 'stored', fromId: 1 })
        throw new HttpError('unavailable', 'Down')
      },
      // Stored, then taken back: not kept.
      takenBack: async onEvent => {
        await onEvent({ type: 'stored', fromId: 1 })
        await onEvent({ type: 'takenBack' })
        throw new HttpError('unavailable', 'Down')
      },
      // Refused while preparing, never stored: not kept.
      preparing: async onEvent => {
        await onEvent({ type: 'preparing' })
        throw new HttpError('unavailable', 'Down')
      }
    }
    app.post('/turn/:kind', (req, res, next) => {
      turnStream(
        res,
        KEEP_ALIVE_MS,
        async () => {
          if (req.params.kind === 'unseen') throw new Error('No view')
          return { messages: [] }
        },
        turns[String(req.params.kind)]
      ).catch(next)
    })
    const server = app.listen(0, '127.0.0.1')
    await new Promise(resolve => server.once('listening', resolve))
    const realError = console.error
    console.error = () => undefined
    try {
      const { port } = server.address() as AddressInfo
      const kept: Record<string, unknown> = {}
      for (const kind of Object.keys(turns)) {
        const events = await readTurnStream(
          await fetch(`http://127.0.0.1:${port}/turn/${kind}`, {
            method: 'POST'
          })
        )
        expect(events.at(-1)!.event).equals('error')
        kept[kind] = events.at(-1)!.data.kept
      }
      expect(kept).deep.equals({
        unseen: true,
        takenBack: false,
        preparing: false
      })
    } finally {
      console.error = realError
      await new Promise(resolve => server.close(resolve))
    }
  })

  it('finishes and stores a turn whose app went away mid-stream', async () => {
    let release = (): void => undefined
    const held = new Promise<void>(resolve => {
      release = resolve
    })
    w.model.reply(async () => {
      await held
      return say('Still here.')
    })
    const abort = new AbortController()
    const response = await fetch(`${w.h.origin}/api/v1/me/tess/messages`, {
      method: 'POST',
      signal: abort.signal,
      headers: {
        authorization: `Bearer ${w.h.tokens.get(101) ?? ''}`,
        accept: 'text/event-stream',
        'content-type': 'application/json'
      },
      body: JSON.stringify({ text: 'Are you there?' })
    })
    const reader = response.body!.getReader()
    expect(new TextDecoder().decode((await reader.read()).value)).match(
      /^event: stored\n/
    )
    abort.abort()
    release()
    for (;;) {
      const conversation = asTessConversation(
        await (await w.h.request('GET', '/me/tess')).json()
      )
      if (conversation.answering !== true) {
        expect(conversation.messages.map(message => message.text)).deep.equals([
          'Are you there?',
          'Still here.'
        ])
        break
      }
      await new Promise(resolve => setTimeout(resolve, 20))
    }
  })

  it('streams a confirm: the change as it ended first, then Tess’s report, then the body the JSON route answers', async () => {
    w.model.reply(
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
      say('Hold Confirm to follow them.')
    )
    await client().sendTessMessage('Follow the Hawks')
    const { id } = await w.h.db
      .selectFrom('tess_changes')
      .select('id')
      .executeTakeFirstOrThrow()
    w.model.reply(say('You now follow Demo Hawks.'))
    const events = await readTurnStream(
      await streamed(w, `/me/tess/changes/${id}/confirm`)
    )
    expect(
      events
        .map(event => event.event)
        .filter((name, at, all) => at === 0 || all[at - 1] !== name)
    ).deep.equals(['stored', 'text', 'done'])
    expect(events[0].data.change).deep.include({ id, status: 'done' })
    expect(events[0].data.messages).deep.equals([])
    const done = events.at(-1)!.data
    expect(done.change).deep.equals(events[0].data.change)
    expect(done.messages.map((m: { text: string }) => m.text)).deep.equals([
      'You now follow Demo Hawks.'
    ])
    // Written once the response has finished, which the stream's end may
    // reach the reader before.
    const audited = async (): Promise<unknown[]> =>
      await w.h.db
        .selectFrom('audit_log')
        .select(['entity_type', 'entity_id'])
        .where('entity_type', '=', 'tess_change')
        .execute()
    for (let tries = 0; (await audited()).length === 0 && tries < 100; tries++)
      await new Promise(resolve => setTimeout(resolve, 20))
    expect(await audited()).deep.includes({
      entity_type: 'tess_change',
      entity_id: id
    })
  })
})
