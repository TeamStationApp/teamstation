import { expect } from 'chai'
import { after, before, describe, it } from 'mocha'

import type { ChatHistoryRequest } from '../../common/api'
import { newEpochKey } from '../../common/chatCrypto/keys'
import { ChatDevices, ok, refused, type TestKeys } from './chatTestDevices'
import { type ChatFixture, openChatFixture } from './chatTestFixture'
import { lockConversation } from './epochs'
import { joinMembers, leaveMembers } from './membershipLog'

/** Real routes and ciphertext: an earlier holder cannot supply a later key. */
describe('historical segment grants', function () {
  this.timeout(120000)
  let f: ChatFixture, d: ChatDevices, id: string
  let prefix: TestKeys,
    tip: TestKeys,
    recipient: Awaited<ReturnType<ChatDevices['reset']>>
  let enabled = true
  const key1 = newEpochKey()
  const key2 = newEpochKey()
  const key3 = newEpochKey()
  let request: ChatHistoryRequest
  before(async () => {
    const opened = await openChatFixture('history_recovery', {
      freshEpochsEnabled: () => enabled
    })
    if (opened == null) throw new Error('PostgreSQL 18 is required')
    f = opened
    d = new ChatDevices(f)
    prefix = (await d.enrol('Ha')).keys
    tip = (await d.enrol('Hc')).keys
    await d.enrol('Hk')
    id = ok(await f.call('Ha', 'GET', '/chat/conversations')).find(
      (c: { title: string }) => c.title === 'Hawks Staff'
    ).id
    async function epoch(
      who: string,
      creator: TestKeys,
      n: number,
      key: Uint8Array,
      previous: Uint8Array | null,
      fresh = false
    ): Promise<void> {
      ok(
        await f.call(who, 'POST', `/chat/conversations/${id}/epochs`, {
          ...d.epochBody({
            conversationId: id,
            epoch: n,
            creator,
            epochKey: key,
            previousEpochKey: previous,
            recipients: await d.recipients(
              who,
              id,
              fresh ? 'hasIdentity' : 'eligible'
            )
          }),
          ...(fresh ? { mode: 'fresh' } : {})
        }),
        201
      )
    }
    await epoch('Ha', prefix, 1, key1, null)
    await f.db.transaction().execute(async trx => {
      await lockConversation(trx, id)
      await leaveMembers(trx, id, [f.id('Ha')], null, 'fixture', f.now)
    })
    await epoch('Hc', tip, 2, key2, key1)
    recipient = await d.reset('Hk')
    await epoch(recipient.device.who, recipient.keys, 3, key3, null, true)
    await f.db.transaction().execute(async trx => {
      await lockConversation(trx, id)
      await joinMembers(trx, id, [f.id('Ha')], null, 'fixture', f.now)
    })
    const list = ok(await f.call('Ha', 'GET', '/chat/grants?scope=history'))
    request = list.requests.find(
      (r: ChatHistoryRequest) => r.identityId === recipient.keys.identityId
    )
    expect(request).not.equals(undefined)
  })
  after(async () => {
    await f?.close()
  })
  async function grant(
    epoch: number,
    key: Uint8Array,
    approveHistory = false
  ): Promise<object> {
    const target = (await d.recipients('Ha', id, 'hasIdentity')).find(
      r => r.identityId === recipient.keys.identityId
    )!
    return {
      requestId: request.id,
      conversationId: id,
      targetEpoch: request.targetEpoch,
      epoch,
      userId: target.userId,
      identityId: target.identityId,
      pukGeneration: target.generation,
      approveHistory,
      box: d.box('grant', id, epoch, target, key)
    }
  }
  const post = async (
    who: string,
    boxes: object[]
  ): ReturnType<ChatFixture['call']> =>
    await f.call(who, 'POST', '/chat/grants?scope=history', { boxes })
  it('finds a stable goal and isolates historical requests from legacy grants', async () => {
    expect(request.segmentStartEpoch).equals(1)
    expect(request.targetEpoch).equals(2)
    expect(request.coveredThroughEpoch).equals(0)
    expect(request.requiresApproval).equals(true)
    expect(request.canApprove).equals(true)
    const legacy = ok(await f.call('Ha', 'GET', '/chat/grants'))
    expect(Array.isArray(legacy)).equals(true)
    expect(
      legacy.some(
        (r: { identityId: string }) =>
          r.identityId === recipient.keys.identityId
      )
    ).equals(false)
    const first = ok(
      await f.call('Ha', 'GET', '/chat/grants?scope=history&limit=1')
    )
    expect(first.requests.length).equals(1)
    if (first.nextCursor != null) {
      const next = ok(
        await f.call(
          'Ha',
          'GET',
          `/chat/grants?scope=history&limit=1&cursor=${first.nextCursor}`
        )
      )
      expect(
        next.requests.every(
          (r: ChatHistoryRequest) => BigInt(r.id) > BigInt(first.requests[0].id)
        )
      ).equals(true)
    }
  })
  it('rejects automatic reset grants and mismatched request bindings atomically', async () => {
    refused(await post('Ha', [await grant(1, key1)]), 403, 'notApprover')
    refused(
      await post('Ha', [{ ...(await grant(1, key1, true)), targetEpoch: 3 }]),
      400,
      'historyTarget'
    )
    refused(
      await post('Ha', [{ ...(await grant(1, key1, true)), epoch: 3 }]),
      400,
      'historyTarget'
    )
    refused(await post('Ha', [await grant(2, key2, true)]), 403, 'notHolder')
    const valid = await grant(1, key1, true)
    refused(
      await post('Ha', [valid, { ...valid, targetEpoch: 99 }]),
      400,
      'historyTarget'
    )
    const access = await f.db
      .selectFrom('chat_history_access')
      .select('requires_approval')
      .where('conversation_id', '=', id)
      .where('identity_id', '=', recipient.keys.identityId)
      .executeTakeFirstOrThrow()
    expect(access.requires_approval).equals(true)
    expect(
      (await d.openEpochKeys(recipient.device.who, recipient.keys, id)).has(1)
    ).equals(false)
  })
  it('grants only the held prefix, records approval, and leaves the suffix pending', async () => {
    const result = ok(await post('Ha', [await grant(1, key1, true)]))
    expect(result.filled).equals(0)
    expect(result.results).deep.equals([
      { requestId: request.id, coveredThroughEpoch: 1, status: 'partial' }
    ])
    const keys = await d.openEpochKeys(recipient.device.who, recipient.keys, id)
    expect(Buffer.from(keys.get(1)!)).deep.equals(Buffer.from(key1))
    expect(keys.has(2)).equals(false)
    expect(keys.has(3)).equals(true)
    const rows = ok(
      await f.call('Hc', 'GET', '/chat/grants?scope=history')
    ).requests
    const pending = rows.find((r: ChatHistoryRequest) => r.id === request.id)
    expect(pending.targetEpoch).equals(2)
    expect(pending.coveredThroughEpoch).equals(1)
    expect(pending.requiresApproval).equals(false)
    expect(
      ok(await post('Ha', [await grant(1, key1)])).results[0].status
    ).equals('alreadyCovered')
  })
  it('delivers an old box behind the epoch cursor and survives disabling fresh publication', async () => {
    enabled = false
    let cursor = '0'
    const epochs: number[] = []
    for (let n = 0; n < 10; n++) {
      const page = ok(
        await f.call(
          recipient.device.who,
          'GET',
          `/chat/conversations/${id}/epochs?after=3&boxesAfter=${cursor}&boxLimit=1`
        )
      )
      expect(page.historyRecoveryVersion).equals(1)
      expect(page.freshEpochsEnabled).equals(false)
      expect(page.epochs).deep.equals([])
      epochs.push(...page.boxes.map((b: { epoch: number }) => b.epoch))
      expect(BigInt(page.nextBoxesCursor) >= BigInt(cursor)).equals(true)
      cursor = page.nextBoxesCursor
      if (page.hasMoreBoxes !== true) break
    }
    expect(epochs).deep.equals([3, 1])
    const empty = ok(
      await f.call(
        recipient.device.who,
        'GET',
        `/chat/conversations/${id}/epochs?after=3&boxesAfter=${cursor}`
      )
    )
    expect(empty.boxes).deep.equals([])
    expect(empty.nextBoxesCursor).equals(cursor)
    const legacy = ok(
      await f.call(
        recipient.device.who,
        'GET',
        `/chat/conversations/${id}/epochs?after=3`
      )
    )
    expect(legacy.boxes.map((b: { epoch: number }) => b.epoch)).deep.equals([3])
  })
  it('accepts a returning tip holder without duplicate approval and resolves concurrent replays', async () => {
    const box = await grant(2, key2)
    const results = await Promise.all([post('Hc', [box]), post('Hc', [box])])
    expect(results.every(r => r.status === 200)).equals(true)
    expect(results.reduce((n, r) => n + r.body.filled, 0)).equals(1)
    expect(
      results
        .map(r => String(r.body.results[0].status))
        .sort((a, b) => a.localeCompare(b))
    ).deep.equals(['alreadyCovered', 'completed'])
    const keys = await d.openEpochKeys(recipient.device.who, recipient.keys, id)
    expect(Buffer.from(keys.get(2)!)).deep.equals(Buffer.from(key2))
    const epochs = ok(
      await f.call('Ha', 'GET', `/chat/conversations/${id}/epochs`)
    ).epochs
    expect(epochs[2].previousKeyBox).equals(null)
    expect(
      ok(await f.call('Ha', 'GET', '/chat/grants?scope=history')).requests.some(
        (r: ChatHistoryRequest) => r.id === request.id
      )
    ).equals(false)
  })
  it('validates query scopes, cursor precision and bounded batches', async () => {
    for (const path of [
      '/chat/grants?scope=bad',
      '/chat/grants?cursor=0',
      '/chat/grants?scope=history&limit=101',
      `/chat/conversations/${id}/epochs?boxLimit=2`,
      `/chat/conversations/${id}/epochs?boxesAfter=-1`
    ])
      expect((await f.call('Ha', 'GET', path)).status).equals(400)
    expect((await post('Ha', [])).status).equals(400)
    expect(
      (await post('Ha', Array(101).fill(await grant(1, key1)))).status
    ).equals(400)
    const page = ok(
      await f.call(
        'Ha',
        'GET',
        `/chat/conversations/${id}/epochs?boxesAfter=9007199254740993`
      )
    )
    expect(page.nextBoxesCursor).equals('9007199254740993')
  })
  it('reissues fixed targets on PUK rotation, revokes reset approval and skips departed recipients', async () => {
    recipient = await d.reset('Hk')
    let requests = ok(
      await f.call('Ha', 'GET', '/chat/grants?scope=history')
    ).requests
    request = requests.find(
      (r: ChatHistoryRequest) => r.identityId === recipient.keys.identityId
    )
    expect(request.requiresApproval).equals(true)
    const stale = await grant(1, key1, true)
    const oldRequest = request.id
    await d.nextPuk(recipient.keys, recipient.device, [recipient.device])
    requests = ok(
      await f.call('Ha', 'GET', '/chat/grants?scope=history')
    ).requests
    request = requests.find(
      (r: ChatHistoryRequest) => r.identityId === recipient.keys.identityId
    )
    expect(request.id).not.equals(oldRequest)
    expect(request.targetEpoch).equals(2)
    expect(request.pukGeneration).equals(2)
    expect(request.requiresApproval).equals(true)
    expect(ok(await post('Ha', [stale])).results[0].status).equals('skipped')
    await f.db
      .updateTable('chat_conversations')
      .set({ closed_at: f.now })
      .where('id', '=', id)
      .execute()
    expect(
      ok(await post('Ha', [await grant(1, key1, true)])).results[0].status
    ).equals('partial')
    const pending = await grant(2, key2)
    await f.db.transaction().execute(async trx => {
      await lockConversation(trx, id)
      await leaveMembers(trx, id, [f.id('Hk')], null, 'fixture', f.now)
    })
    expect(ok(await post('Hc', [pending])).results[0].status).equals('skipped')
    expect(
      (
        await f.call(
          recipient.device.who,
          'GET',
          `/chat/conversations/${id}/epochs?boxesAfter=0`
        )
      ).status
    ).equals(404)
  })
})
