import { expect } from 'chai'
import { describe, it } from 'mocha'

import {
  type ChatHistoryGrantBox,
  type ChatHistoryRequest,
  type ChatIdentity,
  type ChatMessage,
  TeamStationClient
} from '../../../common/api'
import { signPuk } from '../../../common/chatCrypto/chain'
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
import { userIdOfGumbo } from '../../../common/userId'
import { b64, newRecord, unb64, withEpochKey } from '../keyRecord'
import { type EngineContext, KeyHolder } from './context'
import { IdentityCache, openEnvelope, openEpochKeys } from './decrypt'
import { ChatEngine } from './engine'
import { fillGrants } from './grants'
import {
  approveHistoryGrant,
  fillHistoryGrants,
  heldHistoryEpoch,
  readHistoryGrants
} from './historyRecovery'
import { genesisHead } from './log'
import { epochForSend } from './rotate'
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
    expect(await fillHistoryGrants(ctx)).equals(0)
    expect(posted).length(0)
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
    const { ctx, request, posted } = await grantFixture()
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
    state.latest = 2
    state.latestHasServerBox = true
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
