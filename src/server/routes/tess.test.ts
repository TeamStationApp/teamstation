import { expect } from 'chai'
import { after, before, beforeEach, describe, it } from 'mocha'

import {
  asTessAttachment,
  asTessConversation,
  asTessMessage,
  TeamStationClient
} from '../../common/api'
import { callTools, say, type TessWorld, tessWorld } from '../../test/tessFakes'
import { hashToken, makeToken } from '../auth/tokens'
import { TESS_HEADER } from '../tess/loopback'
import { weekStartUtc } from '../tess/usage'

type Block = Record<string, any>

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
      contextTokens: 0
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
    const system = (w.model.messageCalls()[0].system as Block[])[2].text
    expect(system).includes('"path":"/teams/tem_account"')

    const conversation = await api.tess()
    expect(conversation.messages).deep.equals(sent)
    expect(conversation.contextTokens).equals(1200)
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

  it('takes an attachment up to 8 MB of body, and names it in a message', async () => {
    const big = Buffer.alloc(4 * 1024 * 1024)
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
})
