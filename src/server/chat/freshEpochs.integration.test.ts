import { expect } from 'chai'
import { after, before, describe, it } from 'mocha'

import { newEpochKey } from '../../common/chatCrypto/keys'
import { ChatDevices, ok, refused, type TestKeys } from './chatTestDevices'
import { type ChatFixture, openChatFixture } from './chatTestFixture'

describe('fresh epochs preserve independent historical approval', function () {
  this.timeout(120000)
  let f: ChatFixture
  let d: ChatDevices
  let enabled = true
  let id: string
  let reset: Awaited<ReturnType<ChatDevices['reset']>>
  let holder: TestKeys
  let original: unknown
  let body: ReturnType<ChatDevices['epochBody']> & { mode: 'fresh' }
  const oldKey = newEpochKey()
  const freshKey = newEpochKey()
  before(async () => {
    const opened = await openChatFixture('fresh_epochs', {
      freshEpochsEnabled: () => enabled
    })
    if (opened == null) throw new Error('PostgreSQL 18 is required')
    f = opened
    d = new ChatDevices(f)
    holder = (await d.enrol('Ha')).keys
    await d.enrol('Hc')
    id = ok(await f.call('Ha', 'GET', '/chat/conversations')).find(
      (c: { title: string }) => c.title === 'Hawks Staff'
    ).id
    ok(
      await f.call(
        'Ha',
        'POST',
        `/chat/conversations/${id}/epochs`,
        d.epochBody({
          conversationId: id,
          epoch: 1,
          creator: holder,
          epochKey: oldKey,
          previousEpochKey: null,
          recipients: await d.recipients('Ha', id, 'eligible')
        })
      ),
      201
    )
    original = ok(await f.call('Ha', 'GET', `/chat/conversations/${id}/epochs`))
      .epochs[0]
    reset = await d.reset('Hc')
    body = {
      ...d.epochBody({
        conversationId: id,
        epoch: 2,
        creator: reset.keys,
        epochKey: freshKey,
        previousEpochKey: null,
        recipients: await d.recipients(reset.device.who, id, 'hasIdentity')
      }),
      mode: 'fresh'
    }
  })
  after(async () => {
    await f?.close()
  })
  const post = async (
    payload: unknown,
    who = reset.device.who
  ): ReturnType<ChatFixture['call']> =>
    await f.call(who, 'POST', `/chat/conversations/${id}/epochs`, payload)
  it('rejects a disabled fresh publication without changing the epoch', async () => {
    enabled = false
    refused(await post(body), 409, 'freshDisabled')
    enabled = true
  })
  it('preserves the old missing-key refusal for an omitted mode', async () => {
    const { mode: _, ...legacy } = body
    refused(await post(legacy), 403, 'notHolder')
  })
  it('requires an exact set of current recipients, valid signature and boundary', async () => {
    refused(await post({ ...body, boxes: body.boxes.slice(1) }), 400, 'boxSet')
    refused(
      await post({ ...body, boxes: [...body.boxes, body.boxes[0]] }),
      400,
      'boxSet'
    )
    refused(
      await post({
        ...body,
        boxes: body.boxes.map(b => ({ ...b, pukGeneration: 99 }))
      }),
      400,
      'boxSet'
    )
    refused(
      await post({
        ...body,
        signature: Buffer.alloc(64).toString('base64url')
      }),
      400,
      'badSignature'
    )
    refused(await post({ ...body, epoch: 4 }), 400, 'epochGap')
    refused(
      await post({
        ...body,
        previousKeyBox: Buffer.alloc(80).toString('base64url')
      }),
      403,
      'notHolder'
    )
    expect((await post({ ...body, mode: 'unknown' })).status).equals(400)
  })
  it('rejects a latest-key holder making an unnecessary break', async () => {
    const asHolder = {
      ...d.epochBody({
        conversationId: id,
        epoch: 2,
        creator: holder,
        epochKey: freshKey,
        previousEpochKey: null,
        recipients: await d.recipients('Ha', id, 'hasIdentity')
      }),
      mode: 'fresh'
    }
    refused(await post(asHolder, 'Ha'), 409, 'repairRequired')
  })
  it('elects one concurrent fresh publication and keeps history approval pending', async () => {
    const answers = await Promise.all([post(body), post(body)])
    expect(answers.map(a => a.status).sort((a, b) => a - b)).deep.equals([
      201, 409
    ])
    const winner = answers.find(a => a.status === 201)!
    expect(winner.body.chainBreak).equals(true)
    const view = ok(
      await f.call(reset.device.who, 'GET', `/chat/conversations/${id}/epochs`)
    )
    expect(view.epochs[0]).deep.equals(original)
    expect(view.epochs[1].previousKeyBox).equals(null)
    expect(view.boxes.map((b: { epoch: number }) => b.epoch)).deep.equals([2])
    const keys = await d.openEpochKeys(reset.device.who, reset.keys, id)
    expect(keys.has(1)).equals(false)
    expect(Buffer.from(keys.get(2)!)).deep.equals(Buffer.from(freshKey))
    const retained = await d.openEpochKeys('Ha', holder, id)
    expect(Buffer.from(retained.get(1)!)).deep.equals(Buffer.from(oldKey))
    expect(retained.has(2)).equals(true)
    const access = await f.db
      .selectFrom('chat_history_access')
      .selectAll()
      .where('conversation_id', '=', id)
      .where('identity_id', '=', reset.keys.identityId)
      .executeTakeFirstOrThrow()
    expect(access.requires_approval).equals(true)
    expect(access.approved_at).equals(null)
    const members = ok(
      await f.call('Ha', 'GET', `/chat/conversations/${id}/members`)
    )
    expect(
      members.find((m: { userId: string }) => m.userId === f.id('Hc')).eligible
    ).equals(true)
  })
  it('keeps reset recipients in subsequent legacy chained rotations without approving history', async () => {
    enabled = false
    const next = d.epochBody({
      conversationId: id,
      epoch: 3,
      creator: holder,
      epochKey: newEpochKey(),
      previousEpochKey: freshKey,
      recipients: await d.recipients('Ha', id, 'eligible')
    })
    ok(await post(next, 'Ha'), 201)
    const access = await f.db
      .selectFrom('chat_history_access')
      .select('requires_approval')
      .where('conversation_id', '=', id)
      .where('identity_id', '=', reset.keys.identityId)
      .executeTakeFirstOrThrow()
    expect(access.requires_approval).equals(true)
    expect(
      (await d.openEpochKeys(reset.device.who, reset.keys, id)).has(3)
    ).equals(true)
  })
  it('refuses unlinked devices, outsiders, closed chats and announcement readers', async () => {
    enabled = true
    const unlinked = await d.session('Ha')
    await d.register(unlinked)
    refused(await post({ ...body, epoch: 4 }, unlinked), 403, 'notHolder')
    await d.enrol('Ec')
    expect((await post({ ...body, epoch: 4 }, 'Ec')).status).equals(404)
    await f.db
      .updateTable('chat_conversations')
      .set({ closed_at: f.now })
      .where('id', '=', id)
      .execute()
    refused(await post({ ...body, epoch: 4 }), 409, 'closed')
    const staff = (await d.enrol('S')).keys
    await d.enrol('A')
    const announcements = ok(
      await f.call('S', 'GET', '/chat/conversations')
    ).find((c: { kind: string }) => c.kind === 'seasonAnnouncements').id
    ok(
      await f.call(
        'S',
        'POST',
        `/chat/conversations/${announcements}/epochs`,
        d.epochBody({
          conversationId: announcements,
          epoch: 1,
          creator: staff,
          epochKey: newEpochKey(),
          previousEpochKey: null,
          recipients: await d.recipients('S', announcements, 'eligible')
        })
      ),
      201
    )
    const reader = await d.reset('A')
    const publication = {
      ...d.epochBody({
        conversationId: announcements,
        epoch: 2,
        creator: reader.keys,
        epochKey: newEpochKey(),
        previousEpochKey: null,
        recipients: await d.recipients(
          reader.device.who,
          announcements,
          'hasIdentity'
        )
      }),
      mode: 'fresh'
    }
    refused(
      await f.call(
        reader.device.who,
        'POST',
        `/chat/conversations/${announcements}/epochs`,
        publication
      ),
      403,
      'notStaff'
    )
  })
})
