import { expect } from 'chai'
import { after, before, describe, it } from 'mocha'

import { ChatEngine } from '../../app/chat/engine/engine'
import type { ChatKeyRecord, ChatKeyStore } from '../../app/chat/keyRecord'
import { TeamStationClient } from '../../common/api'
import type {
  ChatSocketEvent,
  ChatSocketListener
} from '../../common/gameSocket'
import { type ChatFixture, openChatFixture } from '../chat/chatTestFixture'
import { pinsFor, preferencesFor } from '../chat/preferences'

class Store implements ChatKeyStore {
  record: ChatKeyRecord | undefined
  async load(): Promise<ChatKeyRecord | undefined> {
    return this.record
  }

  async save(record: ChatKeyRecord): Promise<void> {
    this.record = record
  }

  async wipe(): Promise<void> {
    this.record = undefined
  }

  async exists(): Promise<boolean> {
    return this.record != null
  }
}

describe('personal chat preferences and pins', function () {
  this.timeout(120000)
  let fixture: ChatFixture
  let engine: ChatEngine
  let listener: ChatSocketListener | undefined
  let conversationId: string
  let messageId: string
  const events: string[] = []
  const path = (): string => `/chat/conversations/${conversationId}`
  before(async function () {
    const opened = await openChatFixture('preferences')
    if (opened == null) {
      this.skip()
      return
    }
    fixture = opened
    await fixture.signIn('Hc2', 'Hc')
    const client = new TeamStationClient({
      baseUrl: fixture.api,
      token: fixture.tokenOf('Hc')
    })
    engine = new ChatEngine({
      client,
      store: new Store(),
      userId: fixture.id('Hc'),
      device: { name: 'Test browser', platform: 'web' },
      socket: {
        onChat: callback => {
          listener = callback
          return () => {
            listener = undefined
          }
        },
        sendTyping: () => true
      }
    })
    engine.subscribe(event => events.push(event.type))
    engine.listen()
    expect(await engine.start()).equals('ready')
    const conversation = engine
      .conversations()
      .find(chat => chat.kind === 'teamMembers')!
    conversationId = conversation.id
    await engine.open(conversationId)
    const message = await engine.sendText(
      conversationId,
      'Remember the water bottles.'
    )
    messageId = message!.id
  })
  after(async function () {
    engine?.stop()
    await fixture?.close()
  })

  it('defaults false and shares personal state only across the same user', async function () {
    expect(await preferencesFor(fixture.db, fixture.id('Hc'), [])).deep.equals(
      new Map()
    )
    await engine.setPreferences(conversationId, { pinned: true })
    const same = await fixture.call('Hc2', 'GET', '/chat/conversations')
    expect(same.status).equals(200)
    expect(
      same.body.find((item: { id: string }) => item.id === conversationId)
        .preferences
    ).includes({ pinned: true, muted: false, manualUnread: false })
    const other = await fixture.call('N', 'GET', '/chat/conversations')
    expect(
      other.body.find((item: { id: string }) => item.id === conversationId)
        .preferences.pinned
    ).equals(false)
    await Promise.all([
      fixture.call('Hc', 'PATCH', `${path()}/preferences`, { muted: true }),
      fixture.call('Hc2', 'PATCH', `${path()}/preferences`, { pinned: false })
    ])
    await engine.refresh()
    expect(engine.view(conversationId)!.conversation.preferences).includes({
      pinned: false,
      muted: true
    })
    expect(events).includes('conversations')
  })

  it('keeps manual unread through stale and legacy reads without lowering receipts', async function () {
    await engine.markRead(conversationId)
    const first = await fixture.call('Hc', 'PATCH', `${path()}/preferences`, {
      manualUnread: true
    })
    const next = await fixture.call('Hc', 'PATCH', `${path()}/preferences`, {
      manualUnread: true
    })
    const seq = engine.view(conversationId)!.messages.at(-1)!.seq
    expect(next.body.manualUnreadRevision).equals(
      first.body.manualUnreadRevision + 1
    )
    for (const body of [
      { seq },
      { seq, clearManualUnreadRevision: first.body.manualUnreadRevision }
    ]) {
      expect(
        (await fixture.call('Hc', 'PUT', `${path()}/read`, body)).status
      ).equals(200)
      expect(
        (
          await preferencesFor(fixture.db, fixture.id('Hc'), [conversationId])
        ).get(conversationId)!.manualUnread
      ).equals(true)
    }
    await engine.refresh()
    await engine.markRead(conversationId, next.body.manualUnreadRevision)
    expect(
      engine.view(conversationId)!.conversation.preferences!.manualUnread
    ).equals(false)
    const reads = await fixture.call('Hc', 'GET', `${path()}/reads`)
    expect(
      reads.body.find(
        (read: { userId: number }) => read.userId === fixture.id('Hc')
      ).seq
    ).equals(seq)
    await engine.markRead(conversationId)
    expect(
      (
        await fixture.call('Hc', 'PUT', `${path()}/read`, {
          seq: seq + 100,
          clearManualUnreadRevision: next.body.manualUnreadRevision
        })
      ).status
    ).equals(400)
    expect(
      (
        await fixture.call('Hc', 'PUT', `${path()}/read`, {
          seq,
          clearManualUnreadRevision: -1
        })
      ).status
    ).equals(400)
  })

  it('rejects invalid, unauthenticated, nonmember and empty preference writes', async function () {
    expect(
      (await fixture.call('Hc', 'PATCH', `${path()}/preferences`, {})).status
    ).equals(400)
    expect(
      (
        await fixture.call('Hc', 'PATCH', `${path()}/preferences`, {
          pinned: 'yes'
        })
      ).status
    ).equals(400)
    expect(
      (
        await fixture.call('Ea', 'PATCH', `${path()}/preferences`, {
          pinned: true
        })
      ).status
    ).equals(404)
    expect((await fixture.call('Ea', 'GET', `${path()}/pins`)).status).equals(
      404
    )
    expect(
      (await fixture.call('Ea', 'PUT', `${path()}/pins/${messageId}`)).status
    ).equals(404)
    expect(
      (await fixture.call('Hc', 'PUT', `${path()}/pins/msg_missing`)).status
    ).equals(404)
  })

  it('pins only a post personally, unpins idempotently and updates active clients through hints', async function () {
    await engine.pinMessage(conversationId, messageId, true)
    await engine.pinMessage(conversationId, messageId, true)
    expect(engine.view(conversationId)!.pins).has.length(1)
    expect(
      (await fixture.call('Hc2', 'GET', `${path()}/pins`)).body
    ).has.length(1)
    expect((await fixture.call('N', 'GET', `${path()}/pins`)).body).deep.equals(
      []
    )
    await fixture.call('Hc2', 'DELETE', `${path()}/pins/${messageId}`)
    listener!({
      type: 'chatUser',
      kind: 'preferences'
    } satisfies ChatSocketEvent)
    await engine.idle()
    expect(engine.view(conversationId)!.pins).deep.equals([])
    await engine.pinMessage(conversationId, messageId, false)
    await engine.pinMessage(conversationId, messageId, true)
    await engine.react(conversationId, messageId, '👍')
    const envelopes = await fixture.db
      .selectFrom('chat_messages')
      .select(['id'])
      .where('conversation_id', '=', conversationId)
      .where('kind', '=', 'reaction')
      .execute()
    expect(
      (await fixture.call('Hc', 'PUT', `${path()}/pins/${envelopes[0].id}`))
        .status
    ).equals(404)
  })

  it('uses post recency through reaction/edit/deletion and removes every pin on delete', async function () {
    const before = (
      await fixture.call('Hc', 'GET', '/chat/conversations')
    ).body.find((item: { id: string }) => item.id === conversationId)
    await engine.edit(conversationId, messageId, 'Remember water and hats.')
    await fixture.call('N', 'PUT', `${path()}/pins/${messageId}`)
    await engine.deleteMessage(conversationId, messageId)
    expect(
      await pinsFor(fixture.db, fixture.id('Hc'), conversationId)
    ).deep.equals([])
    expect(
      await pinsFor(fixture.db, fixture.id('N'), conversationId)
    ).deep.equals([])
    const after = (
      await fixture.call('Hc', 'GET', '/chat/conversations')
    ).body.find((item: { id: string }) => item.id === conversationId)
    expect(after.lastPostId).equals(messageId)
    expect(after.lastPostAt).equals(before.lastPostAt)
    expect(after.lastPostSeq).equals(before.lastPostSeq)
    expect(JSON.stringify(after)).not.includes('Remember water')
    expect(
      (await fixture.call('Hc', 'PUT', `${path()}/pins/${messageId}`)).status
    ).equals(404)
    let code = ''
    try {
      await engine.pinMessage(conversationId, messageId, true)
    } catch (error) {
      code = (error as { code: string }).code
    }
    expect(code).equals('target')
  })
})
