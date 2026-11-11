import { expect } from 'chai'
import { describe, it } from 'mocha'

import {
  type ChatGrantBox,
  type ChatGrantRequest,
  type ChatHistoryGrantBox,
  type ChatHistoryRequest,
  type ChatIdentity,
  type ChatMessage,
  TeamStationClient
} from '../../../common/api'
import { signEpoch, signPuk } from '../../../common/chatCrypto/chain'
import {
  ChatCryptoUnavailable,
  type CoreCall
} from '../../../common/chatCrypto/coreCall'
import { epochAad, hpkeOpen, hpkeSeal } from '../../../common/chatCrypto/hpke'
import {
  newDeviceKeys,
  newIdentityKey,
  newPukKey
} from '../../../common/chatCrypto/keys'
import { sealMessage } from '../../../common/chatCrypto/seal'
import { HttpError } from '../../../common/errors'
import type { ChatSocketListener } from '../../../common/gameSocket'
import { userIdOfGumbo } from '../../../common/userId'
import { b64, newRecord, unb64, withEpochKey } from '../keyRecord'
import { type ChatEngineError, type EngineContext, KeyHolder } from './context'
import {
  IdentityCache,
  openEnvelope,
  openEpochKeys,
  takeEpochs
} from './decrypt'
import { ChatEngine } from './engine'
import { fillGrants } from './grants'
import {
  approveHistoryGrant,
  fillHistoryGrants,
  heldHistoryEpoch,
  HISTORY_GRANT_BATCH,
  readHistoryGrants
} from './historyRecovery'
import { genesisHead } from './log'
import { epochForSend } from './rotate'
import {
  ChatMemory,
  type ConversationState,
  newConversationState
} from './store'
import { openPending, syncEpochs, syncHistoryBoxes } from './sync'

// Fault injection at the platform boundary keeps the real crypto and engine
// paths intact until the chosen operation fails.
const core = require('../../../common/chatCrypto/core') as { call: CoreCall }

async function withFailedCore(
  op: Parameters<CoreCall>[0],
  run: (failure: ChatCryptoUnavailable) => Promise<void>
): Promise<void> {
  const original = core.call
  const failure = new ChatCryptoUnavailable('trapped')
  core.call = (asked, args) => {
    if (asked === op) throw failure
    return original(asked, args)
  }
  try {
    await run(failure)
  } finally {
    core.call = original
  }
}

/** Lets detached work (the historical stream) finish. */
async function settle(): Promise<void> {
  await new Promise(resolve => setTimeout(resolve, 5))
}

function fixture(): {
  state: ConversationState
  ctx: EngineContext
  identityKeys: ReturnType<typeof newIdentityKey>
} {
  const identityKeys = newIdentityKey()
  const record = newRecord(userIdOfGumbo(1), 'cdv_test', newDeviceKeys())
  record.identity = { id: 'cid_test', keys: identityKeys }
  record.puks = [{ generation: 1, keys: newPukKey() }]
  const state = newConversationState({
    id: 'cnv_test',
    kind: 'dm',
    title: null,
    scope: null,
    scopeName: null,
    avatarName: null,
    avatarUrl: null,
    lastSeq: 1,
    lastMessageAt: null,
    lastPostAt: null,
    lastPostId: null,
    lastPostSeq: 0,
    preferences: {
      pinned: false,
      muted: false,
      manualUnread: false,
      manualUnreadRevision: 0
    },
    unread: 0,
    canPost: true,
    canModerate: false,
    locked: false,
    noHolder: false,
    closed: false,
    memberCount: 1,
    people: []
  })
  state.epochsAfter = 1
  state.epochs.set(1, {
    valid: true,
    record: {
      epoch: 1,
      createdByUserId: userIdOfGumbo(1),
      identityId: 'cid_test',
      previousKeyBox: null,
      chainBreak: false,
      signature: '',
      createdAt: '2027-04-10T12:00:00Z'
    }
  })
  const identity: ChatIdentity = {
    id: 'cid_test',
    userId: userIdOfGumbo(1),
    publicKey: b64(identityKeys.publicKey),
    createdAt: '2027-04-10T12:00:00Z',
    replacedAt: null
  }
  const keys = new KeyHolder(
    {
      load: async () => record,
      save: async () => {},
      wipe: async () => {},
      exists: async () => true
    },
    record
  )
  const ctx: EngineContext = {
    client: new TeamStationClient({
      baseUrl: 'https://api.example.test/api/v1',
      fetch: async () => {
        throw new Error('Unexpected network request')
      }
    }),
    userId: userIdOfGumbo(1),
    keys,
    memory: new ChatMemory(),
    identities: new IdentityCache({ chatIdentity: async () => identity }),
    pageSize: 50,
    refreshKeys: async () => {
      throw new Error('Unexpected key refresh')
    }
  }
  return { state, ctx, identityKeys }
}

describe('chat decryption when the crypto core stops', () => {
  it('does not cache a stopped core as an invalid message', async () => {
    const { ctx, state, identityKeys } = fixture()
    const epochKey = new Uint8Array(32).fill(7)
    await ctx.keys.update(record =>
      withEpochKey(record, 'cnv_test', 1, epochKey)
    )
    const content = {
      type: 'text',
      body: 'hello',
      mentions: [],
      attachments: []
    }
    const sealed = sealMessage({
      conversationId: 'cnv_test',
      epoch: 1,
      messageId: 'msg_test',
      senderUserId: userIdOfGumbo(1),
      kind: 'post',
      epochKey,
      identitySecretKey: identityKeys.secretKey,
      plaintext: new TextEncoder().encode(JSON.stringify(content))
    })
    const envelope: ChatMessage = {
      id: 'msg_test',
      conversationId: 'cnv_test',
      seq: 1,
      epoch: 1,
      senderUserId: userIdOfGumbo(1),
      senderIdentityId: 'cid_test',
      kind: 'post',
      targetIds: null,
      nonce: b64(sealed.nonce),
      ciphertext: b64(sealed.ciphertext),
      signature: b64(sealed.signature),
      attachmentIds: [],
      clearedAt: null,
      createdAt: '2027-04-10T12:00:00Z'
    }
    state.envelopes.set(1, envelope)
    await withFailedCore('messageKey', async failure => {
      let caught: unknown
      try {
        await openPending(ctx, state)
      } catch (error) {
        caught = error
      }
      expect(caught).equals(failure)
      expect(state.opened.has(envelope.id)).equals(false)
    })
    await openPending(ctx, state)
    expect(state.opened.get(envelope.id)?.status).equals('ok')
  })

  it('propagates a stopped core while opening an epoch box', async () => {
    const { ctx, state } = fixture()
    await withFailedCore('hpkeOpen', async failure => {
      let caught: unknown
      try {
        await openEpochKeys(ctx, 'cnv_test', state, [
          {
            epoch: 1,
            identityId: 'cid_test',
            pukGeneration: 1,
            box: b64(new Uint8Array(48)),
            grantedByUserId: null
          }
        ])
      } catch (error) {
        caught = error
      }
      expect(caught).equals(failure)
      expect(ctx.keys.record.epochKeys).deep.equals({})
    })
  })

  it('propagates a stopped core while opening the previous epoch', async () => {
    const { ctx, state } = fixture()
    await ctx.keys.update(record =>
      withEpochKey(record, 'cnv_test', 2, new Uint8Array(32))
    )
    state.epochs.set(2, {
      valid: true,
      record: {
        ...state.epochs.get(1)!.record,
        epoch: 2,
        previousKeyBox: b64(new Uint8Array(72))
      }
    })
    await withFailedCore('openPreviousEpochKey', async failure => {
      let caught: unknown
      try {
        await openEpochKeys(ctx, 'cnv_test', state, [])
      } catch (error) {
        caught = error
      }
      expect(caught).equals(failure)
      expect(ctx.keys.record.epochKeys.cnv_test['1']).equals(undefined)
    })
  })
})

describe('independent historical box delivery', () => {
  function delivery(): ReturnType<typeof fixture> & {
    cursors: Array<string | undefined>
  } {
    const f = fixture()
    f.ctx.memory.conversations.set('cnv_test', f.state)
    const cursors: Array<string | undefined> = []
    f.ctx.client.chatEpochs = async (_id, _after, query) => {
      cursors.push(query?.boxesAfter)
      return {
        latest: 1,
        needsRotation: false,
        noHolder: false,
        epochs: [],
        boxes: [],
        historyRecoveryVersion: 1,
        freshEpochsEnabled: true,
        ...(query == null
          ? {}
          : { nextBoxesCursor: '9007199254740993', hasMoreBoxes: false })
      }
    }
    return { ...f, cursors }
  }
  it('keeps metadata and bigint delivery cursors independent and serializes concurrent drains', async () => {
    const { ctx, state, cursors } = delivery()
    await Promise.all([
      syncEpochs(ctx, 'cnv_test'),
      syncEpochs(ctx, 'cnv_test')
    ])
    await syncHistoryBoxes(ctx, 'cnv_test')
    // The second call came while the first read ran: one more read follows.
    expect(cursors).deep.equals([undefined, undefined, '0'])
    expect(state.boxesCursor).equals('9007199254740993')
    expect(state.epochsAfter).equals(1)
    await syncEpochs(ctx, 'cnv_test')
    await syncHistoryBoxes(ctx, 'cnv_test')
    expect(cursors.slice(3)).deep.equals([undefined, '9007199254740993'])
  })
  it('keeps current sending available when the historical stream fails, and retries from its cursor', async () => {
    const { ctx, state } = delivery()
    const original = ctx.client.chatEpochs
    let fail = true
    ctx.client.chatEpochs = async (id, after, query) => {
      if (query != null && fail) throw new Error('offline')
      return await original(id, after, query)
    }
    await syncEpochs(ctx, 'cnv_test')
    await syncHistoryBoxes(ctx, 'cnv_test')
    expect(state.latest).equals(1)
    expect(state.freshEpochsEnabled).equals(true)
    expect(state.historyError).equals(true)
    expect(state.boxesCursor).equals('0')
    fail = false
    await syncEpochs(ctx, 'cnv_test')
    await syncHistoryBoxes(ctx, 'cnv_test')
    expect(state.historyError).equals(false)
    expect(state.boxesCursor).equals('9007199254740993')
  })
  it('replays a delivery after a failed key-store write', async () => {
    const { ctx, state } = delivery()
    const record = ctx.keys.record
    let fail = true
    ctx.keys = new KeyHolder(
      {
        load: async () => record,
        exists: async () => true,
        wipe: async () => {},
        save: async () => {
          if (fail) throw new Error('disk full')
        }
      },
      record
    )
    const key = new Uint8Array(32).fill(42)
    const box = {
      epoch: 1,
      identityId: record.identity!.id,
      pukGeneration: 1,
      grantedByUserId: ctx.userId,
      box: b64(
        hpkeSeal(
          'grant',
          record.puks[0].keys.publicKey,
          epochAad({
            conversationId: 'cnv_test',
            epoch: 1,
            recipientUserId: ctx.userId,
            identityId: record.identity!.id,
            generation: 1
          }),
          key
        )
      )
    }
    const original = ctx.client.chatEpochs
    ctx.client.chatEpochs = async (id, after, query) => ({
      ...(await original(id, after, query)),
      boxes: query == null ? [] : [box]
    })
    await syncEpochs(ctx, 'cnv_test')
    await syncHistoryBoxes(ctx, 'cnv_test')
    expect(state.boxesCursor).equals('0')
    expect(ctx.keys.record.epochKeys.cnv_test).equals(undefined)
    fail = false
    await syncEpochs(ctx, 'cnv_test')
    await syncHistoryBoxes(ctx, 'cnv_test')
    expect(state.boxesCursor).equals('9007199254740993')
    expect(ctx.keys.record.epochKeys.cnv_test['1']).equals(b64(key))
  })
  it('does not advance for an unavailable PUK, and rejects a stalled page', async () => {
    const { ctx, state } = delivery()
    ctx.refreshKeys = async () => {}
    const original = ctx.client.chatEpochs
    ctx.client.chatEpochs = async (id, after, query) => ({
      ...(await original(id, after, query)),
      boxes:
        query == null
          ? []
          : [
              {
                epoch: 1,
                identityId: ctx.keys.record.identity!.id,
                pukGeneration: 99,
                box: '',
                grantedByUserId: null
              }
            ]
    })
    await syncEpochs(ctx, 'cnv_test')
    await syncHistoryBoxes(ctx, 'cnv_test')
    expect(state.boxesCursor).equals('0')
    expect(state.historyError).equals(true)
    ctx.client.chatEpochs = async (id, after, query) => ({
      ...(await original(id, after, query)),
      nextBoxesCursor: '0',
      hasMoreBoxes: query != null
    })
    await syncEpochs(ctx, 'cnv_test')
    await syncHistoryBoxes(ctx, 'cnv_test')
    expect(state.historyError).equals(true)
    expect(state.boxesCursor).equals('0')
  })
  it('reads and sends on the current epochs while a historical delivery is held', async () => {
    const { ctx, state } = delivery()
    const original = ctx.client.chatEpochs
    let release: () => void = () => {}
    const held = new Promise<void>(resolve => {
      release = resolve
    })
    ctx.client.chatEpochs = async (id, after, query) => {
      if (query != null) await held
      return await original(id, after, query)
    }
    // The current epochs settle while the historical stream is still held.
    const current = await syncEpochs(ctx, 'cnv_test')
    expect(current.latest).equals(1)
    expect(state.boxesCursor).equals('0')
    expect(await syncEpochs(ctx, 'cnv_test')).equals(state)
    release()
    await syncHistoryBoxes(ctx, 'cnv_test')
    expect(state.boxesCursor).equals('9007199254740993')
  })
  it('unlocks a locked message in place when a later historical delivery opens its key', async () => {
    const { ctx, state, identityKeys } = delivery()
    const record = ctx.keys.record
    const key = new Uint8Array(32).fill(7)
    const sealed = sealMessage({
      conversationId: 'cnv_test',
      epoch: 1,
      messageId: 'msg_history',
      senderUserId: userIdOfGumbo(1),
      kind: 'post',
      epochKey: key,
      identitySecretKey: identityKeys.secretKey,
      plaintext: new TextEncoder().encode(
        JSON.stringify({
          type: 'text',
          body: 'older note',
          mentions: [],
          attachments: []
        })
      )
    })
    state.envelopes.set(1, {
      id: 'msg_history',
      conversationId: 'cnv_test',
      seq: 1,
      epoch: 1,
      senderUserId: userIdOfGumbo(1),
      senderIdentityId: 'cid_test',
      kind: 'post',
      targetIds: null,
      nonce: b64(sealed.nonce),
      ciphertext: b64(sealed.ciphertext),
      signature: b64(sealed.signature),
      attachmentIds: [],
      clearedAt: null,
      createdAt: '2027-04-10T12:00:00Z'
    })
    state.synced = true
    await openPending(ctx, state)
    expect(state.opened.get('msg_history')?.status).equals('locked')
    const box = {
      epoch: 1,
      identityId: record.identity!.id,
      pukGeneration: 1,
      grantedByUserId: ctx.userId,
      box: b64(
        hpkeSeal(
          'grant',
          record.puks[0].keys.publicKey,
          epochAad({
            conversationId: 'cnv_test',
            epoch: 1,
            recipientUserId: ctx.userId,
            identityId: record.identity!.id,
            generation: 1
          }),
          key
        )
      )
    }
    const original = ctx.client.chatEpochs
    ctx.client.chatEpochs = async (id, after, query) => ({
      ...(await original(id, after, query)),
      boxes: query == null ? [] : [box]
    })
    const events: string[] = []
    ctx.memory.emit = event => {
      events.push(event.type)
    }
    await syncEpochs(ctx, 'cnv_test')
    await syncHistoryBoxes(ctx, 'cnv_test')
    expect(state.opened.get('msg_history')?.status).equals('ok')
    expect(events).includes('conversation')
  })
  it('reads the current epochs once, and marks history when their box needs a key it cannot get', async () => {
    const { ctx, state } = delivery()
    let refreshed = 0
    ctx.refreshKeys = async () => {
      refreshed += 1
    }
    const original = ctx.client.chatEpochs
    let current = 0
    ctx.client.chatEpochs = async (id, after, query) => {
      const answer = await original(id, after, query)
      if (query != null) return answer
      current += 1
      return {
        ...answer,
        hasMoreBoxes: true,
        boxes: [
          {
            epoch: 1,
            identityId: ctx.keys.record.identity!.id,
            pukGeneration: 99,
            box: '',
            grantedByUserId: null
          }
        ]
      }
    }
    await syncEpochs(ctx, 'cnv_test')
    expect(current).equals(1)
    expect(refreshed).equals(1)
    expect(state.currentKeysMissing).equals(true)
  })
  it('clears a missing current key on a legacy server once a later read opens it', async () => {
    const { ctx, state } = delivery()
    const engine = new ChatEngine({
      client: ctx.client,
      userId: ctx.userId,
      device: { name: 'Unit device', platform: 'web' },
      store: {
        load: async () => ctx.keys.record,
        save: async () => {},
        exists: async () => true,
        wipe: async () => {}
      }
    })
    Object.assign(engine, { context: ctx, memory: ctx.memory })
    engine.status = 'ready'
    const record = ctx.keys.record
    // The new per-user key reaches this device only after the first read.
    const puk = newPukKey()
    let issued = false
    ctx.refreshKeys = async () => {
      if (!issued) return
      await ctx.keys.update(held => ({
        ...held,
        puks: [...held.puks, { generation: 2, keys: puk }]
      }))
    }
    const key = new Uint8Array(32).fill(5)
    const original = ctx.client.chatEpochs
    ctx.client.chatEpochs = async (id, after, query) => {
      const answer = await original(id, after, query)
      delete answer.historyRecoveryVersion
      return {
        ...answer,
        boxes: [
          {
            epoch: 1,
            identityId: record.identity!.id,
            pukGeneration: 2,
            grantedByUserId: null,
            box: b64(
              hpkeSeal(
                'epoch',
                puk.publicKey,
                epochAad({
                  conversationId: 'cnv_test',
                  epoch: 1,
                  recipientUserId: ctx.userId,
                  identityId: record.identity!.id,
                  generation: 2
                }),
                key
              )
            )
          }
        ]
      }
    }
    await syncEpochs(ctx, 'cnv_test')
    expect(engine.view('cnv_test')!.historyRecovery).equals('retryableError')
    issued = true
    await syncEpochs(ctx, 'cnv_test')
    expect(ctx.keys.record.epochKeys.cnv_test['1']).equals(b64(key))
    expect(state.historyRecoveryVersion).equals(undefined)
    expect(engine.view('cnv_test')!.historyRecovery).not.equals(
      'retryableError'
    )
    engine.stop()
  })
  it('reads again for a grant that lands while a delivery is in flight', async () => {
    const { ctx, state, cursors } = delivery()
    const record = ctx.keys.record
    const key = new Uint8Array(32).fill(9)
    const granted = {
      epoch: 1,
      identityId: record.identity!.id,
      pukGeneration: 1,
      grantedByUserId: userIdOfGumbo(2),
      box: b64(
        hpkeSeal(
          'grant',
          record.puks[0].keys.publicKey,
          epochAad({
            conversationId: 'cnv_test',
            epoch: 1,
            recipientUserId: ctx.userId,
            identityId: record.identity!.id,
            generation: 1
          }),
          key
        )
      )
    }
    const original = ctx.client.chatEpochs
    let boxes: Array<typeof granted> = []
    let release: () => void = () => {}
    const held = new Promise<void>(resolve => {
      release = resolve
    })
    let latest = 1
    ctx.client.chatEpochs = async (id, after, query) => {
      // Each answer is what the server held when the request arrived.
      const answer = { ...(await original(id, after, query)), latest, boxes }
      if (query != null && cursors.length === 1) await held
      return answer
    }
    const first = syncHistoryBoxes(ctx, 'cnv_test')
    await settle()
    boxes = [granted]
    const second = syncHistoryBoxes(ctx, 'cnv_test')
    release()
    await Promise.all([first, second])
    expect(cursors).deep.equals(['0', '9007199254740993'])
    expect(ctx.keys.record.epochKeys.cnv_test['1']).equals(b64(key))
    // The same holds for the current epochs read.
    let hold: () => void = () => {}
    const current = new Promise<void>(resolve => {
      hold = resolve
    })
    ctx.client.chatEpochs = async (id, after, query) => {
      const answer = { ...(await original(id, after, query)), latest }
      if (latest === 1) await current
      return answer
    }
    const before = syncEpochs(ctx, 'cnv_test')
    await settle()
    latest = 2
    const after = syncEpochs(ctx, 'cnv_test')
    hold()
    expect(await before).equals(state)
    await after
    expect(state.latest).equals(2)
  })
  it('pages the historical stream until it is complete', async () => {
    const { ctx, state, cursors } = delivery()
    const original = ctx.client.chatEpochs
    ctx.client.chatEpochs = async (id, after, query) => {
      const answer = await original(id, after, query)
      return query?.boxesAfter === '0'
        ? { ...answer, nextBoxesCursor: '5', hasMoreBoxes: true }
        : answer
    }
    await syncEpochs(ctx, 'cnv_test')
    await syncHistoryBoxes(ctx, 'cnv_test')
    expect(cursors).deep.equals([undefined, '0', '5'])
    expect(state.boxesCursor).equals('9007199254740993')
  })
  it('stops quietly when the person has left the chat while its history streams', async () => {
    const { ctx, state } = delivery()
    const original = ctx.client.chatEpochs
    ctx.client.chatEpochs = async (id, after, query) => {
      if (query != null) throw new HttpError('notFound', 'Not found')
      return await original(id, after, query)
    }
    const events: string[] = []
    ctx.memory.emit = event => {
      events.push(event.type)
    }
    await syncEpochs(ctx, 'cnv_test')
    await syncHistoryBoxes(ctx, 'cnv_test')
    expect(events).not.includes('error')
    expect(state.historyError).equals(false)
  })
  it('reads the historical stream only when a hint or key change asks for it', async () => {
    const { ctx, state, cursors } = delivery()
    await syncEpochs(ctx, 'cnv_test')
    await syncEpochs(ctx, 'cnv_test')
    await settle()
    expect(cursors).deep.equals([undefined, undefined])
    state.historyDue = true
    await syncEpochs(ctx, 'cnv_test')
    await settle()
    expect(cursors.slice(2)).deep.equals([undefined, '0'])
    expect(state.historyDue).equals(false)
    await ctx.keys.replace(async () => ({
      ...ctx.keys.record,
      puks: [...ctx.keys.record.puks, { generation: 2, keys: newPukKey() }]
    }))
    await syncEpochs(ctx, 'cnv_test')
    await settle()
    expect(cursors.slice(4)).deep.equals([undefined, '9007199254740993'])
  })
  it('leaves the rest of a long delivery to the next epochs read', async () => {
    const { ctx, state, cursors } = delivery()
    const original = ctx.client.chatEpochs
    ctx.client.chatEpochs = async (id, after, query) => ({
      ...(await original(id, after, query)),
      nextBoxesCursor: String(BigInt(query?.boxesAfter ?? '0') + 1n),
      hasMoreBoxes: true
    })
    await syncHistoryBoxes(ctx, 'cnv_test')
    expect(cursors).length(100)
    expect(state.boxesCursor).equals('100')
    expect(state.historyDue).equals(true)
  })
  /**
   * A ready engine on the fixture's context that hears hints, over chats
   * whose one message is under a key this device lacks.
   */
  function listening(ctx: EngineContext): {
    engine: ChatEngine
    hear: ChatSocketListener
  } {
    let hear: ChatSocketListener = () => {}
    const engine = new ChatEngine({
      client: ctx.client,
      userId: ctx.userId,
      device: { name: 'Unit device', platform: 'web' },
      store: {
        load: async () => ctx.keys.record,
        save: async () => {},
        exists: async () => true,
        wipe: async () => {}
      },
      socket: {
        onChat: listener => {
          hear = listener
          return () => {}
        },
        sendTyping: () => true
      }
    })
    Object.assign(engine, {
      context: ctx,
      memory: ctx.memory,
      blockPolicyPending: false
    })
    engine.status = 'ready'
    engine.listen()
    // As `start()` wires them into the context it builds.
    Object.assign(
      ctx,
      (
        engine as unknown as { contextHooks: () => Partial<EngineContext> }
      ).contextHooks()
    )
    const envelope = (conversationId: string): ChatMessage => ({
      id: `msg_${conversationId}`,
      seq: 1,
      conversationId,
      epoch: 1,
      senderUserId: ctx.userId,
      senderIdentityId: 'cid_test',
      kind: 'post',
      targetIds: null,
      nonce: '',
      signature: '',
      attachmentIds: [],
      createdAt: '2026-10-01T00:00:00Z',
      ciphertext: 'unopened',
      clearedAt: null
    })
    ctx.client.chatBlocks = async () => []
    ctx.client.chatConversations = async () =>
      [...ctx.memory.conversations.values()].map(chat => chat.summary)
    ctx.client.chatMembers = async () => []
    ctx.client.chatLog = async () => []
    ctx.client.chatMessages = async (id, query) =>
      query?.after == null ? [envelope(id)] : []
    ctx.client.chatReads = async () => []
    ctx.client.chatPins = async () => []
    ctx.client.chatGrants = async () => []
    ctx.client.chatHistoryGrants = async () => ({
      requests: [],
      nextCursor: null
    })
    return {
      engine,
      hear: event => {
        hear(event)
      }
    }
  }
  it('reads history on a visit to locked history, a refresh, a grant or epoch hint, and a reconnect', async () => {
    const { ctx, state, cursors } = delivery()
    const { engine, hear } = listening(ctx)
    const histories = async (): Promise<number> => {
      await engine.idle()
      await settle()
      return cursors.filter(cursor => cursor != null).length
    }
    // A read that finds nothing never flashes `recovering`.
    expect(await engine.open('cnv_test')).include({
      historyLocked: true,
      historyRecovery: 'waitingForHolder'
    })
    expect(await histories()).equals(1)
    expect(engine.view('cnv_test')!.historyRecovery).equals('waitingForHolder')
    await engine.refresh()
    expect(await histories()).equals(2)
    for (const hint of [
      { type: 'chat', kind: 'grant', conversationId: 'cnv_test', at: '' },
      { type: 'chat', kind: 'epoch', conversationId: 'cnv_test', at: '' },
      { type: 'resync' }
    ] as const) {
      const before = await histories()
      hear(hint)
      expect(await histories()).equals(before + 1)
    }
    // A chat no screen holds reads its history when it is next synced. The
    // hint still runs the grant pass: a new epoch opens historical requests.
    engine.close('cnv_test')
    const before = await histories()
    let passes = 0
    ctx.client.chatGrants = async () => {
      passes++
      return []
    }
    hear({ type: 'chat', kind: 'epoch', conversationId: 'cnv_test', at: '' })
    hear({ type: 'chat', kind: 'epoch', conversationId: 'cnv_gone', at: '' })
    expect(await histories()).equals(before)
    expect(passes).equals(1)
    expect(state.historyDue).equals(true)
    await engine.open('cnv_test')
    expect(await histories()).above(before)
    expect(state.historyDue).equals(false)
    engine.stop()
  })
  it('keeps a historical stream inside idle(), and ends it once stopped', async () => {
    const { ctx, state, cursors } = delivery()
    const { engine } = listening(ctx)
    let release: () => void = () => {}
    const held = new Promise<void>(resolve => {
      release = resolve
    })
    const original = ctx.client.chatEpochs
    ctx.client.chatEpochs = async (id, after, query) => {
      if (query != null) await held
      return {
        ...(await original(id, after, query)),
        ...(query == null
          ? {}
          : {
              nextBoxesCursor: String(BigInt(query.boxesAfter) + 1n),
              hasMoreBoxes: true
            })
      }
    }
    const errors: unknown[] = []
    ctx.memory.subscribe(event => {
      if (event.type === 'error') errors.push(event.error)
    })
    state.historyDue = true
    await syncEpochs(ctx, 'cnv_test')
    let idle = false
    const idled = engine.idle().then(() => {
      idle = true
    })
    await settle()
    expect(idle).equals(false)
    engine.stop()
    release()
    await idled
    // The page in flight when it stopped is neither stored nor followed.
    expect(cursors.filter(cursor => cursor != null)).deep.equals(['0'])
    expect(state.boxesCursor).equals('0')
    expect(errors).deep.equals([])
  })
  it('does not show recovering when a new session streams only keys it holds', async () => {
    const { ctx, state, cursors } = delivery()
    const first = state.epochs.get(1)!
    state.epochs.set(2, {
      valid: true,
      record: { ...first.record, epoch: 2, chainBreak: true }
    })
    state.epochsAfter = 2
    await ctx.keys.update(record =>
      withEpochKey(record, 'cnv_test', 2, new Uint8Array(32).fill(3))
    )
    const original = ctx.client.chatEpochs
    ctx.client.chatEpochs = async (id, after, query) => ({
      ...(await original(id, after, query)),
      latest: 2,
      // The current box, already held: the stream starts again at '0'.
      boxes:
        query == null
          ? []
          : [
              {
                epoch: 2,
                identityId: 'cid_test',
                pukGeneration: 1,
                grantedByUserId: null,
                box: b64(new Uint8Array(48))
              }
            ],
      ...(query == null ? {} : { nextBoxesCursor: '7', hasMoreBoxes: false })
    })
    const { engine } = listening(ctx)
    const seen: string[] = []
    ctx.memory.subscribe(event => {
      if (event.type === 'conversation')
        seen.push(engine.view(event.conversationId)!.historyRecovery!)
    })
    expect(await engine.open('cnv_test')).include({
      historyLocked: true,
      historyRecovery: 'waitingForHolder'
    })
    await engine.idle()
    await settle()
    expect(cursors.filter(cursor => cursor != null)).deep.equals(['0'])
    expect(state.boxesCursor).equals('7')
    expect(seen).not.include('recovering')
    expect(engine.view('cnv_test')!.historyRecovery).equals('waitingForHolder')
    engine.stop()
  })
  it('reads for a message hint only the list, open pins and the named chat', async () => {
    const { ctx, state } = delivery()
    const other = newConversationState({ ...state.summary, id: 'cnv_other' })
    other.epochsAfter = 1
    other.epochs = new Map(state.epochs)
    ctx.memory.conversations.set('cnv_other', other)
    const { engine, hear } = listening(ctx)
    // Both chats open with locked history.
    expect((await engine.open('cnv_test')).historyLocked).equals(true)
    expect((await engine.open('cnv_other')).historyLocked).equals(true)
    await engine.refresh()
    await engine.idle()
    await settle()
    const calls: string[] = []
    const client = ctx.client as unknown as Record<
      string,
      (...args: unknown[]) => Promise<unknown>
    >
    for (const name of Object.keys(client)) {
      const call = client[name]
      if (typeof call !== 'function') continue
      client[name] = async (...args) => {
        calls.push(name)
        return await call.apply(ctx.client, args)
      }
    }
    hear({
      type: 'chat',
      kind: 'message',
      conversationId: 'cnv_test',
      seq: 2,
      at: ''
    })
    await engine.idle()
    await settle()
    // No epochs, grant requests or historical stream: a busy chat must not
    // multiply recovery reads by its message rate.
    expect(calls.sort()).deep.equals([
      'chatBlocks',
      'chatConversations',
      'chatMembers',
      'chatMembers',
      'chatMessages',
      'chatMessages',
      'chatPins',
      'chatPins'
    ])
    engine.stop()
  })
  it('uses only the legacy endpoint shape on a server without the capability', async () => {
    const { ctx, cursors } = delivery()
    const original = ctx.client.chatEpochs
    ctx.client.chatEpochs = async (id, after, query) => {
      const result = await original(id, after, query)
      delete result.historyRecoveryVersion
      return result
    }
    await syncEpochs(ctx, 'cnv_test')
    expect(cursors).deep.equals([undefined])
    expect(ctx.memory.recoveryVersion).equals(undefined)
  })
})

describe('historical client grants', () => {
  async function grantFixture(): Promise<
    ReturnType<typeof fixture> & {
      request: ChatHistoryRequest
      posted: ChatHistoryGrantBox[]
      recipientPuk: ReturnType<typeof newPukKey>
    }
  > {
    const f = fixture()
    const { ctx, state } = f
    ctx.memory.conversations.set('cnv_test', state)
    const first = state.epochs.get(1)!
    state.epochs.set(2, {
      valid: true,
      record: { ...first.record, epoch: 2, chainBreak: true }
    })
    state.epochsAfter = 2
    const recipientIdentity = newIdentityKey()
    const recipientPuk = newPukKey()
    const userId = userIdOfGumbo(2)
    const request: ChatHistoryRequest = {
      id: '9007199254740993',
      conversationId: 'cnv_test',
      segmentStartEpoch: 1,
      targetEpoch: 1,
      coveredThroughEpoch: 0,
      userId,
      identityId: 'recipient',
      identityKey: b64(recipientIdentity.publicKey),
      pukGeneration: 1,
      pukPublicKey: b64(recipientPuk.publicKey),
      pukSignature: b64(
        signPuk(
          { userId, generation: 1, publicKey: recipientPuk.publicKey },
          recipientIdentity.secretKey
        )
      ),
      requiresApproval: false,
      canApprove: true,
      openedAt: '2026-10-01T00:00:00Z'
    }
    await ctx.keys.update(record => ({
      ...withEpochKey(record, 'cnv_test', 1, new Uint8Array(32).fill(7)),
      logs: { cnv_test: { ...genesisHead(), members: [ctx.userId, userId] } }
    }))
    ctx.client.chatLog = async () => []
    ctx.client.chatUserKeys = async () => ({
      userId,
      identity: {
        id: request.identityId,
        publicKey: request.identityKey,
        createdAt: request.openedAt
      },
      puk: {
        generation: 1,
        publicKey: request.pukPublicKey,
        signature: request.pukSignature
      }
    })
    ctx.client.chatEpochs = async (_id, _after, query) => ({
      latest: 2,
      needsRotation: false,
      noHolder: false,
      epochs: [],
      boxes: [],
      historyRecoveryVersion: 1,
      freshEpochsEnabled: false,
      ...(query == null ? {} : { nextBoxesCursor: '0', hasMoreBoxes: false })
    })
    const posted: ChatHistoryGrantBox[] = []
    ctx.client.chatHistoryGrants = async () => ({
      requests: posted.length > 0 ? [] : [request],
      nextCursor: null
    })
    ctx.client.postChatHistoryGrants = async boxes => {
      posted.push(...boxes)
      return {
        filled: 1,
        results: [
          { requestId: request.id, coveredThroughEpoch: 1, status: 'completed' }
        ]
      }
    }
    return { ...f, request, posted, recipientPuk }
  }
  it('supplies the actual historical key with the unchanged grant AAD and no implicit approval', async () => {
    const { ctx, request, posted, recipientPuk } = await grantFixture()
    expect(await fillHistoryGrants(ctx)).equals(1)
    expect(posted).length(1)
    expect(posted[0]).include({
      epoch: 1,
      targetEpoch: 1,
      approveHistory: false
    })
    expect(
      hpkeOpen(
        'grant',
        recipientPuk.secretKey,
        epochAad({
          conversationId: request.conversationId,
          epoch: 1,
          recipientUserId: request.userId,
          identityId: request.identityId,
          generation: 1
        }),
        unb64(posted[0].box)
      )
    ).deep.equals(new Uint8Array(32).fill(7))
    expect(ctx.memory.historyGrants).deep.equals([])
  })
  it('grants an available prefix without claiming the segment tip or dropping remaining work', async () => {
    const { ctx, state, request, posted } = await grantFixture()
    const first = state.epochs.get(1)!
    state.epochs.set(2, {
      valid: true,
      record: {
        ...first.record,
        epoch: 2,
        chainBreak: false,
        previousKeyBox: 'linked'
      }
    })
    state.epochs.set(3, {
      valid: true,
      record: { ...first.record, epoch: 3, chainBreak: true }
    })
    request.targetEpoch = 2
    ctx.client.postChatHistoryGrants = async boxes => {
      posted.push(...boxes)
      request.coveredThroughEpoch = 1
      return {
        filled: 0,
        results: [
          { requestId: request.id, coveredThroughEpoch: 1, status: 'partial' }
        ]
      }
    }
    let reads = 0
    ctx.client.chatHistoryGrants = async () => {
      reads++
      return { requests: [request], nextCursor: null }
    }
    expect(await fillHistoryGrants(ctx)).equals(0)
    expect(posted[0]).include({ epoch: 1, targetEpoch: 2 })
    expect(reads).equals(2)
    expect(ctx.memory.historyGrants[0].coveredThroughEpoch).equals(1)
    expect(heldHistoryEpoch(ctx, request)).equals(undefined)
  })

  it('reopens loaded placeholders without notifying them as newly arrived messages', async () => {
    const { ctx, state } = await grantFixture()
    state.synced = true
    state.envelopes.set(1, {
      id: 'cleared',
      conversationId: 'cnv_test',
      seq: 1,
      epoch: 1,
      senderUserId: ctx.userId,
      senderIdentityId: 'cid_test',
      kind: 'post',
      targetIds: null,
      nonce: '',
      ciphertext: '',
      signature: '',
      attachmentIds: [],
      clearedAt: '2026-10-01T00:00:00Z',
      createdAt: '2026-10-01T00:00:00Z'
    })
    state.opened.set('cleared', { status: 'lost' })
    const events: string[] = []
    ctx.memory.subscribe(event => events.push(event.type))
    await fillHistoryGrants(ctx)
    expect(state.opened.get('cleared')).deep.equals({ status: 'cleared' })
    expect(events).includes('conversation')
    expect(events).includes('conversations')
    expect(events).not.includes('messageAlert')
  })

  it('defers reset requests until explicit approval and reports a stale refusal', async () => {
    const { ctx, request, posted } = await grantFixture()
    request.requiresApproval = true
    ctx.memory.recoveryProbed = true
    ctx.memory.recoveryVersion = 1
    const original = ctx.client.chatEpochs
    let reads = 0
    ctx.client.chatEpochs = async (...args) => {
      reads++
      return await original(...args)
    }
    expect(await fillHistoryGrants(ctx)).equals(0)
    expect(posted).length(0)
    // A request waiting for approval costs no reads.
    expect(reads).equals(0)
    await approveHistoryGrant(ctx, request.id)
    expect(posted[0].approveHistory).equals(true)
    ctx.memory.historyGrants = [request]
    ctx.client.postChatHistoryGrants = async () => ({
      filled: 0,
      results: [
        { requestId: request.id, coveredThroughEpoch: 0, status: 'skipped' }
      ]
    })
    try {
      await approveHistoryGrant(ctx, request.id)
      expect.fail('stale approval succeeded')
    } catch (error) {
      expect((error as Error).message).contains('changed')
    }
  })
  it('reads each chat and recipient once a pass and batches its boxes', async () => {
    const { ctx, state, request } = await grantFixture()
    ctx.memory.recoveryProbed = true
    ctx.memory.recoveryVersion = 1
    const requests = Array.from(
      { length: HISTORY_GRANT_BATCH + 1 },
      (_, index) => ({ ...request, id: String(index + 1) })
    )
    // This device's own request, in a chat the pass does not otherwise read.
    requests.push({
      ...request,
      id: '9000',
      conversationId: 'cnv_mine',
      userId: ctx.userId,
      requiresApproval: true
    })
    // This device's own request, though it holds a key in its range, and
    // another member's range it holds no key in: neither is read to be filled.
    requests.push(
      { ...request, id: '9001', conversationId: 'cnv_own', userId: ctx.userId },
      { ...request, id: '9002', conversationId: 'cnv_unheld' }
    )
    await ctx.keys.update(record =>
      withEpochKey(
        withEpochKey(record, 'cnv_own', 1, new Uint8Array(32).fill(3)),
        'cnv_unheld',
        2,
        new Uint8Array(32).fill(3)
      )
    )
    ctx.client.chatHistoryGrants = async () => ({
      requests: batches.length > 0 ? [] : requests,
      nextCursor: null
    })
    const batches: number[] = []
    ctx.client.postChatHistoryGrants = async boxes => {
      batches.push(boxes.length)
      return {
        filled: boxes.length,
        results: boxes.map(box => ({
          requestId: box.requestId,
          coveredThroughEpoch: 1,
          status: 'completed' as const
        }))
      }
    }
    const original = ctx.client.chatEpochs
    const reads: string[] = []
    ctx.client.chatEpochs = async (id, ...rest) => {
      reads.push(id)
      return await original(id, ...rest)
    }
    let logs = 0
    ctx.client.chatLog = async () => {
      logs++
      return []
    }
    const userKeys = ctx.client.chatUserKeys
    let recipients = 0
    ctx.client.chatUserKeys = async userId => {
      recipients++
      return await userKeys(userId)
    }
    // Synced chats with placeholders are not read again unless this pass
    // changed them: no holder may ever supply their history.
    state.synced = true
    for (const [id, status] of [
      ['cnv_quiet', 'cleared'],
      ['cnv_locked', 'locked'],
      ['cnv_mine', 'locked'],
      ['cnv_own', 'locked'],
      ['cnv_unheld', 'locked']
    ] as const) {
      const other = newConversationState({ ...state.summary, id })
      other.synced = true
      other.opened.set('msg', { status })
      ctx.memory.conversations.set(id, other)
    }
    expect(await fillHistoryGrants(ctx)).equals(HISTORY_GRANT_BATCH + 1)
    expect(batches).deep.equals([HISTORY_GRANT_BATCH, 1])
    // Only the chats whose requests for this device changed are read again,
    // with their historical streams.
    await settle()
    expect(reads).deep.equals([
      'cnv_test',
      'cnv_mine',
      'cnv_mine',
      'cnv_own',
      'cnv_own'
    ])
    expect(logs).equals(1)
    // One recipient's keys are fetched once for all their requests.
    expect(recipients).equals(1)
  })
  it('posts a refused batch again a box at a time, so only the bad box fails', async () => {
    const { ctx, request } = await grantFixture()
    ctx.memory.recoveryProbed = true
    ctx.memory.recoveryVersion = 1
    const bad = { ...request, id: '2' }
    ctx.client.chatHistoryGrants = async () => ({
      requests: [request, bad],
      nextCursor: null
    })
    const calls: string[][] = []
    let refusal: Error = new HttpError('forbidden', 'Not a holder', {
      reason: 'notHolder'
    })
    ctx.client.postChatHistoryGrants = async boxes => {
      calls.push(boxes.map(box => box.requestId))
      if (boxes.some(box => box.requestId === bad.id)) throw refusal
      return {
        filled: 1,
        results: [
          { requestId: request.id, coveredThroughEpoch: 1, status: 'completed' }
        ]
      }
    }
    const errors: unknown[] = []
    ctx.memory.subscribe(event => {
      if (event.type === 'error') errors.push(event.error)
    })
    expect(await fillHistoryGrants(ctx)).equals(1)
    expect(calls).deep.equals([[request.id, bad.id], [request.id], [bad.id]])
    expect(errors).deep.equals([refusal])
    // A failure that is not a refusal of one box is not retried box by box.
    calls.length = 0
    errors.length = 0
    refusal = new Error('offline')
    expect(await fillHistoryGrants(ctx)).equals(0)
    expect(calls).deep.equals([[request.id, bad.id]])
    expect(errors).deep.equals([refusal])
  })
  it('never approves its own identity or an absent target', async () => {
    const { ctx, request } = await grantFixture()
    for (const target of [
      [],
      [{ ...request, userId: ctx.userId }],
      [{ ...request, canApprove: false }]
    ]) {
      ctx.memory.historyGrants = target
      try {
        await approveHistoryGrant(ctx, request.id)
        expect.fail('unauthorized approval')
      } catch (error) {
        expect((error as Error).message).contains('no historical request')
      }
    }
  })
  it('refuses invalid epochs, gaps, wrong ranges, and unavailable actual keys', async () => {
    const { ctx, state, request } = await grantFixture()
    expect(heldHistoryEpoch(ctx, request)).equals(1)
    expect(
      heldHistoryEpoch(ctx, { ...request, conversationId: 'missing' })
    ).equals(undefined)
    expect(heldHistoryEpoch(ctx, { ...request, targetEpoch: 2 })).equals(
      undefined
    )
    state.epochs.get(1)!.valid = false
    expect(heldHistoryEpoch(ctx, request)).equals(undefined)
    state.epochs.get(1)!.valid = true
    const first = state.epochs.get(1)!
    state.epochs.delete(1)
    expect(heldHistoryEpoch(ctx, request)).equals(undefined)
    state.epochs.set(1, first)
    await ctx.keys.update(record => ({ ...record, epochKeys: {} }))
    expect(await fillHistoryGrants(ctx)).equals(0)
    ctx.memory.historyGrants = [request]
    try {
      await approveHistoryGrant(ctx, request.id)
      expect.fail('no key')
    } catch (error) {
      expect((error as Error).message).contains('does not hold')
    }
  })
  it('isolates a broken membership log and forged recipient PUK from sending', async () => {
    const { ctx, state, request, posted } = await grantFixture()
    const errors: unknown[] = []
    ctx.memory.subscribe(event => {
      if (event.type === 'error') errors.push(event.error)
    })
    ctx.keys.record.logs.cnv_test.broken = true
    expect(await fillHistoryGrants(ctx)).equals(0)
    ctx.keys.record.logs.cnv_test.broken = false
    request.pukSignature = b64(new Uint8Array(64))
    expect(await fillHistoryGrants(ctx)).equals(0)
    expect(posted).length(0)
    expect(errors).length(2)
    // Another member's failed request leaves this device's history alone.
    expect(state.historyError).equals(false)
  })
  it('bounds discovery, rejects stalled cursors, and never probes unsupported servers', async () => {
    const { ctx, request } = await grantFixture()
    ctx.memory.recoveryProbed = true
    expect(await readHistoryGrants(ctx)).deep.equals([])
    ctx.memory.recoveryVersion = 1
    const seen: string[] = []
    ctx.client.chatHistoryGrants = async cursor => {
      seen.push(cursor ?? '0')
      return {
        requests: [request],
        nextCursor: seen.length === 1 ? request.id : null
      }
    }
    expect(await readHistoryGrants(ctx)).length(2)
    expect(seen).deep.equals(['0', request.id])
    ctx.client.chatHistoryGrants = async () => ({
      requests: [],
      nextCursor: '0'
    })
    try {
      await readHistoryGrants(ctx)
      expect.fail('stalled')
    } catch (error) {
      expect((error as Error).message).contains('Non-advancing')
    }
    expect(await fillHistoryGrants(ctx)).equals(0)
  })
  it('probes support past a chat the person left or whose read failed', async () => {
    const { ctx, state, request } = await grantFixture()
    ctx.memory.conversations.clear()
    const add = (id: string): void => {
      ctx.memory.conversations.set(
        id,
        id === 'cnv_test'
          ? state
          : newConversationState({ ...state.summary, id })
      )
    }
    for (const id of ['cnv_gone', 'cnv_flaky', 'cnv_test']) add(id)
    const original = ctx.client.chatEpochs
    const offline = new Error('offline')
    const reads: string[] = []
    let failing = new Set(['cnv_flaky'])
    ctx.client.chatEpochs = async (id, ...rest) => {
      reads.push(id)
      if (id === 'cnv_gone') throw new HttpError('notFound', 'Not found')
      if (failing.has(id)) throw offline
      return await original(id, ...rest)
    }
    expect(await readHistoryGrants(ctx)).deep.equals([request])
    expect(reads).deep.equals(['cnv_gone', 'cnv_flaky', 'cnv_test'])
    // Probed once, it is not probed again.
    reads.length = 0
    await readHistoryGrants(ctx)
    expect(reads).deep.equals([])
    // Every read failing: the first failure is reported, after a bounded try.
    ctx.memory.recoveryProbed = false
    failing = new Set(['cnv_flaky', 'cnv_test', 'cnv_down', 'cnv_last'])
    add('cnv_down')
    add('cnv_last')
    try {
      await readHistoryGrants(ctx)
      expect.fail('probe failure hidden')
    } catch (error) {
      expect(error).equals(offline)
    }
    expect(reads).deep.equals(['cnv_gone', 'cnv_flaky', 'cnv_test', 'cnv_down'])
    // Only chats the person left: nothing to probe, and nothing to report.
    ctx.memory.conversations.clear()
    ctx.memory.conversations.set('cnv_gone', state)
    ctx.memory.recoveryVersion = undefined
    expect(await readHistoryGrants(ctx)).deep.equals([])
  })
  it('continues historical grants when the current queue fails', async () => {
    const { ctx, posted } = await grantFixture()
    const failure = new Error('current queue unavailable')
    ctx.client.chatGrants = async () => {
      throw failure
    }
    try {
      await fillGrants(ctx)
      expect.fail('current queue failure must remain visible')
    } catch (error) {
      expect(error).equals(failure)
    }
    expect(posted).length(1)
  })
  it('refreshes the recovering conversation when its approval changes or disappears', async () => {
    const { ctx, request } = await grantFixture()
    ctx.memory.recoveryProbed = true
    ctx.memory.recoveryVersion = 1
    let requests = [{ ...request, userId: ctx.userId, requiresApproval: true }]
    ctx.client.chatHistoryGrants = async () => ({ requests, nextCursor: null })
    const changed: string[] = []
    ctx.memory.subscribe(event => {
      if (event.type === 'conversation') changed.push(event.conversationId)
    })
    await readHistoryGrants(ctx)
    expect(changed).deep.equals(['cnv_test'])
    changed.length = 0
    await readHistoryGrants(ctx)
    expect(changed).length(0)
    requests = [{ ...requests[0], requiresApproval: false }]
    await readHistoryGrants(ctx)
    expect(changed).deep.equals(['cnv_test'])
    changed.length = 0
    requests = []
    await readHistoryGrants(ctx)
    expect(changed).deep.equals(['cnv_test'])
    changed.length = 0
    requests = [{ ...request, requiresApproval: true }]
    await readHistoryGrants(ctx)
    expect(changed).length(0)
  })

  it('keeps partial recovery visible after a completed segment leaves discovery', async () => {
    const { ctx, state } = await grantFixture()
    const engine = new ChatEngine({
      client: ctx.client,
      userId: ctx.userId,
      device: { name: 'Unit device', platform: 'web' },
      store: {
        load: async () => ctx.keys.record,
        save: async () => {},
        exists: async () => true,
        wipe: async () => {}
      }
    })
    Object.assign(engine, { context: ctx, memory: ctx.memory })
    engine.status = 'ready'
    state.latest = 3
    state.historyRecoveryVersion = 1
    state.hasEarlier = true
    const second = state.epochs.get(2)!
    state.epochs.set(3, {
      valid: true,
      record: { ...second.record, epoch: 3 }
    })
    ctx.memory.historyGrants = []
    await ctx.keys.update(record =>
      withEpochKey(
        { ...record, epochKeys: {} },
        'cnv_test',
        3,
        new Uint8Array(32)
      )
    )
    expect(engine.view('cnv_test')!.historyRecovery).equals('waitingForHolder')
    await ctx.keys.update(record =>
      withEpochKey(record, 'cnv_test', 2, new Uint8Array(32))
    )
    expect(engine.view('cnv_test')).include({
      historyRecovery: 'partial',
      composer: 'enabled',
      sendReadiness: 'ready'
    })
    const third = state.epochs.get(3)!
    third.record.chainBreak = false
    expect(engine.view('cnv_test')!.historyRecovery).equals('waitingForHolder')
    third.record.chainBreak = true
    second.valid = false
    expect(engine.view('cnv_test')!.historyRecovery).equals('waitingForHolder')
    second.valid = true
    await ctx.keys.update(record =>
      withEpochKey(record, 'cnv_test', 1, new Uint8Array(32))
    )
    expect(engine.view('cnv_test')!.historyRecovery).equals('none')
    engine.stop()
  })

  it('projects independent history states and groups approvals around a locally held range', async () => {
    const { ctx, state, request } = await grantFixture()
    const engine = new ChatEngine({
      client: ctx.client,
      userId: ctx.userId,
      device: { name: 'Unit device', platform: 'web' },
      store: {
        load: async () => ctx.keys.record,
        save: async () => {},
        exists: async () => true,
        wipe: async () => {}
      }
    })
    // Seed the in-memory boundary; these projection tests do not enroll or use HTTP.
    Object.assign(engine, { context: ctx, memory: ctx.memory })
    engine.status = 'ready'
    state.latest = 2
    state.historyRecoveryVersion = 1
    state.freshEpochsEnabled = true
    state.hasEarlier = true
    await ctx.keys.update(record => ({ ...record, epochKeys: {} }))
    expect(engine.view('cnv_test')).include({
      composer: 'enabled',
      sendReadiness: 'canStartFresh',
      historyRecovery: 'waitingForHolder',
      earlierLost: false
    })
    ctx.memory.historyGrants = [
      { ...request, userId: ctx.userId, requiresApproval: true }
    ]
    expect(engine.view('cnv_test')!.historyRecovery).equals('awaitingApproval')
    ctx.memory.historyGrants[0].requiresApproval = false
    ctx.memory.historyGrants[0].coveredThroughEpoch = 1
    expect(engine.view('cnv_test')!.historyRecovery).equals('partial')
    state.historyError = true
    expect(engine.view('cnv_test')!.historyRecovery).equals('retryableError')
    state.historyError = false
    state.hasEarlier = false
    expect(engine.view('cnv_test')!.historyRecovery).equals('none')
    ctx.memory.historyGrants = [
      { ...request, requiresApproval: true, id: '1', targetEpoch: 9 },
      { ...request, requiresApproval: true, id: '2' },
      { ...request, requiresApproval: false, id: '3' },
      { ...request, requiresApproval: true, canApprove: false, id: '4' },
      { ...request, requiresApproval: true, userId: ctx.userId, id: '5' }
    ]
    expect(engine.approvals()).length(1)
    expect(engine.approvals()[0]).include({
      requestId: 'history:1',
      canApprove: false
    })
    await ctx.keys.update(record =>
      withEpochKey(record, 'cnv_test', 1, new Uint8Array(32).fill(7))
    )
    expect(engine.approvals()[0]).include({
      requestId: 'history:2',
      canApprove: true
    })
    const post = ctx.client.postChatHistoryGrants
    ctx.client.postChatHistoryGrants = async boxes => ({
      ...(await post(boxes)),
      results: boxes.map(box => ({
        requestId: box.requestId,
        coveredThroughEpoch: box.epoch,
        status: 'completed' as const
      }))
    })
    await engine.approve('history:2')
    expect(engine.approvals()).length(0)
    try {
      await engine.approve('2')
      expect.fail('ambiguous approval')
    } catch (error) {
      expect((error as Error).message).contains('Unknown approval')
    }
    engine.stop()
  })
  it('merges a reset member’s current and older history into one approval', async () => {
    const { ctx, state, request, posted } = await grantFixture()
    const engine = new ChatEngine({
      client: ctx.client,
      userId: ctx.userId,
      device: { name: 'Unit device', platform: 'web' },
      store: {
        load: async () => ctx.keys.record,
        save: async () => {},
        exists: async () => true,
        wipe: async () => {}
      }
    })
    Object.assign(engine, { context: ctx, memory: ctx.memory })
    engine.status = 'ready'
    ctx.memory.recoveryProbed = true
    ctx.memory.recoveryVersion = 1
    state.latest = 2
    // The reset opened a legacy request for the current segment (epoch 2)
    // and a historical one for the closed segment (epoch 1).
    const reset: ChatGrantRequest = {
      id: 7,
      conversationId: 'cnv_test',
      epoch: 2,
      userId: request.userId,
      identityId: request.identityId,
      identityKey: request.identityKey,
      pukGeneration: 1,
      pukPublicKey: request.pukPublicKey,
      pukSignature: request.pukSignature,
      identityReset: true,
      canApprove: true,
      openedAt: request.openedAt
    }
    const current: ChatGrantBox[] = []
    let open = [reset]
    let historical = [{ ...request, requiresApproval: true }]
    ctx.client.chatGrants = async () => open
    ctx.client.postChatGrants = async boxes => {
      current.push(...boxes)
      open = []
      // Approving the reset approves its history access on the server.
      historical = historical.map(r => ({ ...r, requiresApproval: false }))
      return { filled: boxes.length, skipped: [] }
    }
    ctx.client.chatHistoryGrants = async () => ({
      requests: posted.length > 0 ? [] : historical,
      nextCursor: null
    })
    ctx.memory.grants = open
    ctx.memory.historyGrants = historical
    const seen = engine.approvals()
    expect(seen).length(1)
    expect(seen[0]).include({
      requestId: 7,
      history: true,
      userId: reset.userId
    })
    // This device holds the older segment's key, though not the current one.
    expect(seen[0].canApprove).equals(true)

    // A device that cannot verify the membership record approves nothing.
    ctx.keys.record.logs.cnv_test.broken = true
    try {
      await engine.approve(7)
      expect.fail('approved against a broken record')
    } catch (error) {
      expect((error as ChatEngineError).code).equals('unverified')
    }
    ctx.keys.record.logs.cnv_test.broken = false
    expect(current).length(0)
    expect(posted).length(0)

    // Holding the current key: both segments in one approval.
    await ctx.keys.update(record =>
      withEpochKey(record, 'cnv_test', 2, new Uint8Array(32).fill(8))
    )
    // The chat rotated since the list was read: the server skips the box,
    // and nothing, older history included, counts as approved.
    const accept = ctx.client.postChatGrants
    ctx.client.postChatGrants = async boxes => ({
      filled: 0,
      skipped: boxes.map(box => ({
        conversationId: box.conversationId,
        userId: box.userId,
        identityId: box.identityId,
        pukGeneration: box.pukGeneration,
        reason: 'staleEpoch' as const
      }))
    })
    try {
      await engine.approve(7)
      expect.fail('reported a skipped approval as done')
    } catch (error) {
      expect((error as ChatEngineError).code).equals('target')
    }
    expect(posted).length(0)
    ctx.client.postChatGrants = accept
    await engine.approve(7)
    expect(current.map(box => box.epoch)).deep.equals([2])
    expect(posted.map(box => [box.epoch, box.approveHistory])).deep.equals([
      [1, false]
    ])
    expect(engine.approvals()).length(0)

    // Holding only the older key, from a card still showing the historical
    // request: that range is approved and supplied.
    current.length = 0
    posted.length = 0
    open = [reset]
    historical = [{ ...request, requiresApproval: true }]
    ctx.memory.grants = open
    ctx.memory.historyGrants = historical
    await ctx.keys.update(record => ({
      ...withEpochKey(
        { ...record, epochKeys: {} },
        'cnv_test',
        1,
        new Uint8Array(32).fill(7)
      )
    }))
    await engine.approve(`history:${request.id}`)
    expect(current).length(0)
    expect(posted.map(box => [box.epoch, box.approveHistory])).deep.equals([
      [1, true]
    ])
    // The current segment still waits for a device holding its key.
    expect(engine.approvals().map(card => card.requestId)).deep.equals([7])
    expect(engine.approvals()[0].history).equals(undefined)
    engine.stop()
  })
  it('offers an approval only through a key this device holds, and says so when one arrives', async () => {
    const { ctx, state, request, identityKeys } = await grantFixture()
    const engine = new ChatEngine({
      client: ctx.client,
      userId: ctx.userId,
      device: { name: 'Unit device', platform: 'web' },
      store: {
        load: async () => ctx.keys.record,
        save: async () => {},
        exists: async () => true,
        wipe: async () => {}
      }
    })
    Object.assign(engine, { context: ctx, memory: ctx.memory })
    engine.status = 'ready'
    ctx.memory.recoveryProbed = true
    ctx.memory.recoveryVersion = 1
    const store = {
      load: async () => ctx.keys.record,
      save: async () => {},
      wipe: async () => {},
      exists: async () => true
    }
    const hooks = (
      engine as unknown as {
        contextHooks: () => Pick<EngineContext, 'approvalsMayChange'>
      }
    ).contextHooks()
    ctx.approvalsMayChange = hooks.approvalsMayChange
    ctx.keys = new KeyHolder(
      store,
      ctx.keys.record,
      () => true,
      () => {
        hooks.approvalsMayChange?.()
      }
    )
    const events: string[] = []
    engine.subscribe(event => {
      events.push(event.type)
    })
    const key = new Uint8Array(32).fill(9)
    ctx.memory.grants = []
    ctx.memory.historyGrants = []

    // Nothing waits for approval: a saved key wakes no screen.
    await ctx.keys.update(record => withEpochKey(record, 'cnv_test', 5, key))
    expect(events).deep.equals([])

    // A reset's request for the current segment: only its epoch key grants it.
    const reset: ChatGrantRequest = {
      id: 7,
      conversationId: 'cnv_test',
      epoch: 3,
      userId: request.userId,
      identityId: request.identityId,
      identityKey: request.identityKey,
      pukGeneration: 1,
      pukPublicKey: request.pukPublicKey,
      pukSignature: request.pukSignature,
      identityReset: true,
      canApprove: true,
      openedAt: request.openedAt
    }
    ctx.memory.grants = [reset]
    expect(engine.approvals()[0]).include({ requestId: 7, canApprove: false })
    await ctx.keys.update(record => withEpochKey(record, 'cnv_test', 3, key))
    expect(events).deep.equals(['approvals'])
    expect(engine.approvals()[0]).include({ requestId: 7, canApprove: true })
    // An update that changes nothing is not news.
    await ctx.keys.update(record => record)
    expect(events).length(1)

    // A reset with older history: either key grants it.
    ctx.memory.grants = [{ ...reset, epoch: 4 }]
    ctx.memory.historyGrants = [{ ...request, requiresApproval: true }]
    expect(engine.approvals()).length(1)
    expect(engine.approvals()[0]).include({
      requestId: 7,
      history: true,
      canApprove: true
    })
    await ctx.keys.update(record => ({ ...record, epochKeys: {} }))
    expect(engine.approvals()[0]).include({ requestId: 7, canApprove: false })
    await ctx.keys.update(record => withEpochKey(record, 'cnv_test', 4, key))
    expect(engine.approvals()[0]).include({ requestId: 7, canApprove: true })

    // A historical request alone: the older key, inside epochs that check out.
    ctx.memory.grants = []
    await ctx.keys.update(record =>
      withEpochKey(record, 'cnv_test', 1, new Uint8Array(32).fill(7))
    )
    const first = {
      ...state.epochs.get(1)!.record,
      signature: b64(
        signEpoch(
          { conversationId: 'cnv_test', epoch: 1, previousKeyBox: null },
          identityKeys.secretKey
        )
      )
    }
    state.epochs.delete(1)
    expect(engine.approvals()[0]).include({
      requestId: `history:${request.id}`,
      canApprove: false
    })
    events.length = 0
    await takeEpochs(ctx, 'cnv_test', state, [first])
    expect(events).deep.equals(['approvals'])
    expect(engine.approvals()[0]).include({
      requestId: `history:${request.id}`,
      canApprove: true
    })
    // An empty read takes nothing, and says nothing; nor does a key that
    // changes nothing this device can grant.
    await takeEpochs(ctx, 'cnv_test', state, [])
    await ctx.keys.update(record => withEpochKey(record, 'cnv_test', 6, key))
    await takeEpochs(ctx, 'cnv_test', state, [first])
    expect(events).length(1)

    // Epochs read with the chat, and from its historical stream, both tell
    // when they make an approval grantable.
    ctx.client.chatEpochs = async (_id, _after, query) => ({
      latest: 2,
      needsRotation: false,
      noHolder: false,
      epochs: [first],
      boxes: [],
      historyRecoveryVersion: 1,
      freshEpochsEnabled: false,
      ...(query == null ? {} : { nextBoxesCursor: '0', hasMoreBoxes: false })
    })
    for (const read of [syncEpochs, syncHistoryBoxes]) {
      state.epochs.delete(1)
      engine.approvals()
      events.length = 0
      await read(ctx, 'cnv_test')
      expect(events).includes('approvals')
      expect(engine.approvals()[0]).include({ canApprove: true })
    }

    // A record taken from elsewhere (enrolment, a PUK sync) tells too, when
    // it changes what this device holds.
    await ctx.keys.update(record => ({ ...record, epochKeys: {} }))
    engine.approvals()
    events.length = 0
    const held = ctx.keys.record
    await ctx.keys.replace(async () =>
      withEpochKey(held, 'cnv_test', 1, new Uint8Array(32).fill(7))
    )
    expect(events).deep.equals(['approvals'])

    // A request whose identity does not check out fails neither a key save
    // nor an epoch read, and says nothing.
    ctx.memory.grants = [{ ...reset, identityKey: '%%%' }]
    expect(() => engine.approvals()).throws()
    events.length = 0
    await ctx.keys.update(record => withEpochKey(record, 'cnv_test', 7, key))
    await takeEpochs(ctx, 'cnv_test', state, [first])
    expect(events).deep.equals([])
    ctx.memory.grants = []

    // While the device links or resets, a replaced record says nothing and
    // never fails, however many segments a reset asks for.
    ctx.memory.historyGrants = [
      { ...request, requiresApproval: true },
      { ...request, id: '9007199254740995', requiresApproval: true }
    ]
    events.length = 0
    for (const status of ['link', 'reset'] as const) {
      engine.status = status
      await ctx.keys.replace(async () => ctx.keys.record)
      await takeEpochs(ctx, 'cnv_test', state, [first])
    }
    expect(events).deep.equals([])
    engine.status = 'ready'
    engine.stop()
  })

  it('tells of a key record only once it is saved', async () => {
    const record = newRecord(userIdOfGumbo(1), 'cdv_test', newDeviceKeys())
    const seen: unknown[] = []
    const failing = new KeyHolder(
      {
        load: async () => record,
        save: async () => {
          throw new Error('disk full')
        },
        wipe: async () => {},
        exists: async () => true
      },
      record,
      () => true,
      next => seen.push(next)
    )
    try {
      await failing.update(start => ({ ...start, epochKeys: { cnv_x: {} } }))
      expect.fail('saved')
    } catch (error) {
      expect((error as Error).message).equals('disk full')
    }
    await failing.update(start => start)
    expect(seen).deep.equals([])
    const holder = new KeyHolder(
      {
        load: async () => record,
        save: async () => {},
        wipe: async () => {},
        exists: async () => true
      },
      record
    )
    const next = await holder.update(start => ({
      ...start,
      epochKeys: { cnv_x: {} }
    }))
    expect(holder.record).equals(next)
  })

  it('shows recovering only while delivered keys open, behind its own failure', async () => {
    const { ctx, state } = await grantFixture()
    const engine = new ChatEngine({
      client: ctx.client,
      userId: ctx.userId,
      device: { name: 'Unit device', platform: 'web' },
      store: {
        load: async () => ctx.keys.record,
        save: async () => {},
        exists: async () => true,
        wipe: async () => {}
      }
    })
    Object.assign(engine, { context: ctx, memory: ctx.memory })
    engine.status = 'ready'
    state.latest = 2
    state.historyRecoveryVersion = 1
    state.hasEarlier = true
    await ctx.keys.update(record => ({ ...record, epochKeys: {} }))
    expect(engine.view('cnv_test')!.historyRecovery).equals('waitingForHolder')
    const seen: string[] = []
    ctx.memory.subscribe(event => {
      if (event.type === 'conversation')
        seen.push(engine.view(event.conversationId)!.historyRecovery!)
    })
    // A read that finds nothing does not show recovering.
    await syncHistoryBoxes(ctx, 'cnv_test')
    expect(seen).not.include('recovering')
    const record = ctx.keys.record
    const original = ctx.client.chatEpochs
    let release: () => void = () => {}
    const held = new Promise<void>(resolve => {
      release = resolve
    })
    ctx.client.chatEpochs = async (id, after, query) => ({
      ...(await original(id, after, query)),
      ...(query == null
        ? {}
        : {
            nextBoxesCursor: '1',
            boxes: [
              {
                epoch: 1,
                identityId: record.identity!.id,
                pukGeneration: 1,
                grantedByUserId: userIdOfGumbo(2),
                box: b64(
                  hpkeSeal(
                    'grant',
                    record.puks[0].keys.publicKey,
                    epochAad({
                      conversationId: 'cnv_test',
                      epoch: 1,
                      recipientUserId: ctx.userId,
                      identityId: record.identity!.id,
                      generation: 1
                    }),
                    new Uint8Array(32).fill(9)
                  )
                )
              }
            ]
          })
    })
    // Hold the delivered key before it is stored.
    const keys = ctx.keys.update.bind(ctx.keys)
    ctx.keys.update = async change => {
      await held
      return await keys(change)
    }
    seen.length = 0
    const stream = syncHistoryBoxes(ctx, 'cnv_test')
    await settle()
    expect(seen).deep.equals(['recovering'])
    expect(engine.view('cnv_test')!.historyRecovery).equals('recovering')
    state.historyError = true
    expect(engine.view('cnv_test')!.historyRecovery).equals('retryableError')
    state.historyError = false
    release()
    await stream
    expect(seen.at(-1)).not.equals('recovering')
    expect(engine.view('cnv_test')!.historyRecovery).not.equals('recovering')
    engine.stop()
  })
  it('keeps pre-boundary messages recoverable and never reopens cleared ciphertext', async () => {
    const { ctx, state } = await grantFixture()
    await ctx.keys.update(record => ({ ...record, epochKeys: {} }))
    const envelope: ChatMessage = {
      id: 'msg_locked',
      seq: 1,
      conversationId: 'cnv_test',
      epoch: 1,
      senderUserId: ctx.userId,
      senderIdentityId: 'cid_test',
      kind: 'post',
      targetIds: null,
      nonce: '',
      signature: '',
      attachmentIds: [],
      createdAt: '2026-10-01T00:00:00Z',
      ciphertext: 'unopened',
      clearedAt: null
    }
    expect(await openEnvelope(ctx, state, envelope)).deep.equals({
      status: 'lost'
    })
    state.historyRecoveryVersion = 1
    expect(await openEnvelope(ctx, state, envelope)).deep.equals({
      status: 'locked'
    })
    expect(
      await openEnvelope(ctx, state, { ...envelope, ciphertext: '' })
    ).deep.equals({ status: 'cleared' })
  })
  it('repairs existing server-box ownership before any fresh publication', async () => {
    const { ctx, state } = await grantFixture()
    const original = ctx.client.chatEpochs
    // A box this device cannot open: the server still says it holds the key.
    ctx.client.chatEpochs = async (...args) => ({
      ...(await original(...args)),
      boxes: [
        {
          epoch: 2,
          identityId: ctx.keys.record.identity!.id,
          pukGeneration: 1,
          box: b64(new Uint8Array(80)),
          grantedByUserId: null
        }
      ]
    })
    let refreshes = 0
    let publications = 0
    ctx.refreshKeys = async () => {
      refreshes++
    }
    ctx.client.postChatEpoch = async () => {
      publications++
      throw new Error('must not rotate')
    }
    try {
      await epochForSend(ctx, 'cnv_test')
      expect.fail('missing local keys')
    } catch (error) {
      expect((error as Error).message).contains('repaired')
    }
    expect(refreshes).equals(1)
    expect(publications).equals(0)
    ctx.refreshKeys = async () => {
      await ctx.keys.update(record =>
        withEpochKey(record, 'cnv_test', 2, new Uint8Array(32).fill(8))
      )
    }
    expect(await epochForSend(ctx, 'cnv_test')).equals(2)
    expect(publications).equals(0)
    expect(state.latest).equals(2)
  })
  it('starts fresh encryption after an identity reset in the same engine', async () => {
    const { ctx, state, request } = await grantFixture()
    const engine = new ChatEngine({
      client: ctx.client,
      userId: ctx.userId,
      device: { name: 'Unit device', platform: 'web' },
      store: {
        load: async () => ctx.keys.record,
        save: async () => {},
        exists: async () => true,
        wipe: async () => {}
      }
    })
    Object.assign(engine, { context: ctx, memory: ctx.memory })
    engine.status = 'ready'
    const original = ctx.client.chatEpochs
    let latest = 2
    let boxes = [
      {
        epoch: 2,
        identityId: ctx.keys.record.identity!.id,
        pukGeneration: 1,
        box: b64(new Uint8Array(80)),
        grantedByUserId: null
      }
    ]
    ctx.client.chatEpochs = async (...args) => ({
      ...(await original(...args)),
      latest,
      freshEpochsEnabled: true,
      boxes
    })
    await syncEpochs(ctx, 'cnv_test')
    expect(engine.view('cnv_test')!.sendReadiness).equals('repairRequired')
    // The reset drops every key; the server stops serving the old identity's box.
    await ctx.keys.replace(async () => ({
      ...ctx.keys.record,
      identity: { id: 'cid_reset', keys: newIdentityKey() },
      puks: [{ generation: 1, keys: newPukKey() }],
      epochKeys: {}
    }))
    boxes = []
    ctx.client.chatMembers = async () => [
      {
        userId: request.userId,
        shortName: 'Peer',
        avatarUrl: null,
        label: '',
        affiliations: '',
        isModerator: false,
        isApprover: true,
        eligible: false,
        hasIdentity: true,
        identityKey: request.identityKey,
        generation: 1
      }
    ]
    ctx.client.postChatEpoch = async (_id, body) => {
      expect(body).include({ mode: 'fresh', epoch: 3 })
      latest = 3
      return { epoch: 3, chainBreak: true, boxed: 1, grantRequests: 0 }
    }
    expect(await epochForSend(ctx, 'cnv_test')).equals(3)
    expect(state.latestHasServerBox).equals(false)
    expect(engine.view('cnv_test')!.sendReadiness).equals('ready')
    engine.stop()
  })
  it('publishes fresh encryption for verified current recipients without rewriting old keys', async () => {
    const { ctx, request } = await grantFixture()
    const original = ctx.client.chatEpochs
    let latest = 2
    ctx.client.chatEpochs = async (...args) => ({
      ...(await original(...args)),
      latest,
      freshEpochsEnabled: true
    })
    ctx.client.chatMembers = async () => [
      {
        userId: request.userId,
        shortName: 'Peer',
        avatarUrl: null,
        label: '',
        affiliations: '',
        isModerator: false,
        isApprover: true,
        eligible: false,
        hasIdentity: true,
        identityKey: request.identityKey,
        generation: 1
      }
    ]
    const old = ctx.keys.record.epochKeys.cnv_test['1']
    ctx.client.postChatEpoch = async (id, body) => {
      expect(id).equals('cnv_test')
      expect(body).include({ mode: 'fresh', epoch: 3, previousKeyBox: null })
      expect(body.boxes.map(box => box.userId)).deep.equals([request.userId])
      latest = 3
      return { epoch: 3, chainBreak: true, boxed: 1, grantRequests: 0 }
    }
    expect(await epochForSend(ctx, 'cnv_test')).equals(3)
    expect(ctx.keys.record.epochKeys.cnv_test['1']).equals(old)
    expect(ctx.keys.record.epochKeys.cnv_test['3']).not.equals(undefined)
  })
  it('refuses fresh sending when disabled or read-only without calling publication', async () => {
    const { ctx, state } = await grantFixture()
    let published = false
    ctx.client.postChatEpoch = async () => {
      published = true
      throw new Error('unexpected')
    }
    for (const [canPost, reason] of [
      [true, 'disabled'],
      [false, 'read-only']
    ] as const) {
      state.summary.canPost = canPost
      try {
        await epochForSend(ctx, 'cnv_test')
        expect.fail('send should be restricted')
      } catch (error) {
        expect((error as Error).message).contains(reason)
      }
    }
    expect(published).equals(false)
  })
})
