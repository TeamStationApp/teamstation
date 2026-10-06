import { expect } from 'chai'
import type { Kysely } from 'kysely'
import { after, before, beforeEach, describe, it } from 'mocha'
import { Client } from 'pg'

import { equalBytes } from '../../common/chatCrypto/bytes'
import {
  openPreviousEpochKey,
  verifyEpoch
} from '../../common/chatCrypto/chain'
import { newEpochKey, newPukKey } from '../../common/chatCrypto/keys'
import { newIdentityId } from '../../common/chatCrypto/messageIds'
import {
  b64,
  ChatDevices,
  ok,
  type Recipient,
  refused,
  type TestDevice,
  type TestKeys,
  unb64
} from '../chat/chatTestDevices'
import { type ChatFixture, openChatFixture } from '../chat/chatTestFixture'
import type { Database } from '../db/database'

/**
 * U7 through the routes, with the real crypto of `common/chatCrypto` on the
 * device side: epochs (first writer wins, the box set, who may make one,
 * chain breaks) and history grants (filling, batches, the approval rule for
 * reset identities).
 */

describe('chat epochs and grants (U7)', function () {
  this.timeout(120000)
  let fixture: ChatFixture
  let db: Kysely<Database>
  let devices: ChatDevices
  let listener: Client
  let notes: unknown[] = []

  before(async function () {
    const opened = await openChatFixture('epochs')
    if (opened == null) {
      this.skip()
      return
    }
    fixture = opened
    db = fixture.db
    devices = new ChatDevices(fixture)
    listener = new Client({ connectionString: fixture.url })
    await listener.connect()
    listener.on('notification', message => {
      notes.push(JSON.parse(message.payload ?? 'null'))
    })
    await listener.query('listen chat_changes')
  })

  after(async function () {
    await listener?.end()
    await fixture?.close()
  })

  beforeEach(function () {
    notes = []
  })

  const call = async (
    who: string,
    method: string,
    path: string,
    body?: unknown
  ): ReturnType<ChatFixture['call']> =>
    await fixture.call(who, method, path, body)

  async function settle(): Promise<void> {
    await listener.query('select 1')
    await new Promise(resolve => setTimeout(resolve, 50))
  }

  async function chatId(who: string, title: string): Promise<string> {
    const list = ok(await call(who, 'GET', '/chat/conversations')) as Array<{
      id: string
      title: string | null
    }>
    const chat = list.find(item => item.title === title)
    if (chat == null) throw new Error(`${who} has no ${title}`)
    return chat.id
  }

  async function listed(
    who: string,
    conversationId: string
  ): Promise<{ locked: boolean; noHolder: boolean }> {
    const list = ok(await call(who, 'GET', '/chat/conversations')) as Array<{
      id: string
      locked: boolean
      noHolder: boolean
    }>
    const chat = list.find(item => item.id === conversationId)
    if (chat == null) throw new Error(`${who} is not in ${conversationId}`)
    return { locked: chat.locked, noHolder: chat.noHolder }
  }

  async function needsRotation(conversationId: string): Promise<boolean> {
    const row = await db
      .selectFrom('chat_conversations')
      .select(['needs_rotation'])
      .where('id', '=', conversationId)
      .executeTakeFirstOrThrow()
    return row.needs_rotation
  }

  async function memberRow(
    who: string,
    conversationId: string,
    userId: number
  ): Promise<{ eligible: boolean; hasIdentity: boolean }> {
    const members = ok(
      await call(who, 'GET', `/chat/conversations/${conversationId}/members`)
    ) as Array<{ userId: number; eligible: boolean; hasIdentity: boolean }>
    const member = members.find(row => row.userId === userId)
    if (member == null) throw new Error(`${userId} is not a member`)
    return member
  }

  async function openRequests(
    conversationId: string
  ): Promise<Array<{ userId: number; reset: boolean; generation: number }>> {
    const rows = await db
      .selectFrom('chat_grant_requests')
      .select(['user_id', 'identity_reset', 'generation'])
      .where('conversation_id', '=', conversationId)
      .where('filled_at', 'is', null)
      .where('superseded_at', 'is', null)
      .orderBy('user_id')
      .execute()
    return rows.map(row => ({
      userId: row.user_id,
      reset: row.identity_reset,
      generation: row.generation
    }))
  }

  /** A grant request as `GET /chat/grants` lists it to `who`. */
  async function grantRequest(
    who: string,
    conversationId: string,
    userId: number
  ): Promise<any> {
    const requests = ok(await call(who, 'GET', '/chat/grants')) as Array<{
      conversationId: string
      userId: number
    }>
    return requests.find(
      row => row.conversationId === conversationId && row.userId === userId
    )
  }

  /** The `POST /chat/grants` box that fills a listed request. */
  function grantFor(request: any, epochKey: Uint8Array): unknown {
    const recipient: Recipient = {
      userId: request.userId,
      identityId: request.identityId,
      generation: request.pukGeneration,
      publicKey: unb64(request.pukPublicKey)
    }
    return {
      conversationId: request.conversationId,
      epoch: request.epoch,
      userId: request.userId,
      identityId: request.identityId,
      pukGeneration: request.pukGeneration,
      box: devices.box(
        'grant',
        request.conversationId,
        request.epoch,
        recipient,
        epochKey
      )
    }
  }

  // Hawks Staff is Ha, Hc, Hk and Hs; Hs enrols only after epoch 1.
  const held: Record<string, { device: TestDevice; keys: TestKeys }> = {}
  let staff: string
  const staffKeys: Uint8Array[] = []

  describe('epochs', function () {
    it('makes epoch 1 from any eligible member, boxed to exactly the eligible members', async function () {
      for (const key of ['Ha', 'Hc', 'Hk']) held[key] = await devices.enrol(key)
      staff = await chatId('Hk', 'Hawks Staff')
      expect(
        ok(await call('Hk', 'GET', `/chat/conversations/${staff}/epochs`))
      ).deep.equals({
        latest: 0,
        needsRotation: false,
        noHolder: false,
        epochs: [],
        boxes: []
      })
      const eligible = await devices.recipients('Hk', staff, 'eligible')
      expect(eligible.map(row => fixture.keyOf(row.userId)).sort()).deep.equals(
        ['Ha', 'Hc', 'Hk']
      )
      const key = newEpochKey()
      const body = (recipients: Recipient[], epoch = 1): unknown =>
        devices.epochBody({
          conversationId: staff,
          epoch,
          creator: held.Hk.keys,
          epochKey: key,
          previousEpochKey: null,
          recipients
        })
      const post = async (payload: unknown): ReturnType<typeof call> =>
        await call('Hk', 'POST', `/chat/conversations/${staff}/epochs`, payload)

      // Missing an eligible member; a non-member; a member with no identity;
      // a name twice; a stale generation.
      const ha = eligible.find(row => row.userId === fixture.id('Ha'))
      if (ha == null) throw new Error('no Ha')
      refused(
        await post(body(eligible.filter(row => row !== ha))),
        400,
        'boxSet'
      )
      held.F = await devices.enrol('F')
      const fan: Recipient = {
        userId: held.F.keys.userId,
        identityId: held.F.keys.identityId,
        generation: 1,
        publicKey: held.F.keys.puks[0].publicKey
      }
      refused(await post(body([...eligible, fan])), 400, 'boxSet')
      const nobody: Recipient = {
        userId: fixture.id('Hs'),
        identityId: newIdentityId(),
        generation: 1,
        publicKey: newPukKey().publicKey
      }
      refused(await post(body([...eligible, nobody])), 400, 'boxSet')
      refused(await post(body([...eligible, ha])), 400, 'boxSet')
      refused(
        await post(
          body(
            eligible.map(row => (row === ha ? { ...row, generation: 2 } : row))
          )
        ),
        400,
        'boxSet'
      )

      // Epoch 1 carries no previous key, and no epoch may be skipped.
      const withPrevious = devices.epochBody({
        conversationId: staff,
        epoch: 1,
        creator: held.Hk.keys,
        epochKey: key,
        previousEpochKey: newEpochKey(),
        recipients: eligible
      })
      refused(await post(withPrevious), 400, 'previousKeyBox')
      refused(await post(body(eligible, 2)), 400, 'epochGap')
      const forged = devices.epochBody({
        conversationId: staff,
        epoch: 1,
        creator: held.Hc.keys,
        epochKey: key,
        previousEpochKey: null,
        recipients: eligible
      })
      refused(await post(forged), 400, 'badSignature')
      expect(
        (await post({ ...(body(eligible) as object), boxes: 'x' })).status
      ).equals(400)

      // Hk, a scorekeeper and no moderator, makes it.
      const made = ok(await post(body(eligible)), 201)
      expect(made).deep.equals({
        epoch: 1,
        chainBreak: false,
        boxed: 3,
        grantRequests: 0
      })
      staffKeys[1] = key
      await settle()
      expect(notes).deep.include({ c: staff, k: 'epoch' })
      refused(await post(body(eligible)), 409, 'epochTaken')

      // Each member's box opens to the key; the record verifies.
      for (const who of ['Ha', 'Hc', 'Hk']) {
        const keys = await devices.openEpochKeys(who, held[who].keys, staff)
        expect([...keys.keys()]).deep.equals([1])
        expect(equalBytes(keys.get(1)!, key)).equals(true)
      }
      const read = ok(
        await call('Ha', 'GET', `/chat/conversations/${staff}/epochs`)
      )
      expect(read).to.include({
        latest: 1,
        needsRotation: false,
        noHolder: false
      })
      expect(read.epochs).to.have.length(1)
      expect(read.epochs[0]).to.include({
        epoch: 1,
        createdByUserId: held.Hk.keys.userId,
        identityId: held.Hk.keys.identityId,
        previousKeyBox: null,
        chainBreak: false
      })
      expect(
        verifyEpoch(
          { conversationId: staff, epoch: 1, previousKeyBox: null },
          unb64(read.epochs[0].signature),
          held.Hk.keys.identity.publicKey
        )
      ).equals(true)
      expect(
        ok(
          await call('Ha', 'GET', `/chat/conversations/${staff}/epochs?after=1`)
        ).epochs
      ).deep.equals([])

      // Hs, with no identity, is locked out; Ha is not.
      expect(await listed('Hs', staff)).deep.equals({
        locked: true,
        noHolder: false
      })
      expect(await listed('Ha', staff)).deep.equals({
        locked: false,
        noHolder: false
      })
      const hs = ok(
        await call('Hs', 'GET', `/chat/conversations/${staff}/epochs`)
      )
      expect(hs.boxes).deep.equals([])
    })

    it('answers 404 to a non-member, and needs a session', async function () {
      expect(
        (await call('F', 'GET', `/chat/conversations/${staff}/epochs`)).status
      ).equals(404)
      expect(
        (
          await call('F', 'POST', `/chat/conversations/${staff}/epochs`, {
            epoch: 2
          })
        ).status
      ).equals(404)
      expect(
        (await call('nobody', 'GET', `/chat/conversations/${staff}/epochs`))
          .status
      ).equals(401)
      await fixture.apiToken('Hk-token', 'Hk')
      refused(
        await call('Hk-token', 'GET', `/chat/conversations/${staff}/epochs`),
        403,
        'sessionRequired'
      )
      refused(
        await call('Hk-token', 'GET', '/chat/grants'),
        403,
        'sessionRequired'
      )
    })
  })

  describe('grants', function () {
    it('fills a request from a member who enrols later, and hints them', async function () {
      held.Hs = await devices.enrol('Hs')
      const request = await grantRequest('Hk', staff, held.Hs.keys.userId)
      expect(request).to.include({
        conversationId: staff,
        epoch: 1,
        identityId: held.Hs.keys.identityId,
        identityKey: b64(held.Hs.keys.identity.publicKey),
        pukGeneration: 1,
        pukPublicKey: b64(held.Hs.keys.puks[0].publicKey),
        identityReset: false,
        canApprove: true
      })

      // Hs holds nothing yet; a stranger to the chat is not heard.
      refused(
        await call('Hs', 'POST', '/chat/grants', {
          boxes: [grantFor(request, staffKeys[1])]
        }),
        403,
        'notHolder'
      )
      expect(
        (
          await call('F', 'POST', '/chat/grants', {
            boxes: [grantFor(request, staffKeys[1])]
          })
        ).status
      ).equals(404)

      notes = []
      expect(
        ok(
          await call('Hk', 'POST', '/chat/grants', {
            boxes: [grantFor(request, staffKeys[1])]
          })
        )
      ).deep.equals({ filled: 1, skipped: [] })
      await settle()
      expect(notes).deep.include({ c: staff, k: 'grant' })
      const opened = await devices.openEpochKeys('Hs', held.Hs.keys, staff)
      expect(equalBytes(opened.get(1)!, staffKeys[1])).equals(true)
      const boxes = ok(
        await call('Hs', 'GET', `/chat/conversations/${staff}/epochs?after=1`)
      ).boxes
      expect(boxes).to.have.length(1)
      expect(boxes[0]).to.include({
        epoch: 1,
        grantedByUserId: held.Hk.keys.userId
      })
      expect(await grantRequest('Hk', staff, held.Hs.keys.userId)).equals(
        undefined
      )
      expect(await openRequests(staff)).deep.equals([])
      expect(await listed('Hs', staff)).deep.equals({
        locked: false,
        noHolder: false
      })

      // Again: the request is closed, so the box is skipped.
      expect(
        ok(
          await call('Hk', 'POST', '/chat/grants', {
            boxes: [grantFor(request, staffKeys[1])]
          })
        )
      ).deep.equals({
        filled: 0,
        skipped: [
          {
            conversationId: staff,
            userId: held.Hs.keys.userId,
            identityId: held.Hs.keys.identityId,
            pukGeneration: 1,
            reason: 'notOpen'
          }
        ]
      })
    })

    it('takes at most 500 boxes in a batch', async function () {
      const one = {
        conversationId: staff,
        epoch: 1,
        userId: held.Hs.keys.userId,
        identityId: held.Hs.keys.identityId,
        pukGeneration: 1,
        box: b64(new Uint8Array(80))
      }
      const full = ok(
        await call('Hk', 'POST', '/chat/grants', {
          boxes: Array.from({ length: 500 }, () => one)
        })
      )
      expect(full.filled).equals(0)
      expect(full.skipped).to.have.length(500)
      expect(
        (
          await call('Hk', 'POST', '/chat/grants', {
            boxes: Array.from({ length: 501 }, () => one)
          })
        ).status
      ).equals(400)
      expect(
        (await call('Hk', 'POST', '/chat/grants', { boxes: [] })).status
      ).equals(400)
      expect(
        (
          await call('Hk', 'POST', '/chat/grants', {
            boxes: [{ ...one, identityId: 'nope' }]
          })
        ).status
      ).equals(400)
      expect(
        (
          await call('Hk', 'POST', '/chat/grants', {
            boxes: [{ ...one, conversationId: '' }]
          })
        ).status
      ).equals(400)
    })

    it('lists nothing to somebody in no chat', async function () {
      expect(ok(await call('R', 'GET', '/chat/grants'))).deep.equals([])
    })
  })

  describe('who may make the next epoch', function () {
    it('needs a holder of epoch n with its key, on a linked device; a linked-in device is one', async function () {
      // Ha's next PUK generation flags rotation; Ha's box stays at generation 1.
      await devices.nextPuk(held.Ha.keys, held.Ha.device, [held.Ha.device])
      expect(await needsRotation(staff)).equals(true)
      const old = ok(
        await call('Ha', 'GET', `/chat/conversations/${staff}/epochs`)
      )
      expect(old.boxes.map((box: any) => box.pukGeneration)).deep.equals([1])
      expect(await openRequests(staff)).deep.equals([
        { userId: held.Ha.keys.userId, reset: false, generation: 2 }
      ])
      const eligible = await devices.recipients('Ha', staff, 'eligible')
      expect(
        eligible.find(row => row.userId === held.Ha.keys.userId)?.generation
      ).equals(2)
      const key = newEpochKey()
      const next = (creator: TestKeys, previous: Uint8Array | null): unknown =>
        devices.epochBody({
          conversationId: staff,
          epoch: 2,
          creator,
          epochKey: key,
          previousEpochKey: previous,
          recipients: eligible
        })

      // While anybody holds epoch 1, an epoch without the previous key is
      // refused, holder or not.
      refused(
        await call(
          'Hc',
          'POST',
          `/chat/conversations/${staff}/epochs`,
          next(held.Hc.keys, null)
        ),
        403,
        'notHolder'
      )

      // A session with a pending device, with none, or with a revoked one.
      const pending = await devices.session('Hc')
      await devices.register(pending)
      const bare = await devices.session('Hc')
      const second = await devices.link('Hc', held.Hc.keys, held.Hc.device)
      await db
        .updateTable('chat_devices')
        .set({ revoked_at: new Date() })
        .where('id', '=', second.id)
        .execute()
      for (const who of [pending, bare, second.who]) {
        refused(
          await call(
            who,
            'POST',
            `/chat/conversations/${staff}/epochs`,
            next(held.Hc.keys, staffKeys[1])
          ),
          403,
          'notHolder'
        )
        const request = {
          conversationId: staff,
          epoch: 1,
          userId: held.Ha.keys.userId,
          identityId: held.Ha.keys.identityId,
          pukGeneration: 2,
          pukPublicKey: b64(held.Ha.keys.puks[1].publicKey)
        }
        refused(
          await call(who, 'POST', '/chat/grants', {
            boxes: [grantFor(request, staffKeys[1])]
          }),
          403,
          'notHolder'
        )
      }

      // Ha's device linked in from the first one makes epoch 2.
      const linkedIn = await devices.link('Ha', held.Ha.keys, held.Ha.device)
      notes = []
      expect(
        ok(
          await call(
            linkedIn.who,
            'POST',
            `/chat/conversations/${staff}/epochs`,
            next(held.Ha.keys, staffKeys[1])
          ),
          201
        )
      ).deep.equals({ epoch: 2, chainBreak: false, boxed: 4, grantRequests: 0 })
      staffKeys[2] = key
      await settle()
      expect(notes).deep.include({ c: staff, k: 'epoch' })
      // It clears the rotation flag and fills Ha's request at generation 2.
      expect(await needsRotation(staff)).equals(false)
      expect(await openRequests(staff)).deep.equals([])
      const opened = await devices.openEpochKeys('Ha', held.Ha.keys, staff)
      expect(equalBytes(opened.get(2)!, key)).equals(true)
      const read = ok(
        await call('Hs', 'GET', `/chat/conversations/${staff}/epochs?after=1`)
      )
      expect(read.epochs.map((epoch: any) => epoch.epoch)).deep.equals([2])
      expect(
        equalBytes(
          openPreviousEpochKey({
            conversationId: staff,
            epoch: 2,
            epochKey: key,
            previousKeyBox: unb64(read.epochs[0].previousKeyBox)
          }),
          staffKeys[1]
        )
      ).equals(true)
    })

    it('lets the first of two concurrent epoch n+1 posts win', async function () {
      const eligible = await devices.recipients('Hc', staff, 'eligible')
      const body = (creator: TestKeys, key: Uint8Array): unknown =>
        devices.epochBody({
          conversationId: staff,
          epoch: 3,
          creator,
          epochKey: key,
          previousEpochKey: staffKeys[2],
          recipients: eligible
        })
      const keys = { Hc: newEpochKey(), Hk: newEpochKey() }
      const answers = await Promise.all([
        call(
          'Hc',
          'POST',
          `/chat/conversations/${staff}/epochs`,
          body(held.Hc.keys, keys.Hc)
        ),
        call(
          'Hk',
          'POST',
          `/chat/conversations/${staff}/epochs`,
          body(held.Hk.keys, keys.Hk)
        )
      ])
      expect(
        answers.map(answer => answer.status).sort((x, y) => x - y)
      ).deep.equals([201, 409])
      const lost = answers.find(answer => answer.status === 409)
      expect(lost?.body.details.reason).equals('epochTaken')
      const winner = answers[0].status === 201 ? 'Hc' : 'Hk'
      staffKeys[3] = keys[winner]
      const opened = await devices.openEpochKeys('Hs', held.Hs.keys, staff, 3)
      expect(equalBytes(opened.get(3)!, staffKeys[3])).equals(true)
      const epochs = await db
        .selectFrom('chat_epochs')
        .select(['epoch'])
        .where('conversation_id', '=', staff)
        .execute()
      expect(epochs).to.have.length(3)

      // A grant for an older epoch is skipped as stale.
      expect(
        ok(
          await call('Hk', 'POST', '/chat/grants', {
            boxes: [
              {
                conversationId: staff,
                epoch: 2,
                userId: held.Hs.keys.userId,
                identityId: held.Hs.keys.identityId,
                pukGeneration: 1,
                box: b64(new Uint8Array(80))
              }
            ]
          })
        ).skipped[0].reason
      ).equals('staleEpoch')
    })

    it('refuses epoch n+1 from a member with no box for epoch n', async function () {
      const members = await chatId('Hs', 'Hawks Members')
      const eligible = await devices.recipients('Hs', members, 'eligible')
      const first = newEpochKey()
      ok(
        await call(
          'Hs',
          'POST',
          `/chat/conversations/${members}/epochs`,
          devices.epochBody({
            conversationId: members,
            epoch: 1,
            creator: held.Hs.keys,
            epochKey: first,
            previousEpochKey: null,
            recipients: eligible
          })
        ),
        201
      )
      held.A = await devices.enrol('A')
      const all = await devices.recipients('A', members, 'eligible')
      for (const previous of [newEpochKey(), null]) {
        refused(
          await call(
            'A',
            'POST',
            `/chat/conversations/${members}/epochs`,
            devices.epochBody({
              conversationId: members,
              epoch: 2,
              creator: held.A.keys,
              epochKey: newEpochKey(),
              previousEpochKey: previous,
              recipients: all
            })
          ),
          403,
          'notHolder'
        )
      }
    })
  })

  describe('reset identities', function () {
    it('boxes a reset identity only through another approver’s grant', async function () {
      const members = await chatId('Hs', 'Hawks Members')
      const firstKey = (
        await devices.openEpochKeys('Hs', held.Hs.keys, members)
      ).get(1)!
      // A, enrolled last, is granted epoch 1 by a plain member: no approval
      // is needed for that.
      const request = await grantRequest('Hk', members, held.A.keys.userId)
      expect(request).to.include({ identityReset: false, canApprove: true })
      ok(
        await call('Hk', 'POST', '/chat/grants', {
          boxes: [grantFor(request, firstKey)]
        })
      )

      // A resets: the old box is under a replaced identity, and A waits.
      const reset = await devices.reset('A')
      expect(
        ok(
          await call(
            reset.device.who,
            'GET',
            `/chat/conversations/${members}/epochs`
          )
        ).boxes
      ).deep.equals([])
      expect(await memberRow('Ha', members, held.A.keys.userId)).deep.include({
        hasIdentity: true,
        eligible: false
      })
      expect(await needsRotation(members)).equals(true)

      // The next epoch may not box A; it leaves A's reset request open.
      const withA = await devices.recipients('Hc', members, 'hasIdentity')
      const eligible = await devices.recipients('Hc', members, 'eligible')
      expect(withA.length).equals(eligible.length + 1)
      const key = newEpochKey()
      const epochTwo = (recipients: Recipient[]): unknown =>
        devices.epochBody({
          conversationId: members,
          epoch: 2,
          creator: held.Hc.keys,
          epochKey: key,
          previousEpochKey: firstKey,
          recipients
        })
      refused(
        await call(
          'Hc',
          'POST',
          `/chat/conversations/${members}/epochs`,
          epochTwo(withA)
        ),
        400,
        'boxSet'
      )
      ok(
        await call(
          'Hc',
          'POST',
          `/chat/conversations/${members}/epochs`,
          epochTwo(eligible)
        ),
        201
      )
      expect(await needsRotation(members)).equals(false)
      expect(await openRequests(members)).deep.equals([
        { userId: held.A.keys.userId, reset: true, generation: 1 }
      ])

      // Only an approver (a moderator, in Members) may fill it.
      const asHk = await grantRequest('Hk', members, held.A.keys.userId)
      expect(asHk).to.include({
        epoch: 2,
        identityId: reset.keys.identityId,
        identityKey: b64(reset.keys.identity.publicKey),
        identityReset: true,
        canApprove: false
      })
      const asHa = await grantRequest('Ha', members, held.A.keys.userId)
      expect(asHa).to.include({ identityReset: true, canApprove: true })

      // A never approves A's own request, even holding a key.
      const asA = await grantRequest(
        reset.device.who,
        members,
        held.A.keys.userId
      )
      expect(asA).to.include({ identityReset: true, canApprove: false })
      refused(
        await call(reset.device.who, 'POST', '/chat/grants', {
          boxes: [grantFor(asA, key)]
        }),
        403,
        'notHolder'
      )
      const forged = {
        conversation_id: members,
        epoch: 2,
        user_id: held.A.keys.userId,
        identity_id: reset.keys.identityId,
        generation: 1,
        box: new Uint8Array([1]),
        granted_by_user_id: fixture.id('Hc'),
        created_at: new Date()
      }
      await db.insertInto('chat_epoch_boxes').values(forged).execute()
      refused(
        await call(reset.device.who, 'POST', '/chat/grants', {
          boxes: [grantFor(asA, key)]
        }),
        403,
        'notApprover'
      )
      await db
        .deleteFrom('chat_epoch_boxes')
        .where('conversation_id', '=', members)
        .where('user_id', '=', held.A.keys.userId)
        .execute()
      expect(await openRequests(members)).deep.equals([
        { userId: held.A.keys.userId, reset: true, generation: 1 }
      ])

      // B asks too; a batch from Hk holding A's box is refused whole.
      held.B = await devices.enrol('B')
      const forB = await grantRequest('Hk', members, held.B.keys.userId)
      refused(
        await call('Hk', 'POST', '/chat/grants', {
          boxes: [grantFor(forB, key), grantFor(asHk, key)]
        }),
        403,
        'notApprover'
      )
      expect((await openRequests(members)).map(row => row.userId)).deep.equals(
        [held.A.keys.userId, held.B.keys.userId].sort((x, y) => x - y)
      )

      expect(
        ok(
          await call('Ha', 'POST', '/chat/grants', {
            boxes: [grantFor(asHa, key), grantFor(forB, key)]
          })
        )
      ).deep.equals({ filled: 2, skipped: [] })
      expect(await openRequests(members)).deep.equals([])
      expect(await memberRow('Hk', members, held.A.keys.userId)).deep.include({
        eligible: true
      })
      // A opens epoch 2, and epoch 1 through its previous key box.
      const opened = await devices.openEpochKeys(
        reset.device.who,
        reset.keys,
        members
      )
      expect(equalBytes(opened.get(2)!, key)).equals(true)
      const record = ok(
        await call(
          reset.device.who,
          'GET',
          `/chat/conversations/${members}/epochs?after=1`
        )
      ).epochs[0]
      expect(
        equalBytes(
          openPreviousEpochKey({
            conversationId: members,
            epoch: 2,
            epochKey: key,
            previousKeyBox: unb64(record.previousKeyBox)
          }),
          firstKey
        )
      ).equals(true)
    })
  })

  describe('when nobody holds the key', function () {
    it('lets any member with an identity, a reset included, break the chain', async function () {
      for (const key of ['Ec', 'Ea', 'Ek']) held[key] = await devices.enrol(key)
      const made = ok(
        await call('Ec', 'POST', '/chat/dms', {
          userIds: [fixture.id('Ea'), fixture.id('Ek')]
        }),
        201
      )
      const dm: string = made.id
      const first = newEpochKey()
      ok(
        await call(
          'Ec',
          'POST',
          `/chat/conversations/${dm}/epochs`,
          devices.epochBody({
            conversationId: dm,
            epoch: 1,
            creator: held.Ec.keys,
            epochKey: first,
            previousEpochKey: null,
            recipients: await devices.recipients('Ec', dm, 'eligible')
          })
        ),
        201
      )

      // Ek and Ea reset; Ec still holds epoch 1, so no break yet.
      const ek = await devices.reset('Ek')
      const ea = await devices.reset('Ea')
      const everybody = await devices.recipients(
        ek.device.who,
        dm,
        'hasIdentity'
      )
      const second = newEpochKey()
      const breaking = (
        previous: Uint8Array | null,
        recipients = everybody
      ): unknown =>
        devices.epochBody({
          conversationId: dm,
          epoch: 2,
          creator: ek.keys,
          epochKey: second,
          previousEpochKey: previous,
          recipients
        })
      refused(
        await call(
          ek.device.who,
          'POST',
          `/chat/conversations/${dm}/epochs`,
          breaking(null)
        ),
        403,
        'notHolder'
      )
      expect(await listed(ek.device.who, dm)).deep.equals({
        locked: true,
        noHolder: false
      })

      // Ec, the last holder, leaves.
      ok(await call('Ec', 'DELETE', `/chat/dms/${dm}/members/me`))
      expect(await listed(ek.device.who, dm)).deep.equals({
        locked: true,
        noHolder: true
      })
      expect(
        ok(await call(ea.device.who, 'GET', `/chat/conversations/${dm}/epochs`))
      ).to.include({ latest: 1, needsRotation: true, noHolder: true })
      const remaining = await devices.recipients(
        ek.device.who,
        dm,
        'hasIdentity'
      )
      expect(
        remaining.map(row => fixture.keyOf(row.userId)).sort()
      ).deep.equals(['Ea', 'Ek'])
      expect(
        (await openRequests(dm))
          .map(row => `${fixture.keyOf(row.userId)} ${row.reset}`)
          .sort()
      ).deep.equals(['Ea true', 'Ek true'])

      // Nobody may claim to hold it, and the break boxes everybody with an
      // identity, not only the eligible (nobody, here).
      refused(
        await call(
          ek.device.who,
          'POST',
          `/chat/conversations/${dm}/epochs`,
          breaking(first, remaining)
        ),
        403,
        'notHolder'
      )
      refused(
        await call(
          ek.device.who,
          'POST',
          `/chat/conversations/${dm}/epochs`,
          breaking(null, [])
        ),
        400,
        'boxSet'
      )
      notes = []
      expect(
        ok(
          await call(
            ek.device.who,
            'POST',
            `/chat/conversations/${dm}/epochs`,
            breaking(null, remaining)
          ),
          201
        )
      ).deep.equals({ epoch: 2, chainBreak: true, boxed: 2, grantRequests: 0 })
      await settle()
      expect(notes).deep.include({ c: dm, k: 'epoch' })

      // Recorded as a break; every open request superseded; both eligible.
      const row = await db
        .selectFrom('chat_epochs')
        .select(['chain_break', 'previous_key_box', 'signature'])
        .where('conversation_id', '=', dm)
        .where('epoch', '=', 2)
        .executeTakeFirstOrThrow()
      expect(row.chain_break).equals(true)
      expect(row.previous_key_box).equals(null)
      expect(
        verifyEpoch(
          { conversationId: dm, epoch: 2, previousKeyBox: null },
          new Uint8Array(row.signature),
          ek.keys.identity.publicKey
        )
      ).equals(true)
      expect(await openRequests(dm)).deep.equals([])
      const superseded = await db
        .selectFrom('chat_grant_requests')
        .select(['user_id'])
        .where('conversation_id', '=', dm)
        .where('superseded_at', 'is not', null)
        .execute()
      expect(superseded.length).to.be.at.least(2)
      for (const who of [ek, ea]) {
        expect(
          await memberRow(who.device.who, dm, who.keys.userId)
        ).deep.include({ eligible: true })
        const opened = await devices.openEpochKeys(who.device.who, who.keys, dm)
        expect([...opened.keys()]).deep.equals([2])
        expect(equalBytes(opened.get(2)!, second)).equals(true)
      }
      expect(await listed(ea.device.who, dm)).deep.equals({
        locked: false,
        noHolder: false
      })
      expect(await needsRotation(dm)).equals(false)
      const read = ok(
        await call(
          ea.device.who,
          'GET',
          `/chat/conversations/${dm}/epochs?after=1`
        )
      )
      expect(read.epochs[0]).to.include({
        chainBreak: true,
        previousKeyBox: null
      })

      // A closed chat takes no new epoch.
      await db
        .updateTable('chat_conversations')
        .set({ closed_at: new Date() })
        .where('id', '=', dm)
        .execute()
      refused(
        await call(
          ek.device.who,
          'POST',
          `/chat/conversations/${dm}/epochs`,
          devices.epochBody({
            conversationId: dm,
            epoch: 3,
            creator: ek.keys,
            epochKey: newEpochKey(),
            previousEpochKey: second,
            recipients: remaining
          })
        ),
        409,
        'closed'
      )
    })
  })
})
