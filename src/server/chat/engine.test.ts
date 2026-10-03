import { randomBytes } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import type { Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { expect } from 'chai'
import { after, before, describe, it } from 'mocha'

import { ChatEngineError } from '../../app/chat/engine/context'
import { ChatEngine, type ConversationView } from '../../app/chat/engine/engine'
import {
  approveLink,
  type ChatSetup,
  ensureEnrolled,
  pollLink,
  resetIdentity,
  revokeOtherDevice,
  startLink
} from '../../app/chat/engine/links'
import type { FetchBytes } from '../../app/chat/engine/send'
import {
  b64,
  type ChatKeyRecord,
  type ChatKeyStore,
  epochKeyOf,
  recordFromJson,
  recordToJson
} from '../../app/chat/keyRecord'
import {
  type ChatAttachment,
  type ChatEpochMade,
  type ChatEpochPublication,
  type ChatGrantBox,
  type ChatGrantRequest,
  type ChatGrantsPosted,
  type ChatIdentity,
  type ChatMessage,
  type ChatMessageEnvelope,
  type ChatUserKeys,
  TeamStationClient
} from '../../common/api'
import { MAX_ATTACHMENT_SIZE } from '../../common/chatContent'
import { utf8 } from '../../common/chatCrypto/bytes'
import { epochAad, hpkeOpen } from '../../common/chatCrypto/hpke'
import { newMessageId } from '../../common/chatCrypto/messageIds'
import { type EnvelopeKind, sealMessage } from '../../common/chatCrypto/seal'
import { HttpError } from '../../common/errors'
import type {
  ChatSocketEvent,
  ChatSocketListener
} from '../../common/gameSocket'
import { makeId } from '../../common/ids'
import { closeInto } from '../admin/people'
import { listen } from '../dev/fakeSpace'
import type { SpaceSettings } from '../media/spacesHls'
import { type ChatFixture, openChatFixture } from './chatTestFixture'

/**
 * U12: the app's chat engine (`src/app/chat/engine/`) against the real chat
 * routes on a scratch database, with several devices, each a session of the
 * fixture with a key store of its own and a stand-in socket the test hints
 * through. It sits with the server's tests because it runs the server,
 * which the app's browser typecheck cannot hold.
 */

/** A store in memory, written through the same JSON the real ones keep. */
class MemoryStore implements ChatKeyStore {
  text: string | undefined
  async load(): Promise<ChatKeyRecord | undefined> {
    return this.text == null ? undefined : recordFromJson(this.text)
  }

  async save(record: ChatKeyRecord): Promise<void> {
    this.text = recordToJson(record)
  }

  async wipe(): Promise<void> {
    this.text = undefined
  }

  copy(): MemoryStore {
    const copy = new MemoryStore()
    copy.text = this.text
    return copy
  }

  get record(): ChatKeyRecord {
    if (this.text == null) throw new Error('nothing stored')
    return recordFromJson(this.text)
  }
}

/** The socket's chat side, driven by the test. */
class FakeSocket {
  private readonly listeners = new Set<ChatSocketListener>()
  readonly typed: string[] = []

  onChat(listener: ChatSocketListener): () => void {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  sendTyping(conversationId: string): boolean {
    this.typed.push(conversationId)
    return true
  }

  emit(event: ChatSocketEvent): void {
    for (const listener of [...this.listeners]) listener(event)
  }

  get listening(): number {
    return this.listeners.size
  }
}

/**
 * A client that can be made to lie: an identity named as somebody else's,
 * grant requests rewritten, and the next call of a method refused.
 */
class LyingClient extends TeamStationClient {
  readonly lies = new Map<string, number>()
  /** Identities the server says it does not have. */
  readonly missing = new Set<string>()
  /** People whose published per-user key comes with a broken signature. */
  readonly forged = new Set<number>()
  grants: ((real: ChatGrantRequest[]) => ChatGrantRequest[]) | undefined
  readonly refusals: Array<{ method: string; error: HttpError }> = []

  private refuse(method: string): void {
    const at = this.refusals.findIndex(refusal => refusal.method === method)
    if (at < 0) return
    const [refusal] = this.refusals.splice(at, 1)
    throw refusal.error
  }

  async chatIdentity(identityId: string): Promise<ChatIdentity> {
    if (this.missing.has(identityId)) {
      throw new HttpError('notFound', 'Not found')
    }
    const real = await super.chatIdentity(identityId)
    const userId = this.lies.get(identityId)
    return userId == null ? real : { ...real, userId }
  }

  async chatUserKeys(userId: number): Promise<ChatUserKeys> {
    const real = await super.chatUserKeys(userId)
    return !this.forged.has(userId) || real.puk == null
      ? real
      : { ...real, puk: { ...real.puk, signature: b64(new Uint8Array(64)) } }
  }

  async postChatEpoch(
    conversationId: string,
    epoch: ChatEpochPublication
  ): Promise<ChatEpochMade> {
    this.refuse('postChatEpoch')
    return await super.postChatEpoch(conversationId, epoch)
  }

  async chatGrants(): Promise<ChatGrantRequest[]> {
    const real = await super.chatGrants()
    return this.grants?.(real) ?? real
  }

  async postChatGrants(boxes: ChatGrantBox[]): Promise<ChatGrantsPosted> {
    this.refuse('postChatGrants')
    return await super.postChatGrants(boxes)
  }

  async postChatMessage(
    conversationId: string,
    envelope: ChatMessageEnvelope
  ): Promise<ChatMessage> {
    this.refuse('postChatMessage')
    return await super.postChatMessage(conversationId, envelope)
  }

  async completeChatAttachment(attachmentId: string): Promise<ChatAttachment> {
    this.refuse('completeChatAttachment')
    return await super.completeChatAttachment(attachmentId)
  }
}

const refusal = (
  method: string,
  code: 'conflict' | 'forbidden',
  reason: string
): { method: string; error: HttpError } => ({
  method,
  error: new HttpError(code, reason, { reason })
})

interface Device {
  who: string
  key: string
  engine: ChatEngine
  socket: FakeSocket
  store: MemoryStore
  client: TeamStationClient
  setup: ChatSetup
}

describe('the chat engine (U12)', function () {
  this.timeout(180000)
  let fixture: ChatFixture | undefined
  let spaceServer: Server | undefined
  let spaceDir: string | undefined
  const space: SpaceSettings = {
    endpoint: '',
    region: 'sfo3',
    bucket: 'test-chat-engine',
    accessKeyId: 'key',
    secretAccessKey: 'secret',
    pathStyle: true
  }
  const devices = new Map<string, Device>()
  /** The chat whose membership record G2 could not verify. */
  let brokenChat = ''

  before(async function () {
    this.timeout(60000)
    spaceDir = await mkdtemp(join(tmpdir(), 'tsChatEngine-'))
    spaceServer = await listen('127.0.0.1', 0, { space, dir: spaceDir })
    space.endpoint = `http://127.0.0.1:${(spaceServer.address() as AddressInfo).port}`
    fixture = await openChatFixture('engine', { space })
    if (fixture == null) this.skip()
  })

  after(async function () {
    for (const device of devices.values()) device.engine.stop()
    await fixture?.close()
    spaceServer?.close()
    if (spaceDir != null) await rm(spaceDir, { recursive: true, force: true })
  })

  const f = (): ChatFixture => {
    if (fixture == null) throw new Error('no fixture')
    return fixture
  }
  const id = (key: string): number => f().id(key)

  /** A device on the session `who` of person `key`, not started. */
  function deviceOn(
    who: string,
    key: string,
    options: {
      store?: MemoryStore
      client?: TeamStationClient
      fetchBytes?: FetchBytes
    } = {}
  ): Device {
    const client =
      options.client ??
      new TeamStationClient({ baseUrl: f().api, token: f().tokenOf(who) })
    const store = options.store ?? new MemoryStore()
    const socket = new FakeSocket()
    const setup: ChatSetup = {
      client,
      store,
      userId: id(key),
      device: { name: who, platform: 'web' }
    }
    const engine = new ChatEngine({
      ...setup,
      client,
      socket,
      pageSize: 3,
      typingMs: 30,
      ...(options.fetchBytes == null ? {} : { fetchBytes: options.fetchBytes })
    })
    engine.listen()
    return { who, key, engine, socket, store, client, setup }
  }

  /** Person `key`'s main device (their own session), started and ready. */
  async function device(key: string): Promise<Device> {
    const known = devices.get(key)
    if (known != null) return known
    const made = deviceOn(key, key)
    expect(await made.engine.start()).equals('ready')
    await made.engine.idle()
    devices.set(key, made)
    return made
  }

  /** Delivers a socket hint and waits for what it set off. */
  async function hint(to: Device, event: ChatSocketEvent): Promise<void> {
    to.socket.emit(event)
    await to.engine.idle()
  }

  const chat = (
    conversationId: string,
    kind: 'message' | 'members' | 'epoch' | 'grant' | 'read'
  ): ChatSocketEvent => ({
    type: 'chat',
    conversationId,
    kind,
    at: new Date().toISOString()
  })

  /** A DM `creator` starts with `others`. */
  async function dm(creator: string, others: string[]): Promise<string> {
    const made = await (await device(creator)).client.createDm(others.map(id))
    return made.id
  }

  async function chatId(who: string, title: string): Promise<string> {
    const list = await (await device(who)).client.chatConversations()
    const found = list.find(item => item.title === title)
    if (found == null) throw new Error(`${who} has no ${title}`)
    return found.id
  }

  const bodies = (view: ConversationView): string[] =>
    view.messages.map(message => message.body)
  const statuses = (view: ConversationView): string[] =>
    view.messages.map(message => message.status)

  async function engineRefusal(work: Promise<unknown>): Promise<string> {
    try {
      await work
    } catch (error) {
      if (error instanceof ChatEngineError) return error.code
      throw error
    }
    throw new Error('expected a refusal')
  }

  async function epochsOf(
    conversationId: string
  ): Promise<Array<{ epoch: number; chain_break: boolean }>> {
    return await f()
      .db.selectFrom('chat_epochs')
      .select(['epoch', 'chain_break'])
      .where('conversation_id', '=', conversationId)
      .orderBy('epoch')
      .execute()
  }

  async function boxedAt(
    conversationId: string,
    epoch: number
  ): Promise<number[]> {
    const rows = await f()
      .db.selectFrom('chat_epoch_boxes')
      .select(['user_id'])
      .where('conversation_id', '=', conversationId)
      .where('epoch', '=', epoch)
      .execute()
    return rows.map(row => row.user_id).sort((a, b) => a - b)
  }

  async function openRequests(
    conversationId: string,
    userId: number
  ): Promise<Array<{ filled: boolean; superseded: boolean }>> {
    const rows = await f()
      .db.selectFrom('chat_grant_requests')
      .select(['filled_at', 'superseded_at'])
      .where('conversation_id', '=', conversationId)
      .where('user_id', '=', userId)
      .execute()
    return rows.map(row => ({
      filled: row.filled_at != null,
      superseded: row.superseded_at != null
    }))
  }

  const sorted = (...keys: string[]): number[] =>
    keys.map(id).sort((a, b) => a - b)

  it('is not ready before it starts, and lists chats all the same', async function () {
    const early = deviceOn('Hc', 'Hc')
    expect(await engineRefusal(early.engine.open('cnv_x'))).equals('notReady')
    const list = await early.engine.refresh()
    expect(list.map(item => item.title)).include('Hawks Members')
    expect(list.every(item => !item.unverified)).equals(true)
    expect(early.engine.view('cnv_unknown')).equals(undefined)
    expect(early.engine.approvals()).deep.equals([])
    expect(early.engine.holdsLatest(list[0].id)).equals(false)
    expect(early.engine.verifiedMembers(list[0].id)).equals(undefined)
    early.engine.stop()
  })

  it('pages a chat’s messages by seq, and opens each one', async function () {
    const a = await device('A')
    const b = await device('B')
    await device('C')
    const chatOf = await dm('A', ['B', 'C'])
    const first = await a.engine.open(chatOf)
    expect(first.composer).equals('enabled')
    expect(first.historyLocked).equals(false)
    for (let n = 1; n <= 7; n++) await a.engine.sendText(chatOf, `m${n}`)
    expect(await epochsOf(chatOf)).deep.equals([
      { epoch: 1, chain_break: false }
    ])
    expect(await boxedAt(chatOf, 1)).deep.equals(sorted('A', 'B', 'C'))

    let view = await b.engine.open(chatOf)
    expect(bodies(view)).deep.equals(['m5', 'm6', 'm7'])
    expect(view.hasEarlier).equals(true)
    view = await b.engine.loadEarlier(chatOf)
    expect(bodies(view)).deep.equals(['m2', 'm3', 'm4', 'm5', 'm6', 'm7'])
    view = await b.engine.loadEarlier(chatOf)
    expect(bodies(view)).deep.equals(['m1', 'm2', 'm3', 'm4', 'm5', 'm6', 'm7'])
    expect(view.hasEarlier).equals(false)
    expect(bodies(await b.engine.loadEarlier(chatOf))).length(7)
    expect(statuses(view).every(status => status === 'ok')).equals(true)
    const names = await b.client.chatMembers(chatOf)
    expect(view.messages[0].senderName).equals(
      names.find(member => member.userId === id('A'))?.shortName
    )
    expect(view.conversation.title).contains(
      names.find(member => member.userId === id('C'))?.shortName ?? '?'
    )

    // Four more than a page: the hint reads them all, a page at a time.
    for (let n = 8; n <= 11; n++) await a.engine.sendText(chatOf, `m${n}`)
    await hint(b, chat(chatOf, 'message'))
    view = b.engine.view(chatOf)!
    expect(bodies(view)).deep.equals(
      Array.from({ length: 11 }, (_, n) => `m${n + 1}`)
    )
    const listed = b.engine.conversations().find(item => item.id === chatOf)
    expect(listed?.lastSeq).equals(11)
    expect(listed?.locked).equals(false)

    // A chat first opened by a device that already holds older keys.
    const later = deviceOn('B', 'B', { store: b.store.copy() })
    expect(await later.engine.start()).equals('ready')
    expect(bodies(await later.engine.open(chatOf))).deep.equals([
      'm9',
      'm10',
      'm11'
    ])
    later.engine.stop()
  })

  it('verifies each message against its sender’s identity before opening it', async function () {
    const b = await device('B')
    const c = await device('C')
    const chatOf = await dm('C', ['B'])
    await c.engine.sendText(chatOf, 'from C')
    const genuine = await b.engine.sendText(chatOf, 'genuine')
    const forged = await b.engine.sendText(chatOf, 'signature changed')
    const altered = await b.engine.sendText(chatOf, 'ciphertext changed')
    expect(genuine?.status).equals('ok')
    await f()
      .db.updateTable('chat_messages')
      .set({ signature: new Uint8Array(64) })
      .where('id', '=', forged!.id)
      .execute()
    const row = await f()
      .db.selectFrom('chat_messages')
      .select(['ciphertext'])
      .where('id', '=', altered!.id)
      .executeTakeFirstOrThrow()
    const flipped = Uint8Array.from(row.ciphertext)
    flipped[0] ^= 1
    await f()
      .db.updateTable('chat_messages')
      .set({ ciphertext: flipped })
      .where('id', '=', altered!.id)
      .execute()

    // Another engine on C's device, reading the chat for the first time.
    const reader = deviceOn('C', 'C', { store: c.store.copy() })
    await reader.engine.start()
    await reader.engine.open(chatOf)
    const view = await reader.engine.loadEarlier(chatOf)
    expect(statuses(view)).deep.equals(['ok', 'ok', 'invalid', 'invalid'])
    expect(bodies(view)).deep.equals(['from C', 'genuine', '', ''])
    reader.engine.stop()

    // A server that names B's identity as somebody else's is not believed.
    const lying = new LyingClient({
      baseUrl: f().api,
      token: f().tokenOf('C')
    })
    const bIdentity = b.store.record.identity!.id
    lying.lies.set(bIdentity, id('A'))
    const doubter = deviceOn('C', 'C', {
      store: c.store.copy(),
      client: lying
    })
    await doubter.engine.start()
    await doubter.engine.open(chatOf)
    const doubted = await doubter.engine.loadEarlier(chatOf)
    expect(statuses(doubted)).deep.equals([
      'ok',
      'invalid',
      'invalid',
      'invalid'
    ])
    doubter.engine.stop()

    // An identity the server will not show is no identity at all.
    const hiding = new LyingClient({
      baseUrl: f().api,
      token: f().tokenOf('C')
    })
    hiding.missing.add(c.store.record.identity!.id)
    const blind = deviceOn('C', 'C', { store: c.store.copy(), client: hiding })
    await blind.engine.start()
    await blind.engine.open(chatOf)
    const unseen = await blind.engine.loadEarlier(chatOf)
    expect(statuses(unseen).every(status => status === 'invalid')).equals(true)
    blind.engine.stop()
  })

  it('applies edits, deletes, reactions, replies and receipts by target', async function () {
    const a = await device('A')
    const b = await device('B')
    const c = await device('C')
    const chatOf = await dm('B', ['A', 'C'])
    await b.engine.open(chatOf)
    const hello = (await b.engine.sendText(chatOf, 'hello'))!
    await b.engine.edit(chatOf, hello.id, 'hello there', [id('A')])
    await c.engine.open(chatOf)
    await c.engine.react(chatOf, hello.id, '👍')
    expect(await engineRefusal(c.engine.edit(chatOf, hello.id, 'no'))).equals(
      'target'
    )
    expect(
      await engineRefusal(c.engine.deleteMessage(chatOf, hello.id))
    ).equals('target')
    expect(
      await engineRefusal(c.engine.react(chatOf, 'msg_nothere', '👍'))
    ).equals('target')
    await a.engine.open(chatOf)
    await a.engine.react(chatOf, hello.id, '👍')
    await a.engine.react(chatOf, hello.id, '👍', true)
    await a.engine.react(chatOf, hello.id, '🎉')
    const reply = (await a.engine.sendText(chatOf, 'welcome', {
      quoteId: hello.id
    }))!

    await hint(b, chat(chatOf, 'message'))
    let view = b.engine.view(chatOf)!
    const shown = view.messages.find(message => message.id === hello.id)!
    expect(shown.body).equals('hello there')
    expect(shown.mentions).deep.equals([id('A')])
    expect(shown.edited).equals(true)
    expect(shown.editIds).length(1)
    expect(shown.reactions).deep.equals([
      { emoji: '👍', userIds: [id('C')], mine: false },
      { emoji: '🎉', userIds: [id('A')], mine: false }
    ])
    const quoted = view.messages.find(message => message.id === reply.id)!
    expect(quoted.quote?.id).equals(hello.id)
    expect(quoted.quote?.snippet).equals('hello there')
    expect(quoted.quote?.authorName).equals(shown.senderName)

    // Read receipts: C reads, and B's ticks show it after the hint.
    await hint(c, chat(chatOf, 'message'))
    await c.engine.markRead(chatOf)
    await c.engine.markRead(chatOf)
    await hint(b, chat(chatOf, 'read'))
    view = b.engine.view(chatOf)!
    expect(
      view.messages.find(message => message.id === hello.id)?.readBy
    ).include(id('C'))
    expect(
      c.engine.conversations().find(item => item.id === chatOf)?.unread
    ).equals(0)

    // B deletes the post: it and its edit are cleared on the server.
    await b.engine.deleteMessage(chatOf, hello.id)
    const cleared = await f()
      .db.selectFrom('chat_messages')
      .select(['id', 'cleared_at', 'ciphertext'])
      .where('id', 'in', [hello.id, ...shown.editIds])
      .execute()
    expect(cleared).length(2)
    for (const row of cleared) {
      expect(row.cleared_at).not.equals(null)
      expect(row.ciphertext.length).equals(0)
    }
    await hint(c, chat(chatOf, 'message'))
    const gone = c.engine
      .view(chatOf)!
      .messages.find(message => message.id === hello.id)!
    expect(gone.status).equals('removed')
    expect(gone.removedBy).equals('author')
    expect(gone.reactions).deep.equals([])

    // A moderator removes a post in Hawks Members.
    const hc = await device('Hc')
    const members = await chatId('C', 'Hawks Members')
    await c.engine.open(members)
    const firstFromC = (await c.engine.sendText(members, 'first from C'))!
    await hc.engine.open(members)
    await hc.engine.moderatorDelete(members, firstFromC.id)
    await hint(c, chat(members, 'message'))
    expect(
      c.engine
        .view(members)!
        .messages.find(message => message.id === firstFromC.id)
    ).include({ status: 'removed', removedBy: 'moderator' })
  })

  it('makes epoch n+1 after a leave, and the member who left cannot open it', async function () {
    const a = await device('A')
    const b = await device('B')
    const c = await device('C')
    const chatOf = await dm('A', ['B', 'C'])
    await a.engine.sendText(chatOf, 'all three')
    await c.engine.open(chatOf)
    await c.client.leaveDm(chatOf)
    // C's open chat, hinted after the leave, leaves C's list quietly.
    const heard: string[] = []
    const stop = c.engine.subscribe(event => {
      heard.push(event.type)
    })
    await hint(c, chat(chatOf, 'members'))
    stop()
    expect(heard).not.include('error')
    expect(c.engine.view(chatOf)).equals(undefined)
    expect(await engineRefusal(c.engine.open(chatOf))).equals('notMember')
    await a.engine.sendText(chatOf, 'two of us')
    expect(await epochsOf(chatOf)).deep.equals([
      { epoch: 1, chain_break: false },
      { epoch: 2, chain_break: false }
    ])
    expect(await boxedAt(chatOf, 2)).deep.equals(sorted('A', 'B'))

    // Not one box of epoch 2 opens with C's per-user key.
    const record = c.store.record
    const boxes = await f()
      .db.selectFrom('chat_epoch_boxes')
      .select(['box'])
      .where('conversation_id', '=', chatOf)
      .where('epoch', '=', 2)
      .execute()
    for (const row of boxes) {
      expect(() =>
        hpkeOpen(
          'epoch',
          record.puks[0].keys.secretKey,
          epochAad({
            conversationId: chatOf,
            epoch: 2,
            recipientUserId: id('C'),
            identityId: record.identity!.id,
            generation: 1
          }),
          row.box
        )
      ).throws()
    }
    try {
      await c.client.chatMessages(chatOf)
      expect.fail('C read the chat after leaving')
    } catch (error) {
      expect((error as HttpError).code).equals('notFound')
    }
    expect(bodies(await b.engine.open(chatOf))).deep.equals([
      'all three',
      'two of us'
    ])
  })

  it('grants the history to a new member by itself, and the chain opens all of it', async function () {
    const a = await device('A')
    const c = await device('C')
    const chatOf = await dm('A', ['B', 'C'])
    await a.engine.sendText(chatOf, 'before Hk')
    await c.client.leaveDm(chatOf)
    await a.engine.sendText(chatOf, 'after C left')
    expect(await epochsOf(chatOf)).length(2)
    await a.client.addDmMembers(chatOf, [id('Hk')])
    const hk = await device('Hk')
    let view = await hk.engine.open(chatOf)
    expect(view.historyLocked).equals(true)
    expect(view.composer).equals('locked')
    expect(statuses(view)).deep.equals(['locked', 'locked'])
    expect(await engineRefusal(hk.engine.sendText(chatOf, 'x'))).equals(
      'locked'
    )
    expect(
      hk.engine.conversations().find(item => item.id === chatOf)?.locked
    ).equals(true)

    await hint(a, chat(chatOf, 'grant'))
    expect(await openRequests(chatOf, id('Hk'))).deep.equals([
      { filled: true, superseded: false }
    ])
    await hint(hk, chat(chatOf, 'grant'))
    view = hk.engine.view(chatOf)!
    // Granted epoch 2 only, Hk opens epoch 1 through its previous-key box.
    expect(bodies(view)).deep.equals(['before Hk', 'after C left'])
    expect(view.historyLocked).equals(false)
    expect(view.composer).equals('enabled')
    expect(hk.engine.holdsLatest(chatOf)).equals(true)
  })

  it('waits for an approver before granting a reset identity', async function () {
    const a = await device('A')
    const hc = await device('Hc')
    const g1 = await device('G1')
    const chatOf = await dm('A', ['G1'])
    await a.engine.sendText(chatOf, 'before the reset')
    expect(bodies(await g1.engine.open(chatOf))).deep.equals([
      'before the reset'
    ])
    const members = await chatId('Hc', 'Hawks Members')
    const oldNumber = await a.engine.safetyNumber(id('G1'))
    expect(oldNumber).matches(/^\d{60}$/)
    expect(await g1.engine.safetyNumber(id('A'))).equals(oldNumber)

    // G1 cannot reach the first device and resets from a second one.
    await f().signIn('G1~2', 'G1')
    const again = deviceOn('G1~2', 'G1')
    expect(await again.engine.start()).equals('link')
    await resetIdentity(again.setup, again.store.record)
    expect(await again.engine.start()).equals('ready')
    devices.set('G1', again)
    g1.engine.stop()

    await hint(a, chat(chatOf, 'grant'))
    expect(await openRequests(chatOf, id('G1'))).deep.include({
      filled: false,
      superseded: false
    })
    let view = await again.engine.open(chatOf)
    expect(view.historyLocked).equals(true)
    expect(statuses(view)).deep.equals(['locked'])

    // G1 is never asked to approve G1's own request: the server says so,
    // and the engine would not offer it even if a server claimed otherwise.
    const claims = again.client.chatGrants.bind(again.client)
    const own = (await claims()).filter(asking => asking.userId === id('G1'))
    // (one in the DM, one in Hawks Members)
    expect(own.map(asking => asking.canApprove)).deep.equals([false, false])
    again.client.chatGrants = async () =>
      (await claims()).map(asking => ({ ...asking, canApprove: true }))
    await again.engine.fillGrants()
    expect(
      (await again.client.chatGrants()).some(
        asking => asking.userId === id('G1') && asking.canApprove
      )
    ).equals(true)
    expect(again.engine.approvals()).deep.equals([])
    again.client.chatGrants = claims

    const asked = a.engine.approvals()
    expect(asked.map(approval => approval.conversationId)).deep.equals([chatOf])
    const [approval] = asked
    expect(approval.userId).equals(id('G1'))
    expect(approval.oldSafetyNumber).equals(oldNumber)
    expect(approval.newSafetyNumber).matches(/^\d{60}$/)
    expect(approval.newSafetyNumber).not.equals(oldNumber)
    expect(await a.engine.safetyNumber(id('G1'))).equals(
      approval.newSafetyNumber
    )
    // In Hawks Members only its moderators approve: the coach, not A.
    await hint(hc, chat(members, 'grant'))
    expect(
      hc.engine.approvals().map(asking => asking.conversationId)
    ).deep.equals([members])

    await a.engine.approve(approval.requestId)
    expect(await engineRefusal(a.engine.approve(approval.requestId))).equals(
      'target'
    )
    await hint(again, chat(chatOf, 'grant'))
    view = again.engine.view(chatOf)!
    expect(bodies(view)).deep.equals(['before the reset'])
    const aView = await a.engine.open(chatOf)
    expect(
      aView.members.find(member => member.userId === id('G1'))
        ?.safetyNumberChanged
    ).equals(true)
    expect(aView.safetyChanges.map(change => change.userId)).deep.equals([
      id('G1')
    ])
  })

  it('breaks the chain when the sole holder leaves, and earlier messages stay locked', async function () {
    const ha = await device('Ha')
    const chatOf = await dm('Ha', ['Hs', 'Es'])
    await ha.engine.sendText(chatOf, 'only Ha holds this')
    expect(await boxedAt(chatOf, 1)).deep.equals([id('Ha')])
    const hs = await device('Hs')
    const es = await device('Es')
    expect(await openRequests(chatOf, id('Hs'))).deep.equals([
      { filled: false, superseded: false }
    ])
    await ha.client.leaveDm(chatOf)

    await hs.engine.refresh()
    const listed = hs.engine.conversations().find(item => item.id === chatOf)
    expect(listed).include({ locked: true, noHolder: true })
    let view = await hs.engine.open(chatOf)
    expect(view.historyLocked).equals(false)
    expect(view.composer).equals('enabled')
    expect(statuses(view)).deep.equals(['locked'])

    await hs.engine.sendText(chatOf, 'still here')
    expect(await epochsOf(chatOf)).deep.equals([
      { epoch: 1, chain_break: false },
      { epoch: 2, chain_break: true }
    ])
    expect(await boxedAt(chatOf, 2)).deep.equals(sorted('Hs', 'Es'))
    expect(await openRequests(chatOf, id('Hs'))).deep.equals([
      { filled: false, superseded: true }
    ])
    view = hs.engine.view(chatOf)!
    expect(view.earlierLost).equals(true)
    expect(statuses(view)).deep.equals(['lost', 'ok'])
    expect(bodies(view)).deep.equals(['', 'still here'])

    view = await es.engine.open(chatOf)
    expect(statuses(view)).deep.equals(['lost', 'ok'])
    expect(view.earlierLost).equals(true)

    // Named by who is left in it, then, once Hs is alone, by who was.
    const titleOf = async (): Promise<string | undefined> =>
      (await hs.engine.refresh()).find(item => item.id === chatOf)?.title
    const names = new Map(
      (await es.client.chatMembers(chatOf)).map(member => [
        member.userId,
        member.shortName
      ])
    )
    const esName = names.get(id('Es')) ?? '?'
    expect(await titleOf()).equals(esName)
    await es.client.leaveDm(chatOf)
    const alone = (await hs.client.chatConversations()).find(
      item => item.id === chatOf
    )
    expect(alone?.memberCount).equals(1)
    expect(
      alone?.people.map(person => [person.userId, person.left])
    ).to.have.deep.members([
      [id('Ha'), true],
      [id('Es'), true]
    ])
    const title = await titleOf()
    expect(title).equals(
      alone?.people.map(person => `${person.shortName} (left)`).join(', ')
    )
    expect(title).contains(`${esName} (left)`)
    expect(hs.engine.view(chatOf)?.conversation.title).equals(title)
  })

  it('opens a merged DM’s history on the survivor’s newly granted device', async function () {
    const survivor = await f().person('Y')
    const closing = await f().person('Y2')
    await f()
      .db.insertInto('memberships')
      .values({
        id: makeId('membership'),
        user_id: closing,
        team_id: f().seed.teams.hawks,
        role: 'member',
        is_player: false
      })
      .execute()
    await f().drain()
    const a = await device('A')
    const y2 = await device('Y2')
    const chatOf = await dm('A', ['Y2'])
    await a.engine.sendText(chatOf, 'to Y2')
    await y2.engine.open(chatOf)
    await y2.engine.sendText(chatOf, 'from Y2')
    y2.engine.stop()

    await closeInto(f().db, closing, survivor)
    const y = await device('Y')
    let view = await y.engine.open(chatOf)
    expect(statuses(view)).deep.equals(['locked', 'locked'])
    await hint(a, chat(chatOf, 'grant'))
    await hint(y, chat(chatOf, 'grant'))
    view = y.engine.view(chatOf)!
    expect(bodies(view)).deep.equals(['to Y2', 'from Y2'])
    expect(view.messages[1].senderUserId).equals(closing)
    expect(view.messages[1].senderName).equals(undefined)
  })

  it('verifies the membership log, and stops granting and rotating where it breaks', async function () {
    const c = await device('C')
    const g2 = await device('G2')
    await device('Hc')
    const chatOf = await dm('C', ['G2', 'Hc'])
    brokenChat = chatOf
    await c.engine.sendText(chatOf, 'chain intact')
    expect(c.engine.verifiedMembers(chatOf)).deep.equals(
      sorted('C', 'G2', 'Hc')
    )

    // The server rewrites who joined, before G2 ever read the record.
    await f()
      .db.updateTable('chat_membership_log')
      .set({ user_id: id('F') })
      .where('conversation_id', '=', chatOf)
      .where('seq', '=', 2)
      .execute()
    let view = await g2.engine.open(chatOf)
    expect(view.unverified).equals(true)
    expect(view.conversation.unverified).equals(true)
    expect(g2.engine.verifiedMembers(chatOf)).equals(undefined)
    // Reading goes on.
    expect(bodies(view)).deep.equals(['chain intact'])
    // Posting goes on under the current epoch; no epoch is made.
    await f()
      .db.updateTable('chat_conversations')
      .set({ needs_rotation: true })
      .where('id', '=', chatOf)
      .execute()
    const posted = await g2.engine.sendText(chatOf, 'still posting')
    expect(posted?.epoch).equals(1)
    expect(await epochsOf(chatOf)).length(1)
    // Grants stop: a member added now is never filled by G2.
    await c.client.addDmMembers(chatOf, [id('Ha')])
    await device('Ha')
    await hint(g2, chat(chatOf, 'grant'))
    expect(await openRequests(chatOf, id('Ha'))).deep.equals([
      { filled: false, superseded: false }
    ])
    view = g2.engine.view(chatOf)!
    expect(statuses(view)).deep.equals(['ok', 'ok'])

    // A row removed from the middle breaks the chain too.
    const other = await dm('Hc', ['A', 'B'])
    await (await device('Hc')).engine.sendText(other, 'three of us')
    await f()
      .db.deleteFrom('chat_membership_log')
      .where('conversation_id', '=', other)
      .where('seq', '=', 2)
      .execute()
    const b = await device('B')
    expect((await b.engine.open(other)).unverified).equals(true)
    expect(b.engine.verifiedMembers(other)).equals(undefined)
  })

  it('never fills a request from somebody with no verified join, nor boxes them an epoch', async function () {
    const hc = await device('Hc')
    const ek = await device('Ek')
    const chatOf = await dm('Hc', ['Hk'])
    await hc.engine.sendText(chatOf, 'just us')
    // The server slips Ek in with no log row, asking for the history.
    const identity = ek.store.record.identity!
    await f()
      .db.insertInto('chat_members')
      .values({ conversation_id: chatOf, user_id: id('Ek') })
      .execute()
    await f()
      .db.insertInto('chat_grant_requests')
      .values({
        conversation_id: chatOf,
        user_id: id('Ek'),
        identity_id: identity.id,
        generation: 1
      })
      .execute()
    await f()
      .db.updateTable('chat_conversations')
      .set({ needs_rotation: true })
      .where('id', '=', chatOf)
      .execute()
    await hint(hc, chat(chatOf, 'grant'))
    expect(await openRequests(chatOf, id('Ek'))).deep.equals([
      { filled: false, superseded: false }
    ])
    expect(hc.engine.verifiedMembers(chatOf)).deep.equals(sorted('Hc', 'Hk'))
    const posted = await hc.engine.sendText(chatOf, 'no new epoch')
    expect(posted?.epoch).equals(1)
    expect(await epochsOf(chatOf)).length(1)
  })

  it('opens, on a newly granted device, messages signed before a reset and from a member who left', async function () {
    const s = await device('S')
    const k = await device('K')
    const l = await device('L')
    const chatOf = await dm('S', ['K', 'L'])
    await k.engine.open(chatOf)
    await k.engine.sendText(chatOf, 'K before the reset')
    await l.engine.open(chatOf)
    await l.engine.sendText(chatOf, 'L was here')
    await l.client.leaveDm(chatOf)

    await f().signIn('K~2', 'K')
    const kAgain = deviceOn('K~2', 'K')
    expect(await kAgain.engine.start()).equals('link')
    await resetIdentity(kAgain.setup, kAgain.store.record)
    expect(await kAgain.engine.start()).equals('ready')
    devices.set('K', kAgain)
    k.engine.stop()

    await s.client.addDmMembers(chatOf, [id('Ea')])
    const ea = await device('Ea')
    await hint(s, chat(chatOf, 'grant'))
    await hint(ea, chat(chatOf, 'grant'))
    let view = await ea.engine.open(chatOf)
    expect(bodies(view)).deep.equals(['K before the reset', 'L was here'])
    expect(view.messages[0].sentBeforeSafetyNumberChange).equals(true)
    expect(view.messages[1].sentBeforeSafetyNumberChange).equals(false)
    expect(view.messages[1].senderName).equals(undefined)
    expect(view.safetyChanges.map(change => change.userId)).deep.equals([
      id('K')
    ])

    // The next send rotates, leaving out the reset still awaiting approval.
    await s.engine.sendText(chatOf, 'after')
    expect(await boxedAt(chatOf, 2)).deep.equals(sorted('S', 'Ea'))
    await hint(ea, chat(chatOf, 'message'))
    view = ea.engine.view(chatOf)!
    expect(bodies(view)).deep.equals([
      'K before the reset',
      'L was here',
      'after'
    ])
  })

  it('takes a per-user key made on another of the person’s devices', async function () {
    const d = await device('D')
    const ec = await device('Ec')
    // D links two more devices; the second removes the third.
    const linked: Device[] = []
    for (const who of ['D~2', 'D~3']) {
      await f().signIn(who, 'D')
      const more = deviceOn(who, 'D')
      const asking = await ensureEnrolled(more.setup)
      const started = await startLink(more.setup, asking.record)
      const [pending] = (await d.client.chatLinks()).filter(
        link => link.id === started.link.id
      )
      await approveLink(d.setup, d.store.record, pending)
      expect((await pollLink(more.setup, started.record)).state).equals(
        'installed'
      )
      linked.push(more)
    }
    const [two, three] = linked
    const threeId = three.store.record.deviceId
    const moved = await revokeOtherDevice(two.setup, two.store.record, threeId)
    expect(moved.puks.map(puk => puk.generation)).deep.equals([1, 2])
    expect(d.store.record.puks.map(puk => puk.generation)).deep.equals([1])

    const chatOf = await dm('Ec', ['D'])
    await ec.engine.sendText(chatOf, 'to your newest key')
    const boxes = await f()
      .db.selectFrom('chat_epoch_boxes')
      .select(['generation'])
      .where('conversation_id', '=', chatOf)
      .where('user_id', '=', id('D'))
      .execute()
    expect(boxes.map(row => row.generation)).deep.equals([2])
    expect(bodies(await d.engine.open(chatOf))).deep.equals([
      'to your newest key'
    ])
    expect(d.store.record.puks.map(puk => puk.generation)).deep.equals([1, 2])
  })

  it('seals, uploads, sends and opens attachments', async function () {
    const a = await device('A')
    const b = await device('B')
    const chatOf = await dm('A', ['B'])
    const bytes = new Uint8Array(randomBytes(70000))
    const sent = await a.engine.attach(
      chatOf,
      [
        {
          bytes,
          contentType: 'image/jpeg',
          fileName: 'photo.jpg',
          width: 4,
          height: 3
        },
        {
          bytes: Uint8Array.of(1, 2, 3),
          contentType: 'video/mp4',
          fileName: 'clip.mp4',
          durationMs: 1500
        }
      ],
      'two files'
    )
    expect(sent?.attachments.map(ref => ref.fileName)).deep.equals([
      'photo.jpg',
      'clip.mp4'
    ])
    const view = await b.engine.open(chatOf)
    const [photo, clip] = view.messages.find(
      message => message.id === sent?.id
    )!.attachments
    expect(photo).include({
      contentType: 'image/jpeg',
      size: 70000,
      width: 4,
      height: 3
    })
    expect(clip.durationMs).equals(1500)
    expect(await b.engine.openAttachment(photo)).deep.equals(bytes)
    expect([...(await b.engine.openAttachment(clip))]).deep.equals([1, 2, 3])
    const rows = await f()
      .db.selectFrom('chat_message_attachments')
      .select(['attachment_id'])
      .where('message_id', '=', sent!.id)
      .execute()
    expect(rows.map(row => row.attachment_id).sort()).deep.equals(
      [photo.id, clip.id].sort()
    )

    // A blob changed on the way is refused, as is an unknown one.
    const tampered = deviceOn('B', 'B', {
      store: b.store.copy(),
      fetchBytes: async url => {
        const blob = new Uint8Array(await (await fetch(url)).arrayBuffer())
        blob[blob.length - 1] ^= 1
        return blob
      }
    })
    await tampered.engine.start()
    expect(await engineRefusal(tampered.engine.openAttachment(photo))).equals(
      'attachment'
    )
    tampered.engine.stop()
    try {
      await b.engine.openAttachment({ ...photo, id: 'cat_nothere' })
      expect.fail('opened an attachment that is not there')
    } catch (error) {
      expect((error as HttpError).code).equals('notFound')
    }
  })

  it('hears typing, device changes and resyncs from the socket', async function () {
    const a = await device('A')
    const b = await device('B')
    const chatOf = await dm('A', ['B'])
    await b.engine.open(chatOf)
    const heard: string[] = []
    const stop = b.engine.subscribe(event => {
      heard.push(event.type)
    })
    b.socket.emit({
      type: 'chatTyping',
      conversationId: chatOf,
      userId: id('A')
    })
    b.socket.emit({
      type: 'chatTyping',
      conversationId: chatOf,
      userId: id('B')
    })
    b.socket.emit({ type: 'chatTyping', conversationId: 'cnv_x', userId: 1 })
    expect(b.engine.view(chatOf)?.typing.map(who => who.userId)).deep.equals([
      id('A')
    ])
    await new Promise(resolve => setTimeout(resolve, 120))
    expect(b.engine.view(chatOf)?.typing).deep.equals([])
    b.socket.emit({ type: 'chatUser', kind: 'devices' })
    b.socket.emit({
      type: 'error',
      conversationId: chatOf,
      code: 'forbidden',
      message: 'no'
    })
    expect(heard).include('devices')

    await a.engine.sendText(chatOf, 'after a lost connection')
    await hint(b, { type: 'resync' })
    expect(bodies(b.engine.view(chatOf)!)).include('after a lost connection')
    expect(heard).include('conversations')

    expect(b.engine.typing(chatOf)).equals(true)
    expect(b.socket.typed).deep.equals([chatOf])
    // A chat the screen left is read again only when opened.
    b.engine.close(chatOf)
    await a.engine.sendText(chatOf, 'unseen until opened')
    await hint(b, chat(chatOf, 'message'))
    await hint(b, chat(chatOf, 'epoch'))
    await hint(b, chat(chatOf, 'members'))
    expect(bodies(b.engine.view(chatOf)!)).not.include('unseen until opened')
    expect(bodies(await b.engine.open(chatOf))).include('unseen until opened')
    stop()

    // Listening twice is once; stopping stops hearing.
    const again = b.engine.listen()
    again()
    expect(b.socket.listening).equals(1)
    b.engine.stop()
    expect(b.socket.listening).equals(0)
    devices.delete('B')
  })

  it('makes one epoch when two devices send first at once', async function () {
    const a = await device('A')
    const c = await device('C')
    const chatOf = await dm('A', ['C'])
    await c.engine.refresh()
    await Promise.all([
      a.engine.sendText(chatOf, 'from A'),
      c.engine.sendText(chatOf, 'from C')
    ])
    expect(await epochsOf(chatOf)).length(1)
    const view = await a.engine.open(chatOf)
    expect(bodies(view).sort()).deep.equals(['from A', 'from C'])
    expect(await a.engine.safetyNumber(id('N'))).equals(undefined)
  })
  it('marks content a member’s client malformed, and epochs that do not verify', async function () {
    const hk = await device('Hk')
    const hs = await device('Hs')
    const chatOf = await dm('Hk', ['Hs'])
    const fine = (await hk.engine.sendText(chatOf, 'fine'))!
    const record = hk.store.record
    const epochKey = epochKeyOf(record, chatOf, 1)!
    async function raw(
      kind: EnvelopeKind,
      content: unknown,
      targetIds?: string[]
    ): Promise<void> {
      const messageId = newMessageId()
      const sealed = sealMessage({
        conversationId: chatOf,
        epoch: 1,
        messageId,
        senderUserId: id('Hk'),
        kind,
        epochKey,
        plaintext: utf8(JSON.stringify(content)),
        identitySecretKey: record.identity!.keys.secretKey
      })
      await hk.client.postChatMessage(chatOf, {
        id: messageId,
        epoch: 1,
        kind,
        senderIdentityId: record.identity!.id,
        ...(targetIds == null ? {} : { targetIds }),
        nonce: b64(sealed.nonce),
        ciphertext: b64(sealed.ciphertext),
        signature: b64(sealed.signature)
      })
    }
    await raw('post', { type: 'text' })
    await raw('post', {
      type: 'reaction',
      targetId: fine.id,
      emoji: '👍',
      remove: false
    })
    await raw('delete', { type: 'delete', targetId: newMessageId() }, [fine.id])
    await hs.engine.open(chatOf)
    const view = await hs.engine.loadEarlier(chatOf)
    expect(statuses(view)).deep.equals(['removed', 'invalid', 'invalid'])

    // An epoch whose signature does not verify opens nothing under it.
    await f()
      .db.updateTable('chat_epochs')
      .set({ signature: new Uint8Array(64) })
      .where('conversation_id', '=', chatOf)
      .execute()
    await hk.engine.sendText(chatOf, 'under a forged epoch')
    const doubter = deviceOn('Hs', 'Hs', { store: hs.store.copy() })
    await doubter.engine.start()
    const doubted = await doubter.engine.open(chatOf)
    expect(doubted.messages[doubted.messages.length - 1]).include({
      status: 'invalid',
      body: ''
    })
    doubter.engine.stop()
  })

  it('refuses to approve what does not check out', async function () {
    const hc = await device('Hc')
    const lying = new LyingClient({
      baseUrl: f().api,
      token: f().tokenOf('Hc')
    })
    const doubter = deviceOn('Hc', 'Hc', {
      store: hc.store.copy(),
      client: lying
    })
    await doubter.engine.start()
    await doubter.engine.idle()
    const members = await chatId('Hc', 'Hawks Members')
    const latest = (await hc.client.chatEpochs(members)).latest
    const keysOf = async (key: string): Promise<ChatUserKeys> =>
      await hc.client.chatUserKeys(id(key))
    const hk = await keysOf('Hk')
    const ek = await keysOf('Ek')
    const asking = (
      keys: ChatUserKeys,
      overrides: Partial<ChatGrantRequest>
    ): ChatGrantRequest => ({
      id: 9000,
      conversationId: members,
      epoch: latest,
      userId: keys.userId,
      identityId: keys.identity!.id,
      identityKey: keys.identity!.publicKey,
      pukGeneration: keys.puk!.generation,
      pukPublicKey: keys.puk!.publicKey,
      pukSignature: keys.puk!.signature,
      identityReset: true,
      canApprove: true,
      openedAt: new Date().toISOString(),
      ...overrides
    })
    const forged = b64(new Uint8Array(64))
    lying.grants = () => [
      asking(hk, { id: 9001, pukSignature: forged }),
      asking(hk, { id: 9002, epoch: latest + 90 }),
      asking(ek, { id: 9003 }),
      asking(hk, { id: 9004, identityReset: false, pukSignature: forged }),
      asking(hk, { id: 9005, identityReset: false })
    ]
    // The forged one is skipped; the server finds nothing open for the other.
    expect(await doubter.engine.fillGrants()).equals(0)
    lying.refusals.push(refusal('postChatGrants', 'forbidden', 'notHolder'))
    expect(await doubter.engine.fillGrants()).equals(0)
    lying.refusals.push(refusal('postChatGrants', 'conflict', 'other'))
    try {
      await doubter.engine.fillGrants()
      expect.fail('a refusal was swallowed')
    } catch (error) {
      expect((error as HttpError).message).equals('other')
    }
    expect(
      doubter.engine.approvals().map(approval => approval.requestId)
    ).deep.equals([9001, 9002, 9003])
    expect(doubter.engine.approvals()[0].oldSafetyNumber).equals(undefined)
    expect(await engineRefusal(doubter.engine.approve(9001))).equals('badKeys')
    expect(await engineRefusal(doubter.engine.approve(9002))).equals('locked')
    expect(await engineRefusal(doubter.engine.approve(9003))).equals(
      'unverifiedMember'
    )
    expect(await engineRefusal(doubter.engine.approve(9009))).equals('target')
    doubter.engine.stop()

    // Where the membership record is broken, nothing is approved.
    const g2 = await device('G2')
    const lyingG2 = new LyingClient({
      baseUrl: f().api,
      token: f().tokenOf('G2')
    })
    const broken = deviceOn('G2', 'G2', {
      store: g2.store.copy(),
      client: lyingG2
    })
    await broken.engine.start()
    await broken.engine.idle()
    const hcKeys = await g2.client.chatUserKeys(id('Hc'))
    lyingG2.grants = () => [
      { ...asking(hcKeys, { id: 9100 }), conversationId: brokenChat, epoch: 1 }
    ]
    await broken.engine.fillGrants()
    expect(await engineRefusal(broken.engine.approve(9100))).equals(
      'unverified'
    )
    broken.engine.stop()
  })

  it('tries a refused post once more, and refuses sends it cannot make', async function () {
    const a = await device('A')
    const lying = new LyingClient({
      baseUrl: f().api,
      token: f().tokenOf('A')
    })
    const again = deviceOn('A', 'A', { store: a.store.copy(), client: lying })
    await again.engine.start()
    const chatOf = await dm('A', ['G2'])
    lying.refusals.push(refusal('postChatMessage', 'conflict', 'staleEpoch'))
    expect((await again.engine.sendText(chatOf, 'second try'))?.body).equals(
      'second try'
    )
    lying.refusals.push(refusal('postChatMessage', 'conflict', 'staleIdentity'))
    expect((await again.engine.sendText(chatOf, 'keys read'))?.status).equals(
      'ok'
    )
    lying.refusals.push(
      refusal('postChatMessage', 'conflict', 'staleEpoch'),
      refusal('postChatMessage', 'conflict', 'staleEpoch')
    )
    async function reasonOfRefusal(work: Promise<unknown>): Promise<unknown> {
      try {
        await work
      } catch (error) {
        return ((error as HttpError).details as { reason?: string }).reason
      }
      throw new Error('expected a refusal')
    }
    expect(await reasonOfRefusal(again.engine.sendText(chatOf, 'no'))).equals(
      'staleEpoch'
    )
    lying.refusals.push(refusal('postChatMessage', 'forbidden', 'notStaff'))
    expect(await reasonOfRefusal(again.engine.sendText(chatOf, 'no'))).equals(
      'notStaff'
    )

    // Uploads: parts missing are sent again; one that never completes fails.
    lying.refusals.push(
      refusal('completeChatAttachment', 'conflict', 'partsMissing')
    )
    const file = {
      bytes: Uint8Array.of(9, 8, 7),
      contentType: 'text/plain',
      fileName: 'n.txt'
    }
    const sent = await again.engine.attach(chatOf, [file])
    expect(sent?.attachments.map(ref => ref.fileName)).deep.equals(['n.txt'])
    for (let n = 0; n < 3; n++) {
      lying.refusals.push(
        refusal('completeChatAttachment', 'conflict', 'partsMissing')
      )
    }
    expect(await engineRefusal(again.engine.attach(chatOf, [file]))).equals(
      'attachment'
    )
    lying.refusals.length = 0
    lying.refusals.push(refusal('completeChatAttachment', 'conflict', 'other'))
    expect(await reasonOfRefusal(again.engine.attach(chatOf, [file]))).equals(
      'other'
    )
    expect(
      await engineRefusal(
        again.engine.attach(chatOf, [
          { ...file, bytes: new Uint8Array(MAX_ATTACHMENT_SIZE + 1) }
        ])
      )
    ).equals('attachment')

    // A member whose per-user key does not check out gets no epoch.
    const fresh = await dm('A', ['Ha'])
    lying.forged.add(id('Ha'))
    expect(await engineRefusal(again.engine.sendText(fresh, 'x'))).equals(
      'badKeys'
    )
    lying.forged.clear()
    await again.engine.sendText(fresh, 'first')
    // Due a rotation then, the send goes under the current epoch.
    await f()
      .db.updateTable('chat_conversations')
      .set({ needs_rotation: true })
      .where('id', '=', fresh)
      .execute()
    lying.forged.add(id('Ha'))
    expect((await again.engine.sendText(fresh, 'still 1'))?.epoch).equals(1)
    lying.forged.clear()
    lying.refusals.push(refusal('postChatEpoch', 'forbidden', 'notHolder'))
    expect(await reasonOfRefusal(again.engine.sendText(fresh, 'no'))).equals(
      'notHolder'
    )
    // Another device's epoch that boxed nothing here leaves it locked.
    const empty = await dm('A', ['Hk'])
    lying.refusals.push(refusal('postChatEpoch', 'conflict', 'epochTaken'))
    expect(await engineRefusal(again.engine.sendText(empty, 'x'))).equals(
      'locked'
    )

    // A closed chat is read only.
    await f()
      .db.updateTable('chat_conversations')
      .set({ closed_at: new Date() })
      .where('id', '=', fresh)
      .execute()
    await again.engine.refresh()
    expect((await again.engine.open(fresh)).composer).equals('closed')
    expect(await engineRefusal(again.engine.sendText(fresh, 'x'))).equals(
      'readOnly'
    )
    again.engine.stop()
  })
})
