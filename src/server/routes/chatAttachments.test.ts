import { createHash, randomBytes } from 'node:crypto'
import { access, mkdtemp, rm } from 'node:fs/promises'
import type { Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { expect } from 'chai'
import type { Kysely } from 'kysely'
import { after, before, describe, it } from 'mocha'

import { utf8 } from '../../common/chatCrypto/bytes'
import { newEpochKey } from '../../common/chatCrypto/keys'
import { newMessageId } from '../../common/chatCrypto/messageIds'
import { type EnvelopeKind, sealMessage } from '../../common/chatCrypto/seal'
import { openAttachment, sealAttachment } from '../../common/chatCrypto/stream'
import {
  attachmentKey,
  CHAT_PART_LIMIT,
  CHAT_PART_SIZE,
  chatUploadDir,
  createAttachment,
  MAX_BLOB,
  ORPHAN_AFTER_MS,
  purgeChatAttachments,
  spaceObjectStore,
  startChatPurge
} from '../chat/attachments'
import {
  b64,
  ChatDevices,
  ok,
  refused,
  type TestDevice,
  type TestKeys,
  unb64
} from '../chat/chatTestDevices'
import {
  type Answer,
  type ChatFixture,
  openChatFixture,
  TEST_MEDIA
} from '../chat/chatTestFixture'
import { type Database, makeDatabase } from '../db/database'
import { listen } from '../dev/fakeSpace'
import type { SpaceSettings } from '../media/spacesHls'

/**
 * U10 through the routes, against the stand-in Space on port 0: an
 * attachment sealed with `chatCrypto/stream.ts` goes up in 8 MiB parts,
 * resumes, completes (and is refused on a wrong digest), is read back through
 * its presigned URL and opened; non-members are refused; orphans are purged
 * after 24 hours while referenced attachments stay; deletes take objects.
 */
describe('chat attachments (U10)', function () {
  this.timeout(120000)
  let fixture: ChatFixture
  let db: Kysely<Database>
  let devices: ChatDevices
  let spaceServer: Server
  let spaceDir: string
  const space: SpaceSettings = {
    endpoint: '',
    region: 'sfo3',
    bucket: 'test-chat',
    accessKeyId: 'key',
    secretAccessKey: 'secret',
    pathStyle: true
  }
  const held: Record<string, { device: TestDevice; keys: TestKeys }> = {}
  let members: string
  let epochKey: Uint8Array

  before(async function () {
    spaceDir = await mkdtemp(join(tmpdir(), 'tsChatSpace-'))
    spaceServer = await listen('127.0.0.1', 0, { space, dir: spaceDir })
    space.endpoint = `http://127.0.0.1:${(spaceServer.address() as AddressInfo).port}`
    const opened = await openChatFixture('attachments', { space })
    if (opened == null) {
      this.skip()
      return
    }
    fixture = opened
    db = fixture.db
    devices = new ChatDevices(fixture)
    for (const key of ['Hc', 'B', 'C']) held[key] = await devices.enrol(key)
    members = await chatId('B', 'Hawks Members')
    epochKey = newEpochKey()
    const recipients = await devices.recipients('Hc', members, 'eligible')
    ok(
      await fixture.call(
        'Hc',
        'POST',
        `/chat/conversations/${members}/epochs`,
        devices.epochBody({
          conversationId: members,
          epoch: 1,
          creator: held.Hc.keys,
          epochKey,
          previousEpochKey: null,
          recipients
        })
      ),
      201
    )
  })

  after(async function () {
    await fixture?.close()
    spaceServer?.close()
    await rm(spaceDir, { recursive: true, force: true })
  })

  async function chatId(who: string, title: string): Promise<string> {
    const list = ok(
      await fixture.call(who, 'GET', '/chat/conversations')
    ) as Array<{ id: string; title: string | null }>
    const chat = list.find(item => item.title === title)
    if (chat == null) throw new Error(`${who} has no ${title}`)
    return chat.id
  }

  const create = async (
    who: string,
    body: Record<string, unknown>
  ): Promise<Answer> =>
    await fixture.call(who, 'POST', '/chat/attachments', body)

  /** One part's raw bytes, as the app sends them. */
  async function putPart(
    who: string,
    id: string,
    index: number | string,
    bytes: Uint8Array,
    contentType = 'application/octet-stream'
  ): Promise<Answer> {
    const response = await fetch(
      `${fixture.api}/chat/attachments/${id}/parts/${index}`,
      {
        method: 'PUT',
        headers: {
          authorization: `Bearer ${fixture.tokenOf(who)}`,
          'content-type': contentType
        },
        body: new Uint8Array(bytes)
      }
    )
    return {
      status: response.status,
      body: await response.json().catch(() => null)
    }
  }

  const partOf = (blob: Uint8Array, index: number): Uint8Array =>
    blob.subarray(index * CHAT_PART_SIZE, (index + 1) * CHAT_PART_SIZE)

  const inSpace = async (key: string): Promise<boolean> =>
    await access(join(spaceDir, key)).then(
      () => true,
      () => false
    )

  /** Opens, uploads every part and completes; the id. */
  async function upload(
    who: string,
    blob: Uint8Array,
    digest: Uint8Array,
    conversationId = members
  ): Promise<string> {
    const made = ok(
      await create(who, {
        conversationId,
        size: blob.length,
        digest: b64(digest)
      }),
      201
    )
    for (let index = 0; index < made.parts; index++) {
      ok(await putPart(who, made.id, index, partOf(blob, index)))
    }
    ok(await fixture.call(who, 'POST', `/chat/attachments/${made.id}/complete`))
    return made.id
  }

  function post(
    who: string,
    kind: EnvelopeKind,
    extra: { attachmentIds?: string[]; targetIds?: string[] } = {}
  ): { id: string; body: Record<string, unknown> } {
    const id = newMessageId()
    const keys = held[who].keys
    const sealed = sealMessage({
      conversationId: members,
      epoch: 1,
      messageId: id,
      senderUserId: keys.userId,
      kind,
      epochKey,
      plaintext: utf8(JSON.stringify({ type: 'text', body: 'file' })),
      identitySecretKey: keys.identity.secretKey
    })
    return {
      id,
      body: {
        id,
        epoch: 1,
        kind,
        senderIdentityId: keys.identityId,
        nonce: b64(sealed.nonce),
        ciphertext: b64(sealed.ciphertext),
        signature: b64(sealed.signature),
        ...extra
      }
    }
  }

  const send = async (
    who: string,
    message: { body: Record<string, unknown> }
  ): Promise<Answer> =>
    await fixture.call(
      who,
      'POST',
      `/chat/conversations/${members}/messages`,
      message.body
    )

  // 9 MiB of file: two parts, the second short.
  const file = randomBytes(9 * 1024 * 1024)
  const sealed = sealAttachment(file)
  let uploaded: string

  describe('upload', function () {
    it('refuses what it should not open', async function () {
      const digest = b64(sealed.digest)
      const size = sealed.blob.length
      expect(
        (await create('F', { conversationId: members, size, digest })).status
      ).equals(404)
      expect(
        (await create('B', { conversationId: 'cnv_none', size, digest })).status
      ).equals(404)
      const announcements = await chatId('A', 'QPLL Spring 2027 Announcements')
      refused(
        await create('A', { conversationId: announcements, size, digest }),
        403,
        'readOnly'
      )
      for (const bad of [0, MAX_BLOB + 1, 1.5, 'x']) {
        expect(
          (await create('B', { conversationId: members, size: bad, digest }))
            .status
        ).equals(400)
      }
      expect(
        (
          await create('B', {
            conversationId: members,
            size,
            digest: b64(randomBytes(31))
          })
        ).status
      ).equals(400)
      await fixture.apiToken('B-token', 'B')
      refused(
        await create('B-token', { conversationId: members, size, digest }),
        403,
        'sessionRequired'
      )
      expect(
        (await create('nobody', { conversationId: members, size, digest }))
          .status
      ).equals(401)
    })

    it('says there is nowhere to keep one without a Space', async function () {
      let refusal: any
      try {
        await createAttachment(
          { db, space: TEST_MEDIA.space, uploadsDir: fixture.uploadsDir },
          { userId: fixture.id('B'), sessionId: fixture.sessionOf('B') },
          { conversationId: members, size: 10, digest: randomBytes(32) },
          fixture.now
        )
      } catch (error) {
        refusal = error
      }
      expect(refusal?.details?.reason).equals('noSpace')
    })

    it('takes parts, resumes, and completes into the Space', async function () {
      const made = ok(
        await create('B', {
          conversationId: members,
          size: sealed.blob.length,
          digest: b64(sealed.digest)
        }),
        201
      )
      uploaded = made.id
      expect(made).to.include({
        conversationId: members,
        size: sealed.blob.length,
        completed: false,
        partSize: CHAT_PART_SIZE,
        parts: 2
      })
      expect(made.missing).deep.equals([0, 1])
      expect(made.id).matches(/^cat_/)

      // The last part first, as an app resuming might.
      expect(
        ok(await putPart('B', uploaded, 1, partOf(sealed.blob, 1)))
      ).deep.equals({ received: 1, parts: 2, missing: [0] })

      // The app was killed: it asks what landed, and sends only that.
      const state = ok(
        await fixture.call('B', 'GET', `/chat/attachments/${uploaded}`)
      )
      expect(state).to.include({ completed: false, parts: 2 })
      expect(state.missing).deep.equals([0])
      // Nobody else sees or adds to an unfinished upload.
      expect(
        (await fixture.call('C', 'GET', `/chat/attachments/${uploaded}`)).status
      ).equals(404)
      expect(
        (await putPart('C', uploaded, 0, partOf(sealed.blob, 0))).status
      ).equals(404)
      const early = await fixture.call(
        'B',
        'POST',
        `/chat/attachments/${uploaded}/complete`
      )
      refused(early, 409, 'partsMissing')
      expect(early.body.details.missing).deep.equals([0])

      // Wrong parts are refused rather than stored.
      refused(await putPart('B', uploaded, 2, randomBytes(10)), 400, 'part')
      refused(await putPart('B', uploaded, 'x', randomBytes(10)), 400, 'part')
      refused(await putPart('B', uploaded, 0, randomBytes(10)), 400, 'part')
      refused(await putPart('B', uploaded, 0, new Uint8Array(0)), 400, 'part')
      refused(
        await putPart('B', uploaded, 0, randomBytes(CHAT_PART_LIMIT + 1)),
        413,
        'part'
      )

      // Sent twice (a lost reply), and with a JSON type: the same part.
      ok(await putPart('B', uploaded, 0, partOf(sealed.blob, 0)))
      expect(
        ok(
          await putPart(
            'B',
            uploaded,
            0,
            partOf(sealed.blob, 0),
            'application/x-anything'
          )
        )
      ).deep.equals({ received: 2, parts: 2, missing: [] })

      const done = ok(
        await fixture.call(
          'B',
          'POST',
          `/chat/attachments/${uploaded}/complete`
        )
      )
      expect(done).deep.equals({
        id: uploaded,
        conversationId: members,
        size: sealed.blob.length,
        digest: b64(sealed.digest),
        completed: true
      })
      const key = attachmentKey(members, uploaded)
      expect(await inSpace(key)).equals(true)
      // The parts are gone once the blob is in the Space.
      expect(
        await access(chatUploadDir(fixture.uploadsDir, uploaded)).then(
          () => true,
          () => false
        )
      ).equals(false)
      // A repeat answers the same; parts are refused from now on.
      expect(
        ok(
          await fixture.call(
            'B',
            'POST',
            `/chat/attachments/${uploaded}/complete`
          )
        )
      ).deep.equals(done)
      refused(
        await putPart('B', uploaded, 0, partOf(sealed.blob, 0)),
        409,
        'completed'
      )
      const row = await db
        .selectFrom('chat_attachments')
        .selectAll()
        .where('id', '=', uploaded)
        .executeTakeFirstOrThrow()
      expect(row.object_key).equals(key)
      expect(Number(row.size)).equals(sealed.blob.length)
      expect(row.completed_at).deep.equals(fixture.now)
      const audited = await db
        .selectFrom('audit_log')
        .select(['path'])
        .where('path', 'like', '/api/v1/chat/attachments%')
        .execute()
      expect(audited.every(entry => !entry.path.includes('/parts/'))).equals(
        true
      )
    })

    it('refuses a blob that does not hash to its digest, and drops it', async function () {
      const other = sealAttachment(randomBytes(1000))
      const made = ok(
        await create('C', {
          conversationId: members,
          size: other.blob.length,
          digest: b64(sealed.digest)
        }),
        201
      )
      expect(made.parts).equals(1)
      ok(await putPart('C', made.id, 0, other.blob))
      refused(
        await fixture.call(
          'C',
          'POST',
          `/chat/attachments/${made.id}/complete`
        ),
        400,
        'digestMismatch'
      )
      expect(await inSpace(attachmentKey(members, made.id))).equals(false)
      const state = ok(
        await fixture.call('C', 'GET', `/chat/attachments/${made.id}`)
      )
      expect(state.missing).deep.equals([0])
      // Sent again, right this time? The digest was declared, so no.
      ok(await putPart('C', made.id, 0, other.blob))
      refused(
        await fixture.call(
          'C',
          'POST',
          `/chat/attachments/${made.id}/complete`
        ),
        400,
        'digestMismatch'
      )
    })
  })

  describe('download', function () {
    it('gives a member a 10-minute presigned URL that opens to the file', async function () {
      const read = ok(
        await fixture.call('C', 'GET', `/chat/attachments/${uploaded}`)
      )
      expect(read).to.include({
        id: uploaded,
        conversationId: members,
        completed: true,
        digest: b64(sealed.digest),
        expiresAt: new Date(fixture.now.getTime() + 600_000).toISOString()
      })
      const url = new URL(read.url)
      expect(url.searchParams.get('X-Amz-Expires')).equals('600')
      expect(url.pathname).equals(
        `/${space.bucket}/${attachmentKey(members, uploaded)}`
      )
      const fetched = await fetch(read.url)
      expect(fetched.status).equals(200)
      const blob = new Uint8Array(await fetched.arrayBuffer())
      expect(createHash('sha256').update(blob).digest()).deep.equals(
        Buffer.from(sealed.digest)
      )
      const opened = openAttachment(sealed.key, blob, unb64(read.digest))
      expect(Buffer.from(opened).equals(Buffer.from(file))).equals(true)
      // The Space holds ciphertext only.
      expect(
        Buffer.from(blob).includes(Buffer.from(file.subarray(0, 64)))
      ).equals(false)
    })

    it('refuses a non-member, and an unknown attachment', async function () {
      for (const who of ['F', 'D']) {
        expect(
          (await fixture.call(who, 'GET', `/chat/attachments/${uploaded}`))
            .status
        ).equals(404)
        expect(
          (
            await fixture.call(
              who,
              'POST',
              `/chat/attachments/${uploaded}/complete`
            )
          ).status
        ).equals(404)
      }
      expect(
        (await fixture.call('B', 'GET', '/chat/attachments/cat_none')).status
      ).equals(404)
    })
  })

  describe('clean-up', function () {
    let referenced: string
    let orphan: string
    let cleared: string
    const small = sealAttachment(utf8('a small file'))

    it('keeps attachments a message references, and purges orphans after 24 hours', async function () {
      referenced = uploaded
      ok(
        await send('B', post('B', 'post', { attachmentIds: [referenced] })),
        201
      )
      orphan = await upload('C', small.blob, small.digest)
      // Opened and never finished: parts on disk, nothing in the Space.
      const unfinished = ok(
        await create('C', {
          conversationId: members,
          size: small.blob.length,
          digest: b64(small.digest)
        }),
        201
      ).id as string
      ok(await putPart('C', unfinished, 0, small.blob))

      const objects = spaceObjectStore(space)
      const purge = async (atMs: number): Promise<string[]> =>
        await purgeChatAttachments({
          db,
          objects,
          uploadsDir: fixture.uploadsDir,
          now: new Date(fixture.now.getTime() + atMs)
        })
      expect(await purge(ORPHAN_AFTER_MS - 1000)).deep.equals([])
      const purged = await purge(ORPHAN_AFTER_MS + 1000)
      expect([...purged].sort()).to.include.members([orphan, unfinished])
      expect(purged).not.to.include(referenced)
      expect(await inSpace(attachmentKey(members, orphan))).equals(false)
      expect(await inSpace(attachmentKey(members, referenced))).equals(true)
      expect(
        await access(chatUploadDir(fixture.uploadsDir, unfinished)).then(
          () => true,
          () => false
        )
      ).equals(false)
      const left = await db
        .selectFrom('chat_attachments')
        .select('id')
        .where('id', 'in', [orphan, unfinished, referenced])
        .execute()
      expect(left.map(row => row.id)).deep.equals([referenced])
      // A member can still read the referenced one.
      ok(await fixture.call('C', 'GET', `/chat/attachments/${referenced}`))
    })

    it('purges, at any age, an attachment only cleared messages reference', async function () {
      cleared = await upload('C', small.blob, small.digest)
      const message = post('C', 'post', { attachmentIds: [cleared] })
      ok(await send('C', message), 201)
      // Cleared without a store, as a delete did before the Space was wired.
      await db
        .updateTable('chat_messages')
        .set({ cleared_at: fixture.now, ciphertext: new Uint8Array(0) })
        .where('id', '=', message.id)
        .execute()
      const purged = await purgeChatAttachments({
        db,
        objects: spaceObjectStore(space),
        uploadsDir: fixture.uploadsDir,
        now: fixture.now
      })
      expect(purged).deep.equals([cleared])
      expect(await inSpace(attachmentKey(members, cleared))).equals(false)
    })

    it('a moderator delete removes the object from the Space', async function () {
      const photo = await upload('C', small.blob, small.digest)
      const key = attachmentKey(members, photo)
      const message = post('C', 'post', { attachmentIds: [photo] })
      ok(await send('C', message), 201)
      expect(await inSpace(key)).equals(true)
      const removal = post('Hc', 'moderatorDelete', {
        targetIds: [message.id]
      })
      ok(await send('Hc', removal), 201)
      expect(await inSpace(key)).equals(false)
      expect(fixture.deletedObjects).to.include(key)
      expect(
        await db
          .selectFrom('chat_attachments')
          .select('id')
          .where('id', '=', photo)
          .executeTakeFirst()
      ).equals(undefined)
      expect(
        (await fixture.call('B', 'GET', `/chat/attachments/${photo}`)).status
      ).equals(404)
    })

    it('a post naming a purged attachment is refused', async function () {
      const late = await upload('C', small.blob, small.digest)
      await purgeChatAttachments({
        db,
        objects: spaceObjectStore(space),
        uploadsDir: fixture.uploadsDir,
        now: new Date(fixture.now.getTime() + ORPHAN_AFTER_MS + 1000)
      })
      refused(
        await send('C', post('C', 'post', { attachmentIds: [late] })),
        400,
        'attachment'
      )
    })

    it('keeps an attachment whose object would not delete, and says so', async function () {
      const stuck = await upload('C', small.blob, small.digest)
      const said: string[] = []
      const purged = await purgeChatAttachments({
        db,
        objects: {
          deleteObjects: async () => {
            throw new Error('the Space is away')
          }
        },
        uploadsDir: fixture.uploadsDir,
        now: new Date(fixture.now.getTime() + ORPHAN_AFTER_MS + 1000),
        log: message => said.push(message)
      })
      expect(purged).deep.equals([])
      expect(said).deep.equals([
        `purging chat attachment ${stuck}: Error: the Space is away`
      ])
      expect(await inSpace(attachmentKey(members, stuck))).equals(true)
    })

    it('startChatPurge sweeps with purgeReplacedRecordings off, whenever a Space is configured', async function () {
      const config = {
        space,
        uploadsDir: fixture.uploadsDir,
        purgeReplacedRecordings: false
      }
      const said: string[] = []
      const later = new Date(fixture.now.getTime() + ORPHAN_AFTER_MS + 1000)
      const handle = startChatPurge(db, config, {
        clock: () => later,
        intervalMs: 60_000,
        log: message => said.push(message)
      })
      expect(handle).not.equals(undefined)
      for (let wait = 0; wait < 100 && said.length === 0; wait++) {
        await new Promise(resolve => setTimeout(resolve, 20))
      }
      handle?.stop()
      expect(said).deep.equals(['purged 1 orphaned chat attachment(s)'])
      expect(await handle?.sweep()).deep.equals([])
      expect(await inSpace(attachmentKey(members, referenced))).equals(true)

      // No Space, no purge.
      expect(startChatPurge(db, { ...config, space: TEST_MEDIA.space })).equals(
        undefined
      )

      // A sweep that fails as a whole is logged, not thrown.
      const nowhere = makeDatabase('postgres://127.0.0.1:1/nowhere')
      const broken = startChatPurge(nowhere, config, {
        intervalMs: 60_000,
        log: message => said.push(message)
      })
      for (let wait = 0; wait < 200 && said.length === 1; wait++) {
        await new Promise(resolve => setTimeout(resolve, 20))
      }
      broken?.stop()
      await nowhere.destroy()
      expect(said[1]).matches(/^purging chat attachments: /)
    })
  })
})
