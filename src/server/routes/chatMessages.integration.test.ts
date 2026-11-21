import { expect } from 'chai'
import type { Kysely } from 'kysely'
import { after, before, beforeEach, describe, it } from 'mocha'
import { Client } from 'pg'

import type { ChatReport } from '../../common/api'
import { utf8 } from '../../common/chatCrypto/bytes'
import { newEpochKey, sign } from '../../common/chatCrypto/keys'
import { newIdentityId, newMessageId } from '../../common/chatCrypto/messageIds'
import { randomBytes } from '../../common/chatCrypto/random'
import {
  type EnvelopeKind,
  messageAad,
  messageKey,
  sealMessage,
  signedDigest
} from '../../common/chatCrypto/seal'
import {
  b64,
  ChatDevices,
  ok,
  refused,
  type TestDevice,
  type TestKeys,
  unb64
} from '../chat/chatTestDevices'
import { type ChatFixture, openChatFixture } from '../chat/chatTestFixture'
import type { Database } from '../db/database'

/**
 * U8 through the routes, with real sealed messages from `common/chatCrypto`
 * on the device side: posting (idempotent ids, the current epoch and
 * identity, `locked`, the size cap, Announcements), deletes and moderator
 * deletes with their attachments, read cursors, a closed DM, paging, and
 * reports with their admin view.
 */

interface Sealed {
  id: string
  plaintext: string
  body: Record<string, unknown>
}

describe('chat messages, deletes, read cursors and reports (U8)', function () {
  this.timeout(120000)
  let fixture: ChatFixture
  let db: Kysely<Database>
  let devices: ChatDevices
  let listener: Client
  let notes: unknown[] = []
  const held: Record<string, { device: TestDevice; keys: TestKeys }> = {}

  before(async function () {
    const opened = await openChatFixture('messages', {
      leagueName: 'Harbor League'
    })
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

  /** Epoch n from `creator`, boxed to the eligible members; its key. */
  async function makeEpoch(
    creator: string,
    conversationId: string,
    epoch: number,
    previousEpochKey: Uint8Array | null
  ): Promise<Uint8Array> {
    const epochKey = newEpochKey()
    const recipients = await devices.recipients(
      creator,
      conversationId,
      'eligible'
    )
    ok(
      await call(
        creator,
        'POST',
        `/chat/conversations/${conversationId}/epochs`,
        devices.epochBody({
          conversationId,
          epoch,
          creator: held[creator].keys,
          epochKey,
          previousEpochKey,
          recipients
        })
      ),
      201
    )
    return epochKey
  }

  /** A message sealed and signed by `key`'s identity, as the app makes it. */
  function seal(
    key: string,
    conversationId: string,
    epoch: number,
    epochKey: Uint8Array,
    kind: EnvelopeKind,
    content: unknown,
    extra: {
      id?: string
      targetIds?: string[]
      attachmentIds?: string[]
      signer?: TestKeys
      identityId?: string
    } = {}
  ): Sealed {
    const id = extra.id ?? newMessageId()
    const plaintext = JSON.stringify(content)
    const keys = held[key].keys
    const sealed = sealMessage({
      conversationId,
      epoch,
      messageId: id,
      senderUserId: keys.userId,
      kind,
      epochKey,
      plaintext: utf8(plaintext),
      identitySecretKey: (extra.signer ?? keys).identity.secretKey
    })
    const body: Record<string, unknown> = {
      id,
      epoch,
      kind,
      senderIdentityId: extra.identityId ?? keys.identityId,
      nonce: b64(sealed.nonce),
      ciphertext: b64(sealed.ciphertext),
      signature: b64(sealed.signature)
    }
    if (extra.targetIds != null) body.targetIds = extra.targetIds
    if (extra.attachmentIds != null) body.attachmentIds = extra.attachmentIds
    return { id, plaintext, body }
  }

  const text = (body: string): unknown => ({
    type: 'text',
    body,
    mentions: [],
    attachments: []
  })

  const post = async (
    who: string,
    conversationId: string,
    body: unknown
  ): ReturnType<typeof call> =>
    await call(
      who,
      'POST',
      `/chat/conversations/${conversationId}/messages`,
      body
    )

  async function stored(id: string): Promise<{
    cleared_at: Date | null
    ciphertext: Uint8Array
  }> {
    return await db
      .selectFrom('chat_messages')
      .select(['cleared_at', 'ciphertext'])
      .where('id', '=', id)
      .executeTakeFirstOrThrow()
  }

  async function auditRows(pattern: string): Promise<number> {
    await new Promise(resolve => setTimeout(resolve, 100))
    const row = await db
      .selectFrom('audit_log')
      .select(eb => eb.fn.countAll<number>().as('n'))
      .where('path', 'like', pattern)
      .executeTakeFirstOrThrow()
    return Number(row.n)
  }

  // Hawks Members: Hc, Hk, B and C hold keys from the start; A enrols later.
  let members: string
  let dm: string
  const memberKeys: Uint8Array[] = []
  let dmKey: Uint8Array
  let first: Sealed

  describe('posting', function () {
    it('posts a sealed message, and a repeat answers the stored row', async function () {
      for (const key of ['Hc', 'Hk', 'B', 'C']) {
        held[key] = await devices.enrol(key)
      }
      members = await chatId('B', 'Hawks Members')
      memberKeys[1] = await makeEpoch('Hc', members, 1, null)

      first = seal('B', members, 1, memberKeys[1], 'post', text('hello'))
      notes = []
      const made = ok(await post('B', members, first.body), 201)
      expect(made).to.include({
        id: first.id,
        conversationId: members,
        seq: 1,
        epoch: 1,
        senderUserId: held.B.keys.userId,
        senderIdentityId: held.B.keys.identityId,
        kind: 'post',
        targetIds: null,
        clearedAt: null
      })
      expect(made.attachmentIds).deep.equals([])
      expect(made.ciphertext).equals(first.body.ciphertext)
      await settle()
      expect(notes).deep.include({ c: members, k: 'message', seq: 1 })

      // The same post again (a retry) is the stored row, not a second one.
      expect(ok(await post('B', members, first.body))).deep.equals(made)
      // Another body under the same id still answers what was stored.
      const other = seal('B', members, 1, memberKeys[1], 'post', text('x'), {
        id: first.id
      })
      expect(ok(await post('B', members, other.body))).deep.equals(made)
      expect(
        ok(await call('B', 'GET', `/chat/conversations/${members}/messages`))
      ).deep.equals([made])
      // The list says when the chat last had a message.
      const listed = (
        ok(await call('C', 'GET', '/chat/conversations')) as Array<{
          id: string
          lastMessageAt: string | null
          lastSeq: number
        }>
      ).find(chat => chat.id === members)
      expect(listed?.lastSeq).equals(1)
      expect(listed?.lastMessageAt).equals(made.createdAt)

      // The id from another sender, or in another conversation.
      const fromC = seal('C', members, 1, memberKeys[1], 'post', text('hi'), {
        id: first.id
      })
      refused(await post('C', members, fromC.body), 409, 'idTaken')
      dm = ok(
        await call('B', 'POST', '/chat/dms', { userIds: [held.C.keys.userId] }),
        201
      ).id
      dmKey = await makeEpoch('B', dm, 1, null)
      const elsewhere = seal('B', dm, 1, dmKey, 'post', text('hi'), {
        id: first.id
      })
      refused(await post('B', dm, elsewhere.body), 409, 'idTaken')

      // Malformed ids and envelopes.
      for (const id of [
        'msg_ABCDEFGHIJKLMNOPQRSTUVWXYZ',
        'cnv_1',
        'msg_short'
      ]) {
        expect((await post('B', members, { ...first.body, id })).status).equals(
          400
        )
      }
      expect(
        (await post('B', members, { ...first.body, kind: 'shout' })).status
      ).equals(400)
      expect(
        (
          await post('B', members, {
            ...first.body,
            nonce: b64(randomBytes(12))
          })
        ).status
      ).equals(400)

      // Posting is never audited.
      expect(await auditRows('%/messages')).equals(0)
    })

    it('needs the current identity, the current epoch, and a box for it', async function () {
      // A enrols after epoch 1: a linked device, but no box yet.
      held.A = await devices.enrol('A')
      const locked = seal('A', members, 1, newEpochKey(), 'post', text('hi'))
      refused(await post('A', members, locked.body), 409, 'locked')

      // Not B's current identity, and not signed by it.
      const notMine = seal('B', members, 1, memberKeys[1], 'post', text('x'), {
        identityId: newIdentityId()
      })
      refused(await post('B', members, notMine.body), 409, 'staleIdentity')
      const asC = seal('B', members, 1, memberKeys[1], 'post', text('x'), {
        identityId: held.C.keys.identityId
      })
      refused(await post('B', members, asC.body), 409, 'staleIdentity')
      const forged = seal('B', members, 1, memberKeys[1], 'post', text('x'), {
        signer: held.C.keys
      })
      refused(await post('B', members, forged.body), 400, 'badSignature')

      // Epoch 2 boxes A; epoch 1 is stale from then on.
      memberKeys[2] = await makeEpoch('Hc', members, 2, memberKeys[1])
      const stale = seal('B', members, 1, memberKeys[1], 'post', text('x'))
      refused(await post('B', members, stale.body), 409, 'staleEpoch')
      const ahead = seal('B', members, 3, memberKeys[2], 'post', text('x'))
      refused(await post('B', members, ahead.body), 409, 'staleEpoch')
      const now = seal('A', members, 2, memberKeys[2], 'post', text('in'))
      expect(ok(await post('A', members, now.body), 201).seq).equals(2)

      // A chat with no epoch yet.
      const announcements = await chatId(
        'B',
        'Spring 2027 - Harbor League Announcements'
      )
      const early = seal('B', announcements, 1, newEpochKey(), 'reaction', {
        type: 'reaction',
        targetId: first.id,
        emoji: '👍',
        remove: false
      })
      refused(await post('B', announcements, early.body), 409, 'staleEpoch')
    })

    it('needs a member on a linked device, in a signed-in session', async function () {
      const body = seal('B', members, 2, memberKeys[2], 'post', text('x')).body
      // A second session of B with a device that was never linked.
      const pending = await devices.session('B')
      await devices.register(pending)
      refused(await post(pending, members, body), 403, 'notHolder')
      await fixture.apiToken('B-token', 'B')
      refused(await post('B-token', members, body), 403, 'sessionRequired')
      expect((await post('nobody', members, body)).status).equals(401)
      held.F = await devices.enrol('F')
      expect((await post('F', members, body)).status).equals(404)
      expect(
        (await call('F', 'GET', `/chat/conversations/${members}/messages`))
          .status
      ).equals(404)
      expect((await post('B', 'cnv_nothing', body)).status).equals(404)
    })

    it('takes a ciphertext of 64 KiB and no more', async function () {
      const keys = held.B.keys
      const envelope = (size: number): Record<string, unknown> => {
        const id = newMessageId()
        const nonce = randomBytes(24)
        const ciphertext = randomBytes(size)
        const aad = messageAad({
          conversationId: members,
          epoch: 2,
          messageId: id,
          senderUserId: keys.userId,
          kind: 'post'
        })
        return {
          id,
          epoch: 2,
          kind: 'post',
          senderIdentityId: keys.identityId,
          nonce: b64(nonce),
          ciphertext: b64(ciphertext),
          signature: b64(
            sign(signedDigest(aad, nonce, ciphertext), keys.identity.secretKey)
          )
        }
      }
      const most = ok(await post('B', members, envelope(65536)), 201)
      expect(unb64(most.ciphertext)).to.have.length(65536)
      expect((await post('B', members, envelope(65537))).status).equals(400)
      expect((await post('B', members, envelope(0))).status).equals(400)
    })

    it('lets only season staff post in Announcements, and anybody react', async function () {
      held.S = await devices.enrol('S')
      const announcements = await chatId(
        'S',
        'Spring 2027 - Harbor League Announcements'
      )
      const key = await makeEpoch('S', announcements, 1, null)
      const news = seal('S', announcements, 1, key, 'post', text('Opening day'))
      ok(await post('S', announcements, news.body), 201)

      const fromA = seal('A', announcements, 1, key, 'post', text('me too'))
      refused(await post('A', announcements, fromA.body), 403, 'notStaff')
      const edit = seal('A', announcements, 1, key, 'edit', {
        type: 'edit',
        targetId: news.id,
        body: 'x',
        mentions: []
      })
      refused(await post('A', announcements, edit.body), 403, 'notStaff')
      const reaction = seal('A', announcements, 1, key, 'reaction', {
        type: 'reaction',
        targetId: news.id,
        emoji: '🎉',
        remove: false
      })
      ok(await post('A', announcements, reaction.body), 201)
      const unreact = seal(
        'A',
        announcements,
        1,
        key,
        'delete',
        {
          type: 'delete',
          targetId: reaction.id
        },
        { targetIds: [reaction.id] }
      )
      refused(await post('A', announcements, unreact.body), 403, 'notStaff')
      const remove = (who: string): Sealed =>
        seal(
          who,
          announcements,
          1,
          key,
          'moderatorDelete',
          {
            type: 'delete',
            targetId: reaction.id
          },
          { targetIds: [reaction.id] }
        )
      refused(
        await post('A', announcements, remove('A').body),
        403,
        'notModerator'
      )
      ok(await post('S', announcements, remove('S').body), 201)
      expect((await stored(reaction.id)).cleared_at).not.equals(null)
    })
  })

  describe('deletes', function () {
    it('allows targetIds on the two deletes only', async function () {
      const target = { targetIds: [first.id] }
      for (const kind of ['post', 'reaction', 'edit'] as const) {
        const body = seal('B', members, 2, memberKeys[2], kind, {}, target).body
        expect((await post('B', members, body)).status, kind).equals(400)
      }
      for (const kind of ['delete', 'moderatorDelete'] as const) {
        const bare = seal('Hc', members, 2, memberKeys[2], kind, {}).body
        expect((await post('Hc', members, bare)).status, kind).equals(400)
        const none = seal(
          'Hc',
          members,
          2,
          memberKeys[2],
          kind,
          {},
          {
            targetIds: []
          }
        ).body
        expect((await post('Hc', members, none)).status, kind).equals(400)
        const twice = seal(
          'Hc',
          members,
          2,
          memberKeys[2],
          kind,
          {},
          {
            targetIds: [first.id, first.id]
          }
        ).body
        expect((await post('Hc', members, twice)).status, kind).equals(400)
      }
    })

    it('clears the post and its edits for its author, and nobody else', async function () {
      const original = seal(
        'B',
        members,
        2,
        memberKeys[2],
        'post',
        text('oops')
      )
      ok(await post('B', members, original.body), 201)
      const edit = seal('B', members, 2, memberKeys[2], 'edit', {
        type: 'edit',
        targetId: original.id,
        body: 'oops, fixed',
        mentions: []
      })
      ok(await post('B', members, edit.body), 201)
      const deletion = (who: string, targetIds: string[]): Sealed =>
        seal(
          who,
          members,
          2,
          memberKeys[2],
          'delete',
          {
            type: 'delete',
            targetId: original.id
          },
          { targetIds }
        )

      refused(
        await post('C', members, deletion('C', [original.id]).body),
        403,
        'notYours'
      )
      refused(
        await post(
          'B',
          members,
          deletion('B', [original.id, first.id, newMessageId()]).body
        ),
        400,
        'target'
      )
      const inDm = seal('B', dm, 1, dmKey, 'post', text('private'))
      ok(await post('B', dm, inDm.body), 201)
      refused(
        await post('B', members, deletion('B', [inDm.id]).body),
        400,
        'target'
      )

      const done = deletion('B', [original.id, edit.id])
      const made = ok(await post('B', members, done.body), 201)
      expect(made.targetIds).deep.equals([original.id, edit.id])
      for (const id of [original.id, edit.id]) {
        const row = await stored(id)
        expect(row.cleared_at).not.equals(null)
        expect(row.ciphertext).to.have.length(0)
      }
      const listed = ok(
        await call('C', 'GET', `/chat/conversations/${members}/messages`)
      ) as Array<{ id: string; ciphertext: string; clearedAt: string | null }>
      const shown = listed.find(row => row.id === original.id)
      expect(shown?.ciphertext).equals('')
      expect(shown?.clearedAt).equals(fixture.now.toISOString())

      // A delete is no target; a second delete leaves the first clearing.
      refused(
        await post('B', members, deletion('B', [done.id]).body),
        400,
        'target'
      )
      const clearedAt = (await stored(original.id)).cleared_at
      fixture.now = new Date(fixture.now.getTime() + 1000)
      ok(await post('B', members, deletion('B', [original.id]).body), 201)
      expect((await stored(original.id)).cleared_at).deep.equals(clearedAt)
    })

    it('lets a moderator clear anyone’s message and its attachments', async function () {
      const attach = async (
        id: string,
        uploader: string,
        options: { complete?: boolean; conversationId?: string } = {}
      ): Promise<void> => {
        const conversationId = options.conversationId ?? members
        await db
          .insertInto('chat_attachments')
          .values({
            id,
            conversation_id: conversationId,
            uploader_user_id: fixture.id(uploader),
            size: 1000,
            object_key: `chat/${conversationId}/${id}`,
            digest: randomBytes(32),
            completed_at: options.complete === false ? null : fixture.now
          })
          .execute()
      }
      await attach('cat_c1', 'C')
      await attach('cat_shared', 'C')
      await attach('cat_b1', 'B')
      await attach('cat_unfinished', 'C', { complete: false })
      await attach('cat_dm', 'C', { conversationId: dm })

      const withFiles = (attachmentIds: string[]): Sealed =>
        seal('C', members, 2, memberKeys[2], 'post', text('look'), {
          attachmentIds
        })
      for (const ids of [
        ['cat_b1'],
        ['cat_unfinished'],
        ['cat_dm'],
        ['cat_none']
      ]) {
        refused(
          await post('C', members, withFiles(ids).body),
          400,
          'attachment'
        )
      }
      const tooMany = Array.from({ length: 11 }, (_, index) => `cat_${index}`)
      expect((await post('C', members, withFiles(tooMany).body)).status).equals(
        400
      )
      const onReaction = seal(
        'C',
        members,
        2,
        memberKeys[2],
        'reaction',
        {},
        {
          attachmentIds: ['cat_c1']
        }
      )
      expect((await post('C', members, onReaction.body)).status).equals(400)

      const photo = withFiles(['cat_c1', 'cat_shared'])
      expect(
        ok(await post('C', members, photo.body), 201).attachmentIds
      ).deep.equals(['cat_c1', 'cat_shared'])
      const again = withFiles(['cat_shared'])
      ok(await post('C', members, again.body), 201)

      const remove = (who: string, targetIds: string[]): Sealed =>
        seal(
          who,
          members,
          2,
          memberKeys[2],
          'moderatorDelete',
          {
            type: 'delete',
            targetId: targetIds[0]
          },
          { targetIds }
        )
      refused(
        await post('C', members, remove('C', [photo.id]).body),
        403,
        'notModerator'
      )
      refused(
        await post('B', members, remove('B', [photo.id]).body),
        403,
        'notModerator'
      )

      // Hc (coach) removes the photo: its own file goes, the shared one stays.
      ok(await post('Hc', members, remove('Hc', [photo.id]).body), 201)
      expect((await stored(photo.id)).cleared_at).not.equals(null)
      expect(fixture.deletedObjects).deep.equals([`chat/${members}/cat_c1`])
      const left = await db
        .selectFrom('chat_attachments')
        .select('id')
        .where('conversation_id', '=', members)
        .orderBy('id')
        .execute()
      expect(left.map(row => row.id)).deep.equals([
        'cat_b1',
        'cat_shared',
        'cat_unfinished'
      ])
      ok(await post('Hc', members, remove('Hc', [again.id]).body), 201)
      expect(fixture.deletedObjects).deep.equals([
        `chat/${members}/cat_c1`,
        `chat/${members}/cat_shared`
      ])

      // Nobody moderates a DM.
      const dmPost = seal('C', dm, 1, dmKey, 'post', text('dm'))
      ok(await post('C', dm, dmPost.body), 201)
      const dmRemove = seal(
        'B',
        dm,
        1,
        dmKey,
        'moderatorDelete',
        {},
        {
          targetIds: [dmPost.id]
        }
      )
      refused(await post('B', dm, dmRemove.body), 403, 'notModerator')
    })
  })

  describe('reading', function () {
    it('pages messages by seq', async function () {
      const all = ok(
        await call('B', 'GET', `/chat/conversations/${members}/messages`)
      ) as Array<{ seq: number }>
      const seqs = all.map(row => row.seq)
      expect(seqs).deep.equals(
        Array.from({ length: seqs.length }, (_, index) => index + 1)
      )
      const page = async (query: string): Promise<number[]> =>
        (
          ok(
            await call(
              'B',
              'GET',
              `/chat/conversations/${members}/messages?${query}`
            )
          ) as Array<{ seq: number }>
        ).map(row => row.seq)
      expect(await page('after=2&limit=3')).deep.equals([3, 4, 5])
      expect(await page('before=5&limit=2')).deep.equals([3, 4])
      expect(await page('after=1&before=4')).deep.equals([2, 3])
      expect(await page('limit=0')).deep.equals([1])
      expect(await page('limit=x&after=y')).deep.equals(seqs)
      expect(await page(`after=${seqs.length}`)).deep.equals([])
    })

    it('moves read cursors forward only, and lists every member’s', async function () {
      const read = async (who: string, seq: unknown): ReturnType<typeof call> =>
        await call(who, 'PUT', `/chat/conversations/${members}/read`, { seq })
      notes = []
      expect(ok(await read('B', 3))).deep.equals({ seq: 3 })
      await settle()
      expect(notes).deep.equals([{ c: members, k: 'read', seq: 3 }])
      notes = []
      expect(ok(await read('B', 1))).deep.equals({ seq: 3 })
      expect(ok(await read('B', 3))).deep.equals({ seq: 3 })
      await settle()
      expect(notes).deep.equals([])
      expect(ok(await read('C', 2))).deep.equals({ seq: 2 })
      expect(ok(await read('Hc', 0))).deep.equals({ seq: 0 })
      refused(await read('B', 100000), 400, 'seq')
      expect((await read('B', -1)).status).equals(400)
      expect((await read('B', 'x')).status).equals(400)
      expect((await read('F', 1)).status).equals(404)

      const reads = ok(
        await call('A', 'GET', `/chat/conversations/${members}/reads`)
      ) as Array<{ userId: string; seq: number }>
      expect(
        Object.fromEntries(
          reads.map(row => [fixture.keyOf(row.userId), row.seq])
        )
      ).deep.equals({ B: 3, C: 2, Hc: 0 })
      expect(await auditRows('%/read')).equals(0)
    })

    it('closes the DM and hides its history as the first answer is given, before the reconciler runs', async function () {
      // The age route stamps the answer by the real clock; the DM's joins go
      // just before it.
      const fixtureNow = fixture.now
      fixture.now = new Date(Date.now() - 60_000)
      try {
        const u = await fixture.person('Answering', { noAge: true })
        await db
          .insertInto('memberships')
          .values({
            id: `mem_${u}`,
            user_id: u,
            team_id: fixture.seed.teams.hawks,
            role: 'member'
          })
          .execute()
        await fixture.drain()
        held.A ??= await devices.enrol('A')
        const made = ok(
          await call('A', 'POST', '/chat/dms', { userIds: [u] }),
          201
        )
        const key = await makeEpoch('A', made.id, 1, null)
        ok(
          await post(
            'A',
            made.id,
            seal('A', made.id, 1, key, 'post', text('earlier')).body
          ),
          201
        )
        const now = new Date()
        ok(
          await call('Answering', 'PUT', '/me/account/age', {
            year: now.getUTCFullYear() - 15,
            month: 1
          })
        )
        // No drain: the age route itself has closed the DM and hidden it.
        const dm = await db
          .selectFrom('chat_conversations')
          .select('closed_at')
          .where('id', '=', made.id)
          .executeTakeFirstOrThrow()
        expect(dm.closed_at).not.equals(null)
        expect(
          ok(
            await call(
              'Answering',
              'GET',
              `/chat/conversations/${made.id}/messages`
            )
          )
        ).deep.equals([])
        expect(
          ok(await call('A', 'GET', `/chat/conversations/${made.id}/messages`))
        ).to.have.length(1)
      } finally {
        fixture.now = fixtureNow
      }
    })

    /**
     * On the real clock (the age routes stamp answers by it): a Hawks member
     * with no age, in a DM with A that holds one post from A.
     */
    const ageless = async (
      key: string,
      by = 'A',
      player = false
    ): Promise<{ userId: string; dm: string; restore: () => void }> => {
      const fixtureNow = fixture.now
      fixture.now = new Date(Date.now() - 60_000)
      const restore = (): void => {
        fixture.now = fixtureNow
      }
      try {
        const userId = await fixture.person(key, { noAge: true })
        await db
          .insertInto('memberships')
          .values({
            id: `mem_${userId}`,
            user_id: userId,
            team_id: fixture.seed.teams.hawks,
            role: 'member',
            is_player: player
          })
          .execute()
        await fixture.drain()
        held[by] ??= await devices.enrol(by)
        const made = ok(
          await call(by, 'POST', '/chat/dms', { userIds: [userId] }),
          201
        )
        const key1 = await makeEpoch(by, made.id, 1, null)
        ok(
          await post(
            by,
            made.id,
            seal(by, made.id, 1, key1, 'post', text('earlier')).body
          ),
          201
        )
        return { userId, dm: made.id, restore }
      } catch (error) {
        restore()
        throw error
      }
    }
    const fifteen = (): { year: number; month: number } => ({
      year: new Date().getUTCFullYear() - 15,
      month: 1
    })
    const messagesFor = async (who: string, dm: string): Promise<unknown[]> =>
      ok(
        await call(who, 'GET', `/chat/conversations/${dm}/messages`)
      ) as unknown[]
    const closedAt = async (dm: string): Promise<Date | null> =>
      (
        await db
          .selectFrom('chat_conversations')
          .select('closed_at')
          .where('id', '=', dm)
          .executeTakeFirstOrThrow()
      ).closed_at

    it('closes and hides on a first age a site administrator gives', async function () {
      const { userId, dm, restore } = await ageless('AdminAged')
      try {
        ok(await call('Z', 'PUT', `/people/${userId}/age`, fifteen()))
        expect(await closedAt(dm)).not.equals(null)
        expect(await messagesFor('AdminAged', dm)).deep.equals([])
      } finally {
        restore()
      }
    })

    it('hides a DM the adult in it has left from a member who answers 13 to 17', async function () {
      const { dm, restore } = await ageless('LeftBehind')
      try {
        ok(await call('A', 'DELETE', `/chat/dms/${dm}/members/me`))
        ok(await call('LeftBehind', 'PUT', '/me/account/age', fifteen()))
        expect(await messagesFor('LeftBehind', dm)).deep.equals([])
      } finally {
        restore()
      }
    })

    it('leaves a DM under way open while the minor’s guardian has no age, and lists no hidden messages', async function () {
      const { userId, dm, restore } = await ageless('NoAgeYet')
      try {
        // Answering 15 closes the DM with A and hides its post from them…
        ok(await call('NoAgeYet', 'PUT', '/me/account/age', fifteen()))
        const listed = (
          ok(await call('NoAgeYet', 'GET', '/chat/conversations')) as Array<{
            id: string
            unread: number
            lastPostId: string | null
            lastMessageAt: string | null
          }>
        ).find(row => row.id === dm)
        // …and the list shows nothing of what it hides.
        expect(listed).to.include({
          unread: 0,
          lastPostId: null,
          lastMessageAt: null
        })
        // A DM between that minor and a guardian with no age (as every
        // parent is at deploy) stays open: the guardian reads nothing until
        // they answer, and their answer re-checks it.
        const parent = await fixture.person('NoAgeParent')
        await db
          .insertInto('user_links')
          .values({
            id: `ul_${parent}`,
            user_id: parent,
            related_user_id: userId,
            kind: 'guardian',
            can_manage: true
          })
          .execute()
        await fixture.drain()
        const family = ok(
          await call('NoAgeParent', 'POST', '/chat/dms', { userIds: [userId] }),
          201
        )
        await db
          .updateTable('users')
          .set({ is_adult: false, age_source: null, age_set_at: null })
          .where('id', '=', parent)
          .execute()
        await fixture.drain()
        expect(await closedAt(family.id)).equals(null)
        // A new DM still needs the guardian to be an adult.
        await db
          .updateTable('chat_conversations')
          .set({ closed_at: new Date() })
          .where('id', '=', family.id)
          .execute()
        expect(
          (
            await call('NoAgeParent', 'POST', '/chat/dms', {
              userIds: [userId]
            })
          ).status
        ).equals(403)
      } finally {
        restore()
      }
    })

    it('hides from an adult whose first answer breaks a minor’s DM what the minor wrote before', async function () {
      const fixtureNow = fixture.now
      fixture.now = new Date(Date.now() - 60_000)
      try {
        // X plays for Eagles in P's season, born 44 months before P: a peer,
        // and an adult.
        const p = await db
          .selectFrom('users')
          .select(['birth_year', 'birth_month'])
          .where('id', '=', fixture.id('P'))
          .executeTakeFirstOrThrow()
        const months = p.birth_year! * 12 + (p.birth_month! - 1) - 44
        const x = await fixture.person('Xavier', {
          birth: { year: Math.floor(months / 12), month: (months % 12) + 1 }
        })
        await db
          .insertInto('memberships')
          .values({
            id: `mem_${x}`,
            user_id: x,
            team_id: fixture.seed.teams.eagles,
            role: 'member',
            is_player: true
          })
          .execute()
        await fixture.drain()
        held.P ??= await devices.enrol('P')
        const made = ok(
          await call('P', 'POST', '/chat/dms', { userIds: [x] }),
          201
        )
        // An administrator clears X's age: X reads nothing, and breaks no
        // rule in the DM under way.
        ok(
          await call('Z', 'PUT', `/people/${x}/age`, {
            year: null,
            month: null
          })
        )
        await fixture.drain()
        expect(await closedAt(made.id)).equals(null)
        const key = await makeEpoch('P', made.id, 1, null)
        ok(
          await post(
            'P',
            made.id,
            seal('P', made.id, 1, key, 'post', text('from P')).body
          ),
          201
        )
        // X answers 18 or older, which makes them no peer of P's.
        ok(await call('Xavier', 'PUT', '/me/account/age', { adult: true }))
        expect(await closedAt(made.id)).not.equals(null)
        expect(await messagesFor('Xavier', made.id)).deep.equals([])
        expect(await messagesFor('P', made.id)).to.have.length(1)
      } finally {
        fixture.now = fixtureNow
      }
    })

    it('leaves the history a minor has read when a later break closes the DM', async function () {
      const { userId, dm, restore } = await ageless('Coached', 'Hc', true)
      const role = await db
        .selectFrom('scope_roles')
        .selectAll()
        .where('user_id', '=', fixture.id('Hc'))
        .where('scope_id', '=', fixture.seed.teams.hawks)
        .execute()
      try {
        // Answering 15 keeps the DM with their coach open, history and all.
        ok(await call('Coached', 'PUT', '/me/account/age', fifteen()))
        expect(await closedAt(dm)).equals(null)
        expect(await messagesFor('Coached', dm)).to.have.length(1)
        // Hc stops coaching Hawks: the next pass closes the DM for the pair
        // rule, and hides nothing Coached has read.
        await db
          .deleteFrom('scope_roles')
          .where('user_id', '=', fixture.id('Hc'))
          .where('scope_id', '=', fixture.seed.teams.hawks)
          .execute()
        await fixture.drain()
        expect(await closedAt(dm)).not.equals(null)
        expect(await messagesFor('Coached', dm)).to.have.length(1)
        expect(
          (
            await db
              .selectFrom('chat_members')
              .select('hidden_before')
              .where('conversation_id', '=', dm)
              .where('user_id', '=', userId)
              .executeTakeFirstOrThrow()
          ).hidden_before
        ).equals(null)
      } finally {
        if (role.length > 0)
          await db.insertInto('scope_roles').values(role).execute()
        await fixture.drain()
        restore()
      }
    })

    it('adds an adult guardian beside a guardian with no age to a DM under way', async function () {
      const { userId, dm, restore } = await ageless('Guarded', 'Hc', true)
      try {
        ok(await call('Guarded', 'PUT', '/me/account/age', fifteen()))
        const link = async (adult: string, id: string): Promise<void> => {
          await db
            .insertInto('user_links')
            .values({
              id,
              user_id: adult,
              related_user_id: userId,
              kind: 'guardian',
              can_manage: true
            })
            .execute()
        }
        const quiet = await fixture.person('QuietParent', { noAge: true })
        const adult = await fixture.person('AdultParent')
        await link(quiet, `ul_${quiet}`)
        await link(adult, `ul_${adult}`)
        await fixture.drain()
        // The parent with no age is already in the DM (from before deploy).
        await db
          .insertInto('chat_members')
          .values({
            conversation_id: dm,
            user_id: quiet,
            joined_at: new Date(Date.now() - 30_000)
          })
          .execute()
        expect(
          ok(
            await call('Hc', 'POST', `/chat/dms/${dm}/members`, {
              userIds: [adult]
            })
          ).added
        ).deep.equals([adult])
        // Somebody with no age is still not added.
        const other = await fixture.person('Stranger', { noAge: true })
        expect(
          (
            await call('Hc', 'POST', `/chat/dms/${dm}/members`, {
              userIds: [other]
            })
          ).status
        ).equals(403)
      } finally {
        restore()
      }
    })

    it('refuses posts in a closed DM', async function () {
      held.Ha ??= await devices.enrol('Ha')
      held.P ??= await devices.enrol('P')
      const made = ok(
        await call('Ha', 'POST', '/chat/dms', {
          userIds: [held.P.keys.userId]
        }),
        201
      )
      const key = await makeEpoch('Ha', made.id, 1, null)
      ok(
        await post(
          'Ha',
          made.id,
          seal('Ha', made.id, 1, key, 'post', text('hi')).body
        ),
        201
      )
      const safesport = async (on: boolean): Promise<void> => {
        await db
          .updateTable('leagues')
          .set({ safesport_lao: on })
          .where('id', '=', fixture.seed.leagueId)
          .execute()
        await fixture.drain()
      }
      await safesport(true)
      try {
        refused(
          await post(
            'P',
            made.id,
            seal('P', made.id, 1, key, 'post', text('hi')).body
          ),
          409,
          'closed'
        )
      } finally {
        await safesport(false)
      }
    })
  })

  describe('reports', function () {
    let reported: Sealed

    it('stores a report verified only by the right plaintext and key', async function () {
      reported = seal(
        'C',
        members,
        2,
        memberKeys[2],
        'post',
        text('second from C')
      )
      ok(await post('C', members, reported.body), 201)
      const rightKey = messageKey(memberKeys[2], members, reported.id)
      const report = async (
        who: string,
        body: Record<string, unknown>
      ): ReturnType<typeof call> =>
        await call(who, 'POST', '/chat/reports', {
          messageId: reported.id,
          plaintext: reported.plaintext,
          messageKey: b64(rightKey),
          ...body
        })

      const good = ok(await report('B', {}), 201)
      expect(good.verified).equals(true)
      expect(good.id).to.match(/^crp_/)
      expect(
        ok(await report('B', { plaintext: '{"type":"text"}' }), 201).verified
      ).equals(false)
      expect(
        ok(await report('B', { messageKey: b64(newEpochKey()) }), 201).verified
      ).equals(false)
      expect(
        ok(
          await report('B', {
            messageKey: b64(messageKey(memberKeys[1], members, reported.id))
          }),
          201
        ).verified
      ).equals(false)
      expect((await report('F', {})).status).equals(404)
      expect((await report('B', { messageId: newMessageId() })).status).equals(
        404
      )
      expect((await report('B', { messageId: 'nope' })).status).equals(400)
      expect((await report('B', { messageKey: 'AAAA' })).status).equals(400)

      const row = await db
        .selectFrom('chat_reports')
        .selectAll()
        .where('id', '=', good.id)
        .executeTakeFirstOrThrow()
      expect(row).to.include({
        conversation_id: members,
        message_id: reported.id,
        reporter_user_id: held.B.keys.userId,
        plaintext: reported.plaintext,
        verified: true
      })
      expect(b64(new Uint8Array(row.message_key))).equals(b64(rightKey))
      expect(row.envelope).to.include({
        id: reported.id,
        conversationId: members,
        epoch: 2,
        senderUserId: held.C.keys.userId,
        senderIdentityId: held.C.keys.identityId,
        kind: 'post',
        ciphertext: reported.body.ciphertext,
        nonce: reported.body.nonce,
        signature: reported.body.signature
      })
      expect(await auditRows('/api/v1/chat/reports')).equals(4)
    })

    it('keeps the report’s copy after a delete, and refuses a cleared message', async function () {
      const deletion = seal(
        'C',
        members,
        2,
        memberKeys[2],
        'delete',
        {
          type: 'delete',
          targetId: reported.id
        },
        { targetIds: [reported.id] }
      )
      ok(await post('C', members, deletion.body), 201)
      expect((await stored(reported.id)).ciphertext).to.have.length(0)
      const copies = await db
        .selectFrom('chat_reports')
        .select('envelope')
        .where('message_id', '=', reported.id)
        .execute()
      expect(copies).to.have.length(4)
      for (const copy of copies) {
        expect((copy.envelope as { ciphertext: string }).ciphertext).equals(
          reported.body.ciphertext
        )
      }
      refused(
        await call('B', 'POST', '/chat/reports', {
          messageId: reported.id,
          plaintext: reported.plaintext,
          messageKey: b64(messageKey(memberKeys[2], members, reported.id))
        }),
        409,
        'cleared'
      )
    })

    it('verifies a message signed by an identity since replaced', async function () {
      const before = seal(
        'Hk',
        members,
        2,
        memberKeys[2],
        'post',
        text('from my old phone')
      )
      ok(await post('Hk', members, before.body), 201)
      await devices.reset('Hk')
      expect(
        ok(
          await call('B', 'POST', '/chat/reports', {
            messageId: before.id,
            plaintext: before.plaintext,
            messageKey: b64(messageKey(memberKeys[2], members, before.id))
          }),
          201
        ).verified
      ).equals(true)
    })

    it('shows reports to site administrators, who resolve them', async function () {
      expect((await call('B', 'GET', '/admin/chat/reports')).status).equals(403)
      expect(
        (await call('nobody', 'GET', '/admin/chat/reports')).status
      ).equals(401)
      const all = ok(
        await call('Z', 'GET', '/admin/chat/reports')
      ) as ChatReport[]
      expect(all).to.have.length(5)
      expect(all.filter(report => report.verified)).to.have.length(2)
      const fromC = all.find(
        report => report.verified && report.messageId === reported.id
      )
      if (fromC == null) throw new Error('no verified report of C')
      expect(fromC).to.deep.include({
        conversation: {
          id: members,
          kind: 'teamMembers',
          title: 'Hawks Members'
        },
        kind: 'post',
        plaintext: reported.plaintext,
        sentAt: fixture.now.toISOString(),
        resolvedAt: null
      })
      expect(fromC.reporter.userId).equals(held.B.keys.userId)
      expect(fromC.sender.userId).equals(held.C.keys.userId)
      expect(fromC.reporter.shortName).not.equals('')
      expect(fromC.sender.shortName).not.equals('')

      const resolve = async (
        who: string,
        id: string
      ): ReturnType<typeof call> =>
        await call(who, 'PUT', `/admin/chat/reports/${id}/resolve`)
      expect((await resolve('B', fromC.id)).status).equals(403)
      expect((await resolve('Z', 'crp_nothing')).status).equals(404)
      fixture.now = new Date(fixture.now.getTime() + 60_000)
      const resolvedAt = fixture.now.toISOString()
      expect(ok(await resolve('Z', fromC.id))).to.deep.include({
        id: fromC.id,
        resolvedAt
      })
      fixture.now = new Date(fixture.now.getTime() + 60_000)
      expect(ok(await resolve('Z', fromC.id)).resolvedAt).equals(resolvedAt)
      const open = ok(
        await call('Z', 'GET', '/admin/chat/reports?open=true')
      ) as Array<{ id: string }>
      expect(open).to.have.length(4)
      expect(open.map(report => report.id)).not.to.include(fromC.id)
      expect(await auditRows('/api/v1/admin/chat/reports/%')).equals(2)
    })
  })
})
