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
import {
  newDeviceKeys,
  newIdentityKey,
  newPukKey
} from '../../../common/chatCrypto/keys'
import { sealMessage } from '../../../common/chatCrypto/seal'
import { b64, newRecord, withEpochKey } from '../keyRecord'
import { type EngineContext, KeyHolder } from './context'
import { IdentityCache, openEpochKeys } from './decrypt'
import {
  ChatMemory,
  type ConversationState,
  newConversationState
} from './store'
import { openPending } from './sync'

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
  const record = newRecord(1, 'cdv_test', newDeviceKeys())
  record.identity = { id: 'cid_test', keys: identityKeys }
  record.puks = [{ generation: 1, keys: newPukKey() }]
  const state = newConversationState({
    id: 'cnv_test',
    kind: 'dm',
    title: null,
    scope: null,
    scopeName: null,
    lastSeq: 1,
    lastMessageAt: null,
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
      createdByUserId: 1,
      identityId: 'cid_test',
      previousKeyBox: null,
      chainBreak: false,
      signature: '',
      createdAt: '2027-04-10T12:00:00Z'
    }
  })
  const identity: ChatIdentity = {
    id: 'cid_test',
    userId: 1,
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
    userId: 1,
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
      senderUserId: 1,
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
      senderUserId: 1,
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
