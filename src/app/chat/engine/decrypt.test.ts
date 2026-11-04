import { expect } from 'chai'
import { describe, it } from 'mocha'

import {
  type ChatIdentity,
  type ChatMessage,
  TeamStationClient
} from '../../../common/api'
import {
  ChatCryptoUnavailable,
  type CoreCall
} from '../../../common/chatCrypto/coreCall'
import { epochAad, hpkeSeal } from '../../../common/chatCrypto/hpke'
import {
  newDeviceKeys,
  newIdentityKey,
  newPukKey
} from '../../../common/chatCrypto/keys'
import { sealMessage } from '../../../common/chatCrypto/seal'
import { userIdOfGumbo } from '../../../common/userId'
import { b64, newRecord, withEpochKey } from '../keyRecord'
import { type EngineContext, KeyHolder } from './context'
import { IdentityCache, openEpochKeys } from './decrypt'
import {
  ChatMemory,
  type ConversationState,
  newConversationState
} from './store'
import { openPending, syncEpochs } from './sync'

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
    expect(cursors).deep.equals([undefined, '0'])
    expect(state.boxesCursor).equals('9007199254740993')
    expect(state.epochsAfter).equals(1)
    await syncEpochs(ctx, 'cnv_test')
    expect(cursors.slice(2)).deep.equals([undefined, '9007199254740993'])
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
    expect(state.latest).equals(1)
    expect(state.freshEpochsEnabled).equals(true)
    expect(state.historyError).equals(true)
    expect(state.boxesCursor).equals('0')
    fail = false
    await syncEpochs(ctx, 'cnv_test')
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
    expect(state.boxesCursor).equals('0')
    expect(ctx.keys.record.epochKeys.cnv_test).equals(undefined)
    fail = false
    await syncEpochs(ctx, 'cnv_test')
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
    expect(state.boxesCursor).equals('0')
    expect(state.historyError).equals(true)
    ctx.client.chatEpochs = async (id, after, query) => ({
      ...(await original(id, after, query)),
      nextBoxesCursor: '0',
      hasMoreBoxes: query != null
    })
    await syncEpochs(ctx, 'cnv_test')
    expect(state.historyError).equals(true)
    expect(state.boxesCursor).equals('0')
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
