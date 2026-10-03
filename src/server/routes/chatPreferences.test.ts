import { expect } from 'chai'
import { after, before, describe, it } from 'mocha'

import { ChatEngine } from '../../app/chat/engine/engine'
import type { ChatKeyRecord, ChatKeyStore } from '../../app/chat/keyRecord'
import { TeamStationClient } from '../../common/api'
import { HttpError } from '../../common/errors'
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
  let client: TeamStationClient
  let store: Store
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
    client = new TeamStationClient({
      baseUrl: fixture.api,
      token: fixture.tokenOf('Hc')
    })
    store = new Store()
    engine = new ChatEngine({
      client,
      store,
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

  it('orders refresh and preference-hint pin reads with later successful writes', async function () {
    const original = client.chatPins.bind(client)
    for (const via of ['refresh', 'hint'] as const) {
      await engine.pinMessage(conversationId, messageId, true)
      let release!: () => void, entered!: () => void
      const gate = new Promise<void>(resolve => {
        release = resolve
      })
      const started = new Promise<void>(resolve => {
        entered = resolve
      })
      let waitOnce = true
      client.chatPins = async id => {
        const pins = await original(id)
        if (id === conversationId && waitOnce) {
          waitOnce = false
          entered()
          await gate
        }
        return pins
      }
      let reading: Promise<unknown>
      if (via === 'refresh') reading = engine.refresh()
      else {
        listener!({ type: 'chatUser', kind: 'preferences' })
        reading = engine.idle()
      }
      await started
      const writing = engine.pinMessage(conversationId, messageId, false)
      let finished = false
      const completion = writing.then(() => {
        finished = true
      })
      // A prior implementation allowed the write to complete while this GET
      // was still held. The final cache must reflect the write in either order.
      const deadline = Date.now() + 100
      while (Date.now() < deadline) {
        if (finished) break
        await new Promise(resolve => setTimeout(resolve, 5))
      }
      release()
      await Promise.all([reading, completion])
      client.chatPins = original
      expect(engine.view(conversationId)!.pins).deep.equals([])
      expect(
        await pinsFor(fixture.db, fixture.id('Hc'), conversationId)
      ).deep.equals([])
    }
  })

  it('loads local previews with at most three requests and never changes read receipts', async function () {
    const ids: string[] = []
    for (const who of ['Ha', 'Hs', 'Hk', 'N']) {
      const made = await client.createDm([fixture.id(who)])
      ids.push(made.id)
      await engine.refresh()
      await engine.open(made.id)
      await engine.sendText(made.id, 'Preview ' + who)
      engine.close(made.id)
    }
    await engine.refresh()
    const receipts = await fixture.db
      .selectFrom('chat_read_cursors')
      .selectAll()
      .where('conversation_id', 'in', ids)
      .execute()
    const original = client.chatMessages.bind(client)
    let active = 0
    let maximum = 0
    let release: () => void = () => {}
    const gate = new Promise<void>(resolve => {
      release = resolve
    })
    client.chatMessages = async (...args) => {
      active += 1
      maximum = Math.max(maximum, active)
      await gate
      try {
        return await original(...args)
      } finally {
        active -= 1
      }
    }
    try {
      const work = Promise.all(
        ids.map(async id => {
          await engine.loadPreview(id)
        })
      )
      for (let attempt = 0; attempt < 200; attempt++) {
        if (active >= 3) break
        await new Promise(resolve => setTimeout(resolve, 5))
      }
      expect(active).equals(3)
      release()
      await work
      expect(maximum).equals(3)
      await engine.loadPreview(ids[0])
      await engine.loadPreview('missing')
    } finally {
      release()
      client.chatMessages = original
    }
    expect(
      await fixture.db
        .selectFrom('chat_read_cursors')
        .selectAll()
        .where('conversation_id', 'in', ids)
        .execute()
    ).deep.equals(receipts)
    expect(
      engine.conversations().find(item => item.id === ids[0])!.preview
    ).equals('Preview Ha')
    const wire = await fixture.call('Hc', 'GET', '/chat/conversations')
    expect(JSON.stringify(wire.body)).not.includes('Preview Ha')

    const first = engine.view(ids[0])!.messages[0]
    for (let at = 0; at < 5; at++)
      await engine.react(ids[0], first.id, '👍', at % 2 === 1)
    await engine.refresh()
    const fresh = new ChatEngine({
      client,
      store,
      userId: fixture.id('Hc'),
      device: { name: 'Fixture viewer', platform: 'web' },
      pageSize: 2
    })
    try {
      expect(await fresh.start()).equals('ready')
      await fresh.loadPreview(ids[0])
      expect(
        fresh.view(ids[0])!.messages.some(message => message.id === first.id)
      ).equals(true)
      expect(
        fresh.conversations().find(item => item.id === ids[0])!.preview
      ).equals('Preview Ha')

      const conversations = client.chatConversations.bind(client)
      let excluded: string | undefined = ids[0]
      client.chatConversations = async () =>
        (await conversations()).filter(row => row.id !== excluded)
      try {
        await fresh.refresh()
        expect(fresh.view(ids[0])).equals(undefined)
        excluded = undefined
        await fresh.refresh()
        expect(fresh.view(ids[0])!.messages).deep.equals([])
        await fresh.loadPreview(ids[0])
        expect(
          fresh.conversations().find(row => row.id === ids[0])!.preview
        ).equals('Preview Ha')

        // A prior state's delayed message read cannot certify the replacement.
        const messages = client.chatMessages.bind(client)
        let release!: () => void
        let began!: () => void
        const started = new Promise<void>(resolve => {
          began = resolve
        })
        const gate = new Promise<void>(resolve => {
          release = resolve
        })
        let waitOnce = true
        client.chatMessages = async (...args) => {
          if (waitOnce && args[0] === ids[1]) {
            waitOnce = false
            began()
            await gate
          }
          return await messages(...args)
        }
        const oldPreview = fresh.loadPreview(ids[1])
        await started
        excluded = ids[1]
        await fresh.refresh()
        excluded = undefined
        await fresh.refresh()
        release()
        await oldPreview
        client.chatMessages = messages
        expect(fresh.view(ids[1])!.messages).deep.equals([])
        await fresh.loadPreview(ids[1])
        expect(
          fresh.conversations().find(row => row.id === ids[1])!.preview
        ).equals('Preview Hs')
        // Leave this row uncached for the independent retry/error case below.
        excluded = ids[1]
        await fresh.refresh()
      } finally {
        client.chatConversations = conversations
      }
      await fresh.refresh()

      const members = client.chatMembers.bind(client)
      client.chatMembers = async id => {
        if (id === ids[1])
          throw new HttpError('internal', 'Fixture temporary error')
        return await members(id)
      }
      let failed = false
      try {
        await fresh.loadPreview(ids[1])
      } catch {
        failed = true
      }
      expect(failed).equals(true)
      client.chatMembers = members
      await fresh.loadPreview(ids[1])
      expect(
        fresh.conversations().find(item => item.id === ids[1])!.preview
      ).equals('Preview Hs')

      await client.leaveDm(ids[2])
      await fresh.loadPreview(ids[2])
      expect(fresh.view(ids[2])).equals(undefined)
    } finally {
      fresh.stop()
    }
  })

  it('announces new received posts once, keeps muted delivery and stays quiet on resync', async function () {
    const peerClient = new TeamStationClient({
      baseUrl: fixture.api,
      token: fixture.tokenOf('N')
    })
    const peer = new ChatEngine({
      client: peerClient,
      store: new Store(),
      userId: fixture.id('N'),
      device: { name: 'Fixture peer', platform: 'web' }
    })
    try {
      expect(await peer.start()).equals('ready')
      await engine.fillGrants()
      await peer.open(conversationId)
      await engine.setPreferences(conversationId, { muted: false })
      const before = events.filter(type => type === 'messageAlert').length
      const posted = await peer.sendText(conversationId, 'Bring spare gloves.')
      const hint = {
        type: 'chat' as const,
        conversationId,
        kind: 'message' as const,
        seq: posted!.seq,
        at: new Date().toISOString()
      }
      listener!(hint)
      await engine.idle()
      expect(events.filter(type => type === 'messageAlert')).has.length(
        before + 1
      )
      listener!(hint)
      await engine.idle()
      expect(events.filter(type => type === 'messageAlert')).has.length(
        before + 1
      )
      await engine.setPreferences(conversationId, { muted: true })
      const quiet = await peer.sendText(conversationId, 'Quiet update.')
      listener!({ ...hint, seq: quiet!.seq })
      await engine.idle()
      expect(events.filter(type => type === 'messageAlert')).has.length(
        before + 1
      )
      expect(
        engine
          .view(conversationId)!
          .messages.some(message => message.body === 'Quiet update.')
      ).equals(true)
      listener!({ type: 'resync' })
      await engine.idle()
      expect(events.filter(type => type === 'messageAlert')).has.length(
        before + 1
      )

      await engine.setPreferences(conversationId, { muted: false })
      await engine.markRead(conversationId)
      engine.close(conversationId)
      const burst = (await peer.sendText(conversationId, 'Burst update.'))!
      await peer.react(conversationId, burst.id, '👍')
      await peer.edit(conversationId, burst.id, 'Edited burst update.')
      for (const seq of [burst.seq, burst.seq + 1, burst.seq + 2])
        listener!({ ...hint, seq })
      await engine.idle()
      expect(events.filter(type => type === 'messageAlert')).has.length(
        before + 2
      )
      for (const seq of [burst.seq, burst.seq + 1, burst.seq + 2])
        listener!({ ...hint, seq })
      await engine.idle()
      await engine.loadPreview(conversationId)
      expect(events.filter(type => type === 'messageAlert')).has.length(
        before + 2
      )
      await engine.open(conversationId)
      await engine.markRead(conversationId)
      const own = (await engine.sendText(conversationId, 'Own quiet update.'))!
      listener!({ ...hint, seq: own.seq })
      await engine.idle()
      expect(events.filter(type => type === 'messageAlert')).has.length(
        before + 2
      )
    } finally {
      peer.stop()
    }
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
    expect(after.lastPostId).equals(before.lastPostId)
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
