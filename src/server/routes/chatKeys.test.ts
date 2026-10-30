import { expect } from 'chai'
import type { Kysely } from 'kysely'
import { after, before, beforeEach, describe, it } from 'mocha'
import { Client } from 'pg'
import { base64url } from 'rfc4648'

import { equalBytes } from '../../common/chatCrypto/bytes'
import {
  openPreviousPukKeys,
  sealPreviousPukKeys,
  signPuk
} from '../../common/chatCrypto/chain'
import {
  hpkeOpen,
  hpkeSeal,
  type KeyPair,
  linkAad,
  pukAad
} from '../../common/chatCrypto/hpke'
import {
  type DeviceKeys,
  newDeviceKeys,
  newIdentityKey,
  newPukKey
} from '../../common/chatCrypto/keys'
import { linkCode } from '../../common/chatCrypto/linkCode'
import { verifiedPrefix } from '../../common/chatCrypto/logHash'
import { newIdentityId } from '../../common/chatCrypto/messageIds'
import { signResume } from '../../common/chatCrypto/resume'
import { makeId } from '../../common/ids'
import { closeInto } from '../admin/people'
import { actorForToken } from '../auth/sessions'
import {
  type Answer,
  type ChatFixture,
  openChatFixture
} from '../chat/chatTestFixture'
import { CHALLENGE_LIFETIME_MS, LINK_LIFETIME_MS } from '../chat/keys'
import type { Database } from '../db/database'

/**
 * U6 through the routes, with the real crypto of `common/chatCrypto` on the
 * "device" side: devices bound to sessions, enrolment (and the grant
 * requests it opens), PUK generations, linking, resume, revocation, identity
 * reset, and who may read whose keys.
 */

const b = (bytes: Uint8Array): string =>
  base64url.stringify(bytes, { pad: false })
const parse = (text: string): Uint8Array =>
  base64url.parse(text, { loose: true })

/** One device as the app would hold it. */
interface Device {
  who: string
  keys: DeviceKeys
  id: string
}

/** One user's keys as their linked devices hold them. */
interface Keys {
  userId: string
  identityId: string
  identity: KeyPair
  /** By generation: `puks[0]` is generation 1. */
  puks: KeyPair[]
}

describe('chat devices, identities and keys (U6)', function () {
  this.timeout(120000)
  let fixture: ChatFixture
  let db: Kysely<Database>
  let listener: Client
  let notes: unknown[] = []
  let sessionCount = 0

  before(async function () {
    const opened = await openChatFixture('keys', {
      leagueName: 'Harbor League'
    })
    if (opened == null) {
      this.skip()
      return
    }
    fixture = opened
    db = fixture.db
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
  ): Promise<Answer> => await fixture.call(who, method, path, body)

  const ok = (answer: Answer, status = 200): any => {
    expect(answer.status, JSON.stringify(answer.body)).equals(status)
    return answer.body
  }

  const refused = (answer: Answer, status: number, reason: string): void => {
    expect(answer.status, JSON.stringify(answer.body)).equals(status)
    expect(answer.body.details?.reason).equals(reason)
  }

  /** Lets the listener catch up with what was notified. */
  async function settle(): Promise<void> {
    await listener.query('select 1')
    await new Promise(resolve => setTimeout(resolve, 50))
  }

  /** A new session for `key`, as a second device signing in. */
  async function session(key: string): Promise<string> {
    sessionCount += 1
    const who = `${key}~${sessionCount}`
    await fixture.signIn(who, key)
    return who
  }

  async function register(who: string, name = who): Promise<Device> {
    const keys = newDeviceKeys()
    const body = ok(
      await call(who, 'POST', '/chat/devices', {
        name,
        platform: 'web',
        boxPublicKey: b(keys.box.publicKey),
        signPublicKey: b(keys.sign.publicKey)
      }),
      201
    )
    return { who, keys, id: body.id }
  }

  function pukBox(
    keys: Keys,
    generation: number,
    device: Device,
    secret = keys.puks[generation - 1].secretKey
  ): string {
    return b(
      hpkeSeal(
        'puk',
        device.keys.box.publicKey,
        pukAad({
          userId: keys.userId,
          identityId: keys.identityId,
          generation,
          deviceId: device.id
        }),
        secret
      )
    )
  }

  /** A fresh identity and PUK 1 for `key`, as the request body and the keys. */
  function newIdentity(
    key: string,
    device: Device,
    signer?: KeyPair
  ): { keys: Keys; body: Record<string, string> } {
    const keys: Keys = {
      userId: fixture.id(key),
      identityId: newIdentityId(),
      identity: newIdentityKey(),
      puks: [newPukKey()]
    }
    const body = {
      identityId: keys.identityId,
      identityPublicKey: b(keys.identity.publicKey),
      pukPublicKey: b(keys.puks[0].publicKey),
      pukSignature: b(
        signPuk(
          {
            userId: keys.userId,
            generation: 1,
            publicKey: keys.puks[0].publicKey
          },
          (signer ?? keys.identity).secretKey
        )
      ),
      box: pukBox(keys, 1, device)
    }
    return { keys, body }
  }

  /** Registers a device for `key`'s own session and enrols on it. */
  async function enrolled(
    key: string
  ): Promise<{ device: Device; keys: Keys }> {
    const device = await register(key)
    const { keys, body } = newIdentity(key, device)
    ok(await call(key, 'PUT', '/chat/identity', body), 201)
    return { device, keys }
  }

  /** The next PUK generation, boxed to these devices. */
  function nextPuk(keys: Keys, devices: Device[]): Record<string, unknown> {
    const generation = keys.puks.length + 1
    const puk = newPukKey()
    const body = {
      generation,
      publicKey: b(puk.publicKey),
      signature: b(
        signPuk(
          { userId: keys.userId, generation, publicKey: puk.publicKey },
          keys.identity.secretKey
        )
      ),
      previousKeysBox: b(
        sealPreviousPukKeys({
          userId: keys.userId,
          identityId: keys.identityId,
          generation,
          privateKey: puk.secretKey,
          older: keys.puks.map((older, index) => ({
            generation: index + 1,
            privateKey: older.secretKey
          }))
        })
      ),
      boxes: devices.map(device => ({
        deviceId: device.id,
        box: b(
          hpkeSeal(
            'puk',
            device.keys.box.publicKey,
            pukAad({
              userId: keys.userId,
              identityId: keys.identityId,
              generation,
              deviceId: device.id
            }),
            puk.secretKey
          )
        )
      }))
    }
    keys.puks.push(puk)
    return body
  }

  /** The approval a linked device sends for `link` to `device`. */
  function approval(
    keys: Keys,
    linkId: string,
    device: Device
  ): Record<string, unknown> {
    return {
      box: b(
        hpkeSeal(
          'link',
          device.keys.box.publicKey,
          linkAad({ linkId, newDeviceId: device.id }),
          keys.identity.secretKey
        )
      ),
      pukBoxes: keys.puks.map((_, index) => ({
        generation: index + 1,
        box: pukBox(keys, index + 1, device)
      }))
    }
  }

  /** A new device for `key` in a new session, linked from `from`. */
  async function linked(
    key: string,
    keys: Keys,
    from: Device
  ): Promise<Device> {
    const who = await session(key)
    const device = await register(who)
    const link = ok(await call(who, 'POST', '/chat/links'), 201)
    ok(
      await call(
        from.who,
        'POST',
        `/chat/links/${link.id}/approve`,
        approval(keys, link.id, device)
      )
    )
    return device
  }

  async function chatId(who: string, title: string): Promise<string> {
    const answer = ok(await call(who, 'GET', '/chat/conversations'))
    const chat = (answer as Array<{ id: string; title: string }>).find(
      item => item.title === title
    )
    if (chat == null) throw new Error(`${who} has no ${title}`)
    return chat.id
  }

  /** Writes epoch 1 of a conversation directly, as `keys`' user. */
  async function epochOne(conversationId: string, keys: Keys): Promise<void> {
    await db
      .insertInto('chat_epochs')
      .values({
        conversation_id: conversationId,
        epoch: 1,
        created_by_user_id: keys.userId,
        identity_id: keys.identityId,
        previous_key_box: null,
        chain_break: false,
        signature: new Uint8Array(64)
      })
      .execute()
  }

  async function needsRotation(conversationId: string): Promise<boolean> {
    const row = await db
      .selectFrom('chat_conversations')
      .select(['needs_rotation'])
      .where('id', '=', conversationId)
      .executeTakeFirstOrThrow()
    return row.needs_rotation
  }

  async function clearRotation(): Promise<void> {
    await db
      .updateTable('chat_conversations')
      .set({ needs_rotation: false })
      .execute()
  }

  const byConversation = (
    x: { conversationId: string },
    y: { conversationId: string }
  ): number => (x.conversationId < y.conversationId ? -1 : 1)

  async function openRequests(
    userId: string
  ): Promise<Array<{ conversationId: string; reset: boolean }>> {
    const rows = await db
      .selectFrom('chat_grant_requests')
      .select(['conversation_id', 'identity_reset'])
      .where('user_id', '=', userId)
      .where('filled_at', 'is', null)
      .where('superseded_at', 'is', null)
      .execute()
    return rows
      .map(row => ({
        conversationId: row.conversation_id,
        reset: row.identity_reset
      }))
      .sort(byConversation)
  }

  describe('devices and sessions', function () {
    it('binds a device to the session that registered it, one per session', async function () {
      const first = await register('C', 'Laptop')
      const row = await db
        .selectFrom('chat_devices')
        .selectAll()
        .where('id', '=', first.id)
        .executeTakeFirstOrThrow()
      expect(row.session_id).equals(fixture.sessionOf('C'))
      expect(row.user_id).equals(fixture.id('C'))
      expect(row.name).equals('Laptop')
      const listed = ok(await call('C', 'GET', '/chat/devices'))
      expect(listed).to.have.length(1)
      expect(listed[0]).to.include({
        id: first.id,
        current: true,
        linked: false,
        revokedAt: null,
        boxPublicKey: b(first.keys.box.publicKey),
        signPublicKey: b(first.keys.sign.publicKey)
      })
      await settle()
      expect(notes).deep.include({ u: fixture.id('C'), k: 'devices' })

      // The same session registering again takes the binding over.
      const second = await register('C', 'Laptop again')
      const both = ok(await call('C', 'GET', '/chat/devices'))
      expect(
        new Map(
          both.map((device: { id: string; current: boolean }) => [
            device.id,
            device.current
          ])
        )
      ).deep.equals(
        new Map([
          [first.id, false],
          [second.id, true]
        ])
      )
      expect(ok(await call('C', 'GET', '/chat/me/keys'))).deep.equals({
        deviceId: second.id,
        linked: false,
        identity: null,
        generations: [],
        pukNeedsRotation: false
      })
    })

    it('refuses an API token and an anonymous caller', async function () {
      await fixture.apiToken('C-token', 'C')
      const keys = newDeviceKeys()
      refused(
        await call('C-token', 'POST', '/chat/devices', {
          name: 'Robot',
          platform: 'web',
          boxPublicKey: b(keys.box.publicKey),
          signPublicKey: b(keys.sign.publicKey)
        }),
        403,
        'sessionRequired'
      )
      refused(
        await call('C-token', 'GET', '/chat/me/keys'),
        403,
        'sessionRequired'
      )
      refused(
        await call('C-token', 'GET', '/chat/devices'),
        403,
        'sessionRequired'
      )
      expect((await call('nobody', 'GET', '/chat/devices')).status).equals(401)
    })

    it('carries the session id on an actor signed in by session, not by token', async function () {
      const actor = await actorForToken(db, `tok_chat_C_${'0'.repeat(24)}`)
      expect(actor?.sessionId).equals(fixture.sessionOf('C'))
      const machine = await actorForToken(
        db,
        `tok_chat_C-token_${'1'.repeat(24)}`
      )
      expect(machine?.userId).equals(fixture.id('C'))
      expect(machine?.apiTokenId).match(/^atk_/)
      expect(machine?.sessionId).equals(undefined)
    })

    it('checks the device body', async function () {
      const keys = newDeviceKeys()
      const good = {
        name: 'Phone',
        platform: 'ios',
        boxPublicKey: b(keys.box.publicKey),
        signPublicKey: b(keys.sign.publicKey)
      }
      for (const bad of [
        { ...good, name: '' },
        { ...good, name: 'x'.repeat(101) },
        { ...good, platform: 'windows' },
        { ...good, boxPublicKey: b(new Uint8Array(31)) },
        { ...good, signPublicKey: '!!' }
      ]) {
        expect(
          (await call('D', 'POST', '/chat/devices', bad)).status,
          JSON.stringify(bad)
        ).equals(400)
      }
    })
  })

  describe('enrolment', function () {
    it('publishes the identity and PUK 1 once, boxed to the device', async function () {
      const who = await session('D2')
      const device = await register(who)
      const { keys, body } = newIdentity('D2', device)
      const made = ok(await call(who, 'PUT', '/chat/identity', body), 201)
      expect(made).deep.equals({
        identityId: keys.identityId,
        generation: 1,
        grantRequests: 0
      })
      refused(
        await call(
          who,
          'PUT',
          '/chat/identity',
          newIdentity('D2', device).body
        ),
        409,
        'identityExists'
      )

      const mine = ok(await call(who, 'GET', '/chat/me/keys'))
      expect(mine).to.include({ deviceId: device.id, linked: true })
      expect(mine.identity).to.include({
        id: keys.identityId,
        publicKey: b(keys.identity.publicKey)
      })
      expect(mine.generations).to.have.length(1)
      const opened = hpkeOpen(
        'puk',
        device.keys.box.secretKey,
        pukAad({
          userId: keys.userId,
          identityId: keys.identityId,
          generation: 1,
          deviceId: device.id
        }),
        parse(mine.generations[0].box)
      )
      expect(equalBytes(opened, keys.puks[0].secretKey)).equals(true)
      expect(mine.generations[0].previousKeysBox).equals(null)
      const listed = ok(await call(who, 'GET', '/chat/devices'))
      expect(listed[0]).to.include({ id: device.id, linked: true })
    })

    it('needs a device, a signature by the identity, and an unused id', async function () {
      const who = await session('D')
      const unbound = newIdentity('D', {
        who,
        keys: newDeviceKeys(),
        id: 'cdv_none'
      })
      refused(
        await call(who, 'PUT', '/chat/identity', unbound.body),
        403,
        'noDevice'
      )
      const device = await register(who)
      const forged = newIdentity('D', device, newIdentityKey())
      refused(
        await call(who, 'PUT', '/chat/identity', forged.body),
        400,
        'badSignature'
      )
      const wrongUser = newIdentity('D', device)
      wrongUser.body.pukSignature = b(
        signPuk(
          {
            userId: fixture.id('D2'),
            generation: 1,
            publicKey: wrongUser.keys.puks[0].publicKey
          },
          wrongUser.keys.identity.secretKey
        )
      )
      refused(
        await call(who, 'PUT', '/chat/identity', wrongUser.body),
        400,
        'badSignature'
      )
      const d2 = await db
        .selectFrom('chat_identities')
        .select(['id'])
        .where('user_id', '=', fixture.id('D2'))
        .executeTakeFirstOrThrow()
      const reused = newIdentity('D', device)
      reused.body.identityId = d2.id
      refused(
        await call(who, 'PUT', '/chat/identity', reused.body),
        409,
        'idTaken'
      )
      expect(
        (
          await call(who, 'PUT', '/chat/identity', {
            ...newIdentity('D', device).body,
            identityId: 'cid_short'
          })
        ).status
      ).equals(400)
      ok(
        await call(who, 'PUT', '/chat/identity', newIdentity('D', device).body),
        201
      )
    })

    it('opens a grant request in each of the user’s chats that has an epoch, and notifies grant', async function () {
      const ha = await enrolled('Ha')
      const staff = await chatId('Ha', 'Hawks Staff')
      const members = await chatId('Ha', 'Hawks Members')
      const announcements = await chatId(
        'Ha',
        'Spring 2027 - Harbor League Announcements'
      )
      await epochOne(staff, ha.keys)
      await epochOne(announcements, ha.keys)
      // Hs is in all three; only the two with an epoch have anything to grant.
      notes = []
      const hs = await register('Hs')
      const { body } = newIdentity('Hs', hs)
      const made = ok(await call('Hs', 'PUT', '/chat/identity', body), 201)
      expect(made.grantRequests).equals(2)
      expect(await openRequests(fixture.id('Hs'))).deep.equals(
        [
          { conversationId: staff, reset: false },
          { conversationId: announcements, reset: false }
        ].sort(byConversation)
      )
      await settle()
      expect(notes).deep.include({ c: staff, k: 'grant' })
      expect(notes).deep.include({ c: announcements, k: 'grant' })
      expect(notes).not.deep.include({ c: members, k: 'grant' })
    })
  })

  describe('per-user keys', function () {
    it('takes generation n+1 signed by the identity, boxed to exactly the linked devices', async function () {
      const { device, keys } = await enrolled('Hk')
      const second = await linked('Hk', keys, device)
      const pending = await register(await session('Hk'))
      const staff = await chatId('Hk', 'Hawks Staff')
      await clearRotation()

      const withPending = nextPuk(keys, [device, second, pending])
      keys.puks.pop()
      refused(await call('Hk', 'POST', '/chat/puk', withPending), 400, 'boxSet')
      const missing = nextPuk(keys, [device])
      keys.puks.pop()
      refused(await call('Hk', 'POST', '/chat/puk', missing), 400, 'boxSet')
      const twice = nextPuk(keys, [device, device, second])
      keys.puks.pop()
      refused(await call('Hk', 'POST', '/chat/puk', twice), 400, 'boxSet')
      const forged = nextPuk(keys, [device, second])
      keys.puks.pop()
      forged.signature = b(
        signPuk(
          {
            userId: keys.userId,
            generation: 2,
            publicKey: parse(forged.publicKey as string)
          },
          newIdentityKey().secretKey
        )
      )
      refused(
        await call('Hk', 'POST', '/chat/puk', forged),
        400,
        'badSignature'
      )
      const skipped = nextPuk(keys, [device, second])
      keys.puks.pop()
      refused(
        await call('Hk', 'POST', '/chat/puk', { ...skipped, generation: 3 }),
        409,
        'generationTaken'
      )
      expect(await needsRotation(staff)).equals(false)

      // Hk is in two chats with an epoch (Hawks Staff and Announcements):
      // generation 2 opens a request in each, and supersedes those at 1.
      const atOne = await openRequests(keys.userId)
      expect(atOne).to.have.length(2)
      notes = []
      const body = nextPuk(keys, [device, second])
      expect(
        ok(await call(second.who, 'POST', '/chat/puk', body), 201)
      ).deep.equals({
        generation: 2,
        grantRequests: 2
      })
      expect(await needsRotation(staff)).equals(true)
      const requests = await db
        .selectFrom('chat_grant_requests')
        .select(['generation', 'superseded_at'])
        .where('user_id', '=', keys.userId)
        .execute()
      expect(
        requests
          .map(row => `${row.generation}:${row.superseded_at != null}`)
          .sort()
      ).deep.equals(['1:true', '1:true', '2:false', '2:false'])
      await settle()
      expect(notes).deep.include({ u: keys.userId, k: 'devices' })
      refused(
        await call('Hk', 'POST', '/chat/puk', body),
        409,
        'generationTaken'
      )

      // Both linked devices open generation 2, and through it generation 1.
      for (const holder of [device, second]) {
        const mine = ok(await call(holder.who, 'GET', '/chat/me/keys'))
        expect(mine.linked).equals(true)
        expect(
          mine.generations.map((g: { generation: number }) => g.generation)
        ).deep.equals([1, 2])
        const secret = hpkeOpen(
          'puk',
          holder.keys.box.secretKey,
          pukAad({
            userId: keys.userId,
            identityId: keys.identityId,
            generation: 2,
            deviceId: holder.id
          }),
          parse(mine.generations[1].box)
        )
        expect(equalBytes(secret, keys.puks[1].secretKey)).equals(true)
        const older = openPreviousPukKeys({
          userId: keys.userId,
          identityId: keys.identityId,
          generation: 2,
          privateKey: secret,
          previousKeysBox: parse(mine.generations[1].previousKeysBox)
        })
        expect(older.map(key => key.generation)).deep.equals([1])
        expect(equalBytes(older[0].privateKey, keys.puks[0].secretKey)).equals(
          true
        )
      }
      // The pending device holds nothing, and may not post a generation.
      const pendingKeys = ok(await call(pending.who, 'GET', '/chat/me/keys'))
      expect(pendingKeys.linked).equals(false)
      expect(
        pendingKeys.generations.map((g: { box: string | null }) => g.box)
      ).deep.equals([null, null])
      const next = nextPuk(keys, [device, second])
      keys.puks.pop()
      refused(
        await call(pending.who, 'POST', '/chat/puk', next),
        403,
        'notHolder'
      )
    })

    it('refuses a session bound to a revoked device, or to none', async function () {
      const { device, keys } = await enrolled('Ek')
      const body = nextPuk(keys, [device])
      keys.puks.pop()
      const bare = await session('Ek')
      refused(await call(bare, 'POST', '/chat/puk', body), 403, 'notHolder')
      await db
        .updateTable('chat_devices')
        .set({ revoked_at: new Date() })
        .where('id', '=', device.id)
        .execute()
      refused(await call('Ek', 'POST', '/chat/puk', body), 403, 'notHolder')
    })
  })

  describe('linking', function () {
    it('links a device through a linked one, with every generation boxed', async function () {
      const { device, keys } = await enrolled('A')
      ok(await call('A', 'POST', '/chat/puk', nextPuk(keys, [device])), 201)
      const who = await session('A')
      const fresh = await register(who, 'Second browser')
      notes = []
      const link = ok(await call(who, 'POST', '/chat/links'), 201)
      expect(link).to.include({
        newDeviceId: fresh.id,
        approved: false,
        expired: false,
        box: null,
        approvedByDeviceId: null
      })
      expect(
        new Date(link.expiresAt).getTime() - new Date(link.createdAt).getTime()
      ).equals(LINK_LIFETIME_MS)
      await settle()
      expect(notes).deep.include({ u: keys.userId, k: 'link' })

      // The linked device sees it, and both sides compute the same digits.
      const pending = ok(await call('A', 'GET', '/chat/links'))
      expect(pending).to.have.length(1)
      expect(pending[0].newDevice).to.include({
        id: fresh.id,
        name: 'Second browser',
        platform: 'web'
      })
      expect(
        linkCode(parse(pending[0].newDevice.boxPublicKey), pending[0].id)
      ).equals(linkCode(fresh.keys.box.publicKey, link.id))

      // Not from the new device, nor another user, nor short a generation.
      refused(
        await call(
          who,
          'POST',
          `/chat/links/${link.id}/approve`,
          approval(keys, link.id, fresh)
        ),
        403,
        'notHolder'
      )
      expect(
        (
          await call(
            'B',
            'POST',
            `/chat/links/${link.id}/approve`,
            approval(keys, link.id, fresh)
          )
        ).status
      ).equals(404)
      expect((await call('B', 'GET', `/chat/links/${link.id}`)).status).equals(
        404
      )
      const short = approval(keys, link.id, fresh)
      short.pukBoxes = (short.pukBoxes as unknown[]).slice(1)
      refused(
        await call('A', 'POST', `/chat/links/${link.id}/approve`, short),
        400,
        'boxSet'
      )

      notes = []
      const approved = ok(
        await call(
          'A',
          'POST',
          `/chat/links/${link.id}/approve`,
          approval(keys, link.id, fresh)
        )
      )
      expect(approved).to.include({
        approved: true,
        approvedByDeviceId: device.id
      })
      await settle()
      expect(notes).deep.include({ u: keys.userId, k: 'link' })
      expect(notes).deep.include({ u: keys.userId, k: 'devices' })
      refused(
        await call(
          'A',
          'POST',
          `/chat/links/${link.id}/approve`,
          approval(keys, link.id, fresh)
        ),
        409,
        'linkApproved'
      )
      expect(ok(await call('A', 'GET', '/chat/links'))).deep.equals([])

      // The new device installs the identity and both generations.
      const polled = ok(await call(who, 'GET', `/chat/links/${link.id}`))
      const identitySecret = hpkeOpen(
        'link',
        fresh.keys.box.secretKey,
        linkAad({ linkId: link.id, newDeviceId: fresh.id }),
        parse(polled.box)
      )
      expect(equalBytes(identitySecret, keys.identity.secretKey)).equals(true)
      const mine = ok(await call(who, 'GET', '/chat/me/keys'))
      expect(mine.linked).equals(true)
      expect(mine.identity.publicKey).equals(b(keys.identity.publicKey))
      for (const generation of [1, 2]) {
        const secret = hpkeOpen(
          'puk',
          fresh.keys.box.secretKey,
          pukAad({
            userId: keys.userId,
            identityId: keys.identityId,
            generation,
            deviceId: fresh.id
          }),
          parse(mine.generations[generation - 1].box)
        )
        expect(equalBytes(secret, keys.puks[generation - 1].secretKey)).equals(
          true
        )
      }
      refused(await call(who, 'POST', '/chat/links'), 409, 'alreadyLinked')

      // The linked device approves the next link, and, once the enrolling
      // device is revoked, posts the next generation.
      const third = await linked('A', keys, fresh)
      ok(await call(who, 'DELETE', `/chat/devices/${device.id}`))
      ok(
        await call(who, 'POST', '/chat/puk', nextPuk(keys, [fresh, third])),
        201
      )
    })

    it('needs an identity and another linked device, and expires after 10 minutes', async function () {
      const lone = await session('Ea')
      await register(lone)
      refused(await call(lone, 'POST', '/chat/links'), 409, 'noIdentity')
      const { device, keys } = await enrolled('Ea')
      const who = await session('Ea')
      const fresh = await register(who)
      const link = ok(await call(who, 'POST', '/chat/links'), 201)

      const start = fixture.now
      try {
        fixture.now = new Date(start.getTime() + LINK_LIFETIME_MS)
        refused(
          await call(
            'Ea',
            'POST',
            `/chat/links/${link.id}/approve`,
            approval(keys, link.id, fresh)
          ),
          409,
          'linkExpired'
        )
        expect(ok(await call('Ea', 'GET', '/chat/links'))).deep.equals([])
        expect(ok(await call(who, 'GET', `/chat/links/${link.id}`))).to.include(
          {
            expired: true,
            approved: false
          }
        )
      } finally {
        fixture.now = start
      }

      // With the only linked device revoked, nobody is left to approve.
      const again = ok(await call(who, 'POST', '/chat/links'), 201)
      ok(await call('Ea', 'DELETE', `/chat/devices/${device.id}`))
      refused(await call(who, 'POST', '/chat/links'), 409, 'noLinkedDevice')
      expect(
        ok(await call(who, 'GET', '/chat/links')).map(
          (row: { id: string }) => row.id
        )
      ).to.include(again.id)
      expect(
        ok(await call(who, 'GET', `/chat/links/${again.id}`)).approved
      ).equals(false)
      const bare = await session('Ec')
      refused(await call(bare, 'POST', '/chat/links'), 403, 'noDevice')
      expect((await call(who, 'GET', '/chat/links/clk_none')).status).equals(
        404
      )
    })

    it('refuses to approve for a revoked new device', async function () {
      const { device, keys } = await enrolled('Es')
      const who = await session('Es')
      const fresh = await register(who)
      const link = ok(await call(who, 'POST', '/chat/links'), 201)
      ok(await call('Es', 'DELETE', `/chat/devices/${fresh.id}`))
      refused(
        await call(
          'Es',
          'POST',
          `/chat/links/${link.id}/approve`,
          approval(keys, link.id, fresh)
        ),
        403,
        'deviceRevoked'
      )
      expect(device.id).not.equals(fresh.id)
    })
  })

  describe('resume', function () {
    it('binds a device to a new session with a signed, single-use nonce', async function () {
      const { device, keys } = await enrolled('Ec')
      // The old session is gone; the person signs in again on the device.
      await db
        .updateTable('auth_sessions')
        .set({ revoked_at: new Date() })
        .where('id', '=', fixture.sessionOf('Ec'))
        .execute()
      expect((await call('Ec', 'GET', '/chat/me/keys')).status).equals(401)
      const who = await session('Ec')
      const unbound = ok(await call(who, 'GET', '/chat/me/keys'))
      expect(unbound).to.include({ deviceId: null, linked: false })

      const challenge = ok(
        await call(who, 'POST', `/chat/devices/${device.id}/resume-challenge`)
      )
      expect(challenge.sessionId).equals(fixture.sessionOf(who))
      expect(parse(challenge.nonce)).to.have.length(32)
      const signed = (
        nonce: string,
        sessionId = fixture.sessionOf(who),
        secret = device.keys.sign.secretKey
      ): { nonce: string; signature: string } => ({
        nonce,
        signature: b(
          signResume(
            { nonce: parse(nonce), deviceId: device.id, sessionId },
            secret
          )
        )
      })

      const resumed = ok(
        await call(
          who,
          'POST',
          `/chat/devices/${device.id}/resume`,
          signed(challenge.nonce)
        )
      )
      expect(resumed).to.include({ id: device.id, current: true, linked: true })
      const bound = ok(await call(who, 'GET', '/chat/me/keys'))
      expect(bound).to.include({ deviceId: device.id, linked: true })
      expect(bound.identity.id).equals(keys.identityId)

      // A nonce is good once.
      refused(
        await call(
          who,
          'POST',
          `/chat/devices/${device.id}/resume`,
          signed(challenge.nonce)
        ),
        403,
        'badChallenge'
      )
      // A signature for another session, or by another key, fails — and
      // spends the nonce.
      const other = ok(
        await call(who, 'POST', `/chat/devices/${device.id}/resume-challenge`)
      )
      refused(
        await call(
          who,
          'POST',
          `/chat/devices/${device.id}/resume`,
          signed(other.nonce, 'ses_other')
        ),
        403,
        'badSignature'
      )
      refused(
        await call(
          who,
          'POST',
          `/chat/devices/${device.id}/resume`,
          signed(other.nonce)
        ),
        403,
        'badChallenge'
      )
      const third = ok(
        await call(who, 'POST', `/chat/devices/${device.id}/resume-challenge`)
      )
      refused(
        await call(
          who,
          'POST',
          `/chat/devices/${device.id}/resume`,
          signed(third.nonce, undefined, newDeviceKeys().sign.secretKey)
        ),
        403,
        'badSignature'
      )
      // A nonce of another device, or a made-up one, is no challenge.
      refused(
        await call(
          who,
          'POST',
          `/chat/devices/${device.id}/resume`,
          signed(b(new Uint8Array(32)))
        ),
        403,
        'badChallenge'
      )

      // An expired nonce.
      const late = ok(
        await call(who, 'POST', `/chat/devices/${device.id}/resume-challenge`)
      )
      expect(new Date(late.expiresAt).getTime() - fixture.now.getTime()).equals(
        CHALLENGE_LIFETIME_MS
      )
      ok(await call(who, 'POST', `/chat/devices/${device.id}/resume-challenge`))
      const start = fixture.now
      try {
        fixture.now = new Date(start.getTime() + CHALLENGE_LIFETIME_MS)
        refused(
          await call(
            who,
            'POST',
            `/chat/devices/${device.id}/resume`,
            signed(late.nonce)
          ),
          403,
          'badChallenge'
        )
        // Expired nonces are swept when the next is handed out.
        ok(
          await call(who, 'POST', `/chat/devices/${device.id}/resume-challenge`)
        )
        const left = await db
          .selectFrom('chat_resume_challenges')
          .select(['expires_at'])
          .where('device_id', '=', device.id)
          .execute()
        expect(left).to.have.length(1)
      } finally {
        fixture.now = start
      }
    })

    it('refuses a revoked device, another user’s device and an unknown one', async function () {
      const { device } = await enrolled('S')
      const second = await register(await session('S'))
      const who = await session('S')
      const challenge = {
        nonce: b(new Uint8Array(32)),
        signature: b(new Uint8Array(64))
      }
      refused(
        await call('K', 'POST', `/chat/devices/${device.id}/resume-challenge`),
        403,
        'unknownDevice'
      )
      refused(
        await call('K', 'POST', `/chat/devices/${device.id}/resume`, challenge),
        403,
        'unknownDevice'
      )
      refused(
        await call(who, 'POST', '/chat/devices/cdv_nothing/resume-challenge'),
        403,
        'unknownDevice'
      )
      ok(await call('S', 'DELETE', `/chat/devices/${second.id}`))
      refused(
        await call(who, 'POST', `/chat/devices/${second.id}/resume-challenge`),
        403,
        'deviceRevoked'
      )
      refused(
        await call(who, 'POST', `/chat/devices/${second.id}/resume`, challenge),
        403,
        'deviceRevoked'
      )
    })
  })

  describe('revocation', function () {
    it('lets a device revoke itself, which ends its session', async function () {
      const who = await session('B')
      const device = await register(who)
      const revoked = ok(
        await call(who, 'DELETE', `/chat/devices/${device.id}`)
      )
      expect(revoked.revokedAt).not.equals(null)
      expect(revoked.current).equals(false)
      expect((await call(who, 'GET', '/chat/devices')).status).equals(401)
      // Revoking again changes nothing.
      expect(
        ok(await call('B', 'DELETE', `/chat/devices/${device.id}`)).revokedAt
      ).equals(revoked.revokedAt)
      expect(
        (await call('B', 'DELETE', '/chat/devices/cdv_nothing')).status
      ).equals(404)
      expect(
        (await call('C', 'DELETE', `/chat/devices/${device.id}`)).status
      ).equals(404)
    })

    it('kills the revoked device’s session and flags rotation, until the next generation', async function () {
      const { device, keys } = await enrolled('L')
      const second = await linked('L', keys, device)
      const pending = await register(await session('L'))
      const org = await chatId('L', 'Harbor League Org')
      await clearRotation()

      // A pending device may revoke only itself.
      refused(
        await call(pending.who, 'DELETE', `/chat/devices/${second.id}`),
        403,
        'notHolder'
      )
      notes = []
      ok(await call('L', 'DELETE', `/chat/devices/${second.id}`))
      expect((await call(second.who, 'GET', '/chat/me/keys')).status).equals(
        401
      )
      const ended = await db
        .selectFrom('auth_sessions')
        .select(['revoked_at'])
        .where('id', '=', fixture.sessionOf(second.who))
        .executeTakeFirstOrThrow()
      expect(ended.revoked_at).not.equals(null)
      expect(await needsRotation(org)).equals(true)
      await settle()
      expect(notes).deep.include({ u: keys.userId, k: 'devices' })
      expect(
        ok(await call('L', 'GET', '/chat/me/keys')).pukNeedsRotation
      ).equals(true)
      const listed = ok(await call('L', 'GET', '/chat/devices'))
      expect(
        listed.find((row: { id: string }) => row.id === second.id)
      ).to.include({ linked: false })

      // The next generation leaves it out (boxing it is refused).
      const withRevoked = nextPuk(keys, [device, second])
      keys.puks.pop()
      refused(await call('L', 'POST', '/chat/puk', withRevoked), 400, 'boxSet')
      ok(await call('L', 'POST', '/chat/puk', nextPuk(keys, [device])), 201)
      expect(
        ok(await call('L', 'GET', '/chat/me/keys')).pukNeedsRotation
      ).equals(false)

      // Revoking a device that never held keys flags nothing.
      await clearRotation()
      ok(await call('L', 'DELETE', `/chat/devices/${pending.id}`))
      expect(await needsRotation(org)).equals(false)
    })

    it('keeps the session only for the device bound to it, when asked', async function () {
      await fixture.person('Rk')
      const { device, keys } = await enrolled('Rk')
      const second = await linked('Rk', keys, device)
      const other = await register(await session('Rk'))

      // Another device's session always ends with it, holder or not.
      refused(
        await call(
          'Rk',
          'DELETE',
          `/chat/devices/${second.id}?keepSession=true`
        ),
        403,
        'notThisDevice'
      )
      refused(
        await call(
          other.who,
          'DELETE',
          `/chat/devices/${device.id}?keepSession=true`
        ),
        403,
        'notThisDevice'
      )
      expect(
        ok(await call('Rk', 'GET', '/chat/devices')).filter(
          (row: { revokedAt: string | null }) => row.revokedAt != null
        )
      ).deep.equals([])

      // Its own: revoked, unbound, and the session stays signed in.
      const revoked = ok(
        await call(
          second.who,
          'DELETE',
          `/chat/devices/${second.id}?keepSession=true`
        )
      )
      expect(revoked.revokedAt).not.equals(null)
      expect(revoked.current).equals(false)
      const mine = ok(await call(second.who, 'GET', '/chat/me/keys'))
      expect(mine.deviceId).equals(null)
      expect(mine.pukNeedsRotation).equals(true)
      const kept = await db
        .selectFrom('auth_sessions')
        .select(['revoked_at'])
        .where('id', '=', fixture.sessionOf(second.who))
        .executeTakeFirstOrThrow()
      expect(kept.revoked_at).equals(null)
      // The same session registers a new device, which the server does not
      // count as linked.
      const fresh = await register(second.who)
      const listed = ok(await call(second.who, 'GET', '/chat/devices'))
      expect(
        listed.find((row: { id: string }) => row.id === fresh.id)
      ).to.include({ current: true, linked: false })
      expect(
        listed.find((row: { id: string }) => row.id === second.id)
      ).to.include({ linked: false })
    })
  })

  describe('identity reset', function () {
    it('replaces the identity, logs it, revokes the other devices and flags rotation', async function () {
      const { device, keys } = await enrolled('Hc')
      const second = await linked('Hc', keys, device)
      const staff = await chatId('Hc', 'Hawks Staff')
      const members = await chatId('Hc', 'Hawks Members')
      const conversations = (
        await db
          .selectFrom('chat_members')
          .select(['conversation_id'])
          .where('user_id', '=', keys.userId)
          .where('left_at', 'is', null)
          .execute()
      ).map(row => row.conversation_id)
      // Hawks Staff and Announcements have an epoch (written above as Ha's),
      // so Hc's enrolment opened a request in each.
      const withEpoch = (
        await db
          .selectFrom('chat_epochs')
          .select(['conversation_id'])
          .where('conversation_id', 'in', conversations)
          .execute()
      ).map(row => row.conversation_id)
      expect(withEpoch).to.include(staff)
      expect(await openRequests(keys.userId)).deep.equals(
        withEpoch
          .map(conversationId => ({ conversationId, reset: false }))
          .sort(byConversation)
      )
      await clearRotation()

      const who = await session('Hc')
      const hand = await register(who, 'Phone in hand')
      const fresh = newIdentity('Hc', hand)
      notes = []
      const reset = ok(
        await call(who, 'POST', '/chat/identity/reset', fresh.body),
        201
      )
      expect(reset).to.deep.include({
        identityId: fresh.keys.identityId,
        generation: 1
      })
      expect(new Set(reset.revokedDeviceIds)).deep.equals(
        new Set([device.id, second.id])
      )

      // The old identity is replaced, the new one current.
      const identities = await db
        .selectFrom('chat_identities')
        .select(['id', 'replaced_at'])
        .where('user_id', '=', keys.userId)
        .orderBy('created_at')
        .execute()
      expect(
        identities.map(row => [row.id, row.replaced_at != null])
      ).deep.equals([
        [keys.identityId, true],
        [fresh.keys.identityId, false]
      ])
      const mine = ok(await call(who, 'GET', '/chat/me/keys'))
      expect(mine).to.include({ deviceId: hand.id, linked: true })
      expect(mine.identity.publicKey).equals(b(fresh.keys.identity.publicKey))

      // Every other device is revoked and its session ended.
      for (const gone of [device, second]) {
        expect((await call(gone.who, 'GET', '/chat/me/keys')).status).equals(
          401
        )
      }
      const listed = ok(await call(who, 'GET', '/chat/devices'))
      expect(
        listed
          .filter((row: { revokedAt: string | null }) => row.revokedAt == null)
          .map((row: { id: string }) => row.id)
      ).deep.equals([hand.id])

      // Every chat of Hc's: an identityReset row (the chain still verifies),
      // a new epoch flagged; a reset request where there is an epoch; the old
      // identity's request superseded.
      for (const id of conversations) {
        expect(await needsRotation(id), id).equals(true)
        const rows = ok(await call(who, 'GET', `/chat/conversations/${id}/log`))
        const last = rows[rows.length - 1]
        expect(last).to.include({
          event: 'identityReset',
          userId: keys.userId,
          actorUserId: keys.userId,
          reason: null
        })
        expect(
          verifiedPrefix(
            new Uint8Array(32),
            rows.map((row: any) => ({
              conversationId: id,
              seq: row.seq,
              event: row.event,
              userId: row.userId,
              actorUserId: row.actorUserId,
              reason: row.reason,
              at: row.at,
              prevHash: parse(row.prevHash),
              hash: parse(row.hash)
            }))
          )
        ).equals(rows.length)
      }
      expect(await openRequests(keys.userId)).deep.equals(
        withEpoch
          .map(conversationId => ({ conversationId, reset: true }))
          .sort(byConversation)
      )
      const superseded = await db
        .selectFrom('chat_grant_requests')
        .select(['superseded_at'])
        .where('user_id', '=', keys.userId)
        .where('identity_id', '=', keys.identityId)
        .execute()
      expect(superseded).to.have.length(withEpoch.length)
      expect(superseded.every(row => row.superseded_at != null)).equals(true)
      await settle()
      expect(notes).deep.include({ c: staff, k: 'grant' })
      expect(notes).deep.include({ c: members, k: 'members' })
      expect(notes).deep.include({ u: keys.userId, k: 'devices' })

      // The member list now shows the new key, not eligible in Hawks Staff.
      const listedMembers = ok(
        await call('Ha', 'GET', `/chat/conversations/${staff}/members`)
      )
      expect(
        listedMembers.find(
          (row: { userId: string }) => row.userId === keys.userId
        )
      ).to.include({
        identityKey: b(fresh.keys.identity.publicKey),
        hasIdentity: true,
        eligible: false
      })

      // The replaced identity still answers, with replacedAt.
      const old = ok(
        await call('Ha', 'GET', `/chat/identities/${keys.identityId}`)
      )
      expect(old).to.include({
        id: keys.identityId,
        userId: keys.userId,
        publicKey: b(keys.identity.publicKey)
      })
      expect(old.replacedAt).not.equals(null)
      expect(
        ok(await call('Ha', 'GET', `/chat/identities/${fresh.keys.identityId}`))
          .replacedAt
      ).equals(null)

      // A new PUK generation does not escape the approval: the request it
      // opens in place of the reset one is still a reset request.
      ok(await call(who, 'POST', '/chat/puk', nextPuk(fresh.keys, [hand])), 201)
      expect(await openRequests(keys.userId)).deep.equals(
        withEpoch
          .map(conversationId => ({ conversationId, reset: true }))
          .sort(byConversation)
      )
      const atTwo = await db
        .selectFrom('chat_grant_requests')
        .select(['generation'])
        .where('user_id', '=', keys.userId)
        .where('filled_at', 'is', null)
        .where('superseded_at', 'is', null)
        .execute()
      expect(atTwo.map(row => row.generation)).deep.equals(
        withEpoch.map(() => 2)
      )
      expect(
        ok(
          await call('Ha', 'GET', `/chat/conversations/${staff}/members`)
        ).find((row: { userId: string }) => row.userId === keys.userId)
      ).to.include({ eligible: false })
    })

    it('needs an identity to reset, a device, and a good signature', async function () {
      const who = await session('Hs')
      refused(
        await call(who, 'POST', '/chat/identity/reset', {
          ...newIdentity('Hs', { who, keys: newDeviceKeys(), id: 'cdv_x' }).body
        }),
        403,
        'noDevice'
      )
      const hand = await register(who)
      refused(
        await call(
          who,
          'POST',
          '/chat/identity/reset',
          newIdentity('Hs', hand, newIdentityKey()).body
        ),
        400,
        'badSignature'
      )
      const nobody = await session('N')
      const nDevice = await register(nobody)
      refused(
        await call(
          nobody,
          'POST',
          '/chat/identity/reset',
          newIdentity('N', nDevice).body
        ),
        409,
        'noIdentity'
      )
    })
  })

  describe('reading other people’s keys', function () {
    it('answers for anybody who is or was in a chat the caller is in now, and 404 otherwise', async function () {
      // Ha (enrolled above) and Hk share Hawks Staff.
      const ha = ok(
        await call('Hk', 'GET', `/chat/users/${fixture.id('Ha')}/keys`)
      )
      expect(ha.userId).equals(fixture.id('Ha'))
      expect(ha.identity.id).match(/^cid_/)
      expect(ha.puk).to.include({ generation: 1 })
      const identity = ok(
        await call('Hk', 'GET', `/chat/identities/${ha.identity.id}`)
      )
      expect(identity).to.include({
        id: ha.identity.id,
        userId: fixture.id('Ha'),
        publicKey: ha.identity.publicKey,
        replacedAt: null
      })
      // Somebody with no identity answers with nulls.
      expect(
        ok(await call('Ha', 'GET', `/chat/users/${fixture.id('P')}/keys`))
      ).deep.equals({ userId: fixture.id('P'), identity: null, puk: null })
      // Oneself, always.
      expect(
        ok(await call('Ha', 'GET', `/chat/users/${fixture.id('Ha')}/keys`))
          .identity.id
      ).equals(ha.identity.id)

      // Fan F shares no chat with Eagles coach Ec.
      const f = await enrolled('F')
      const ec = await session('Ec')
      expect(
        (await call(ec, 'GET', `/chat/users/${fixture.id('F')}/keys`)).status
      ).equals(404)
      expect(
        (await call(ec, 'GET', `/chat/identities/${f.keys.identityId}`)).status
      ).equals(404)
      expect(
        (await call(ec, 'GET', '/chat/identities/cid_nothing')).status
      ).equals(404)
      expect((await call(ec, 'GET', '/chat/users/nobody/keys')).status).equals(
        404
      )

      // Hawks scorekeeper Hk starts a DM with F and Ec, and Ec leaves it: F
      // can still read the keys of Ec, who was in a chat F is in now; Ec,
      // no longer in it, cannot read F's.
      const made = await call('Hk', 'POST', '/chat/dms', {
        userIds: [fixture.id('F'), fixture.id('Ec')]
      })
      expect(made.status, JSON.stringify(made.body)).equals(201)
      ok(await call('F', 'GET', `/chat/users/${fixture.id('Ec')}/keys`))
      ok(await call(ec, 'DELETE', `/chat/dms/${made.body.id}/members/me`))
      const left = ok(
        await call('F', 'GET', `/chat/users/${fixture.id('Ec')}/keys`)
      )
      expect(left.userId).equals(fixture.id('Ec'))
      expect(left.identity.id).match(/^cid_/)
      expect(
        ok(await call('F', 'GET', `/chat/identities/${left.identity.id}`))
          .userId
      ).equals(fixture.id('Ec'))
      expect(
        (await call(ec, 'GET', `/chat/users/${fixture.id('F')}/keys`)).status
      ).equals(404)
    })
  })
  describe('merges', function () {
    it('opens the survivor’s grant request in a merged DM when the survivor enrols', async function () {
      const survivor = await fixture.person('Y')
      const closing = await fixture.person('Y2')
      await db
        .insertInto('memberships')
        .values({
          id: makeId('membership'),
          user_id: closing,
          team_id: fixture.seed.teams.hawks,
          role: 'member',
          is_player: false
        })
        .execute()
      await fixture.drain()
      const made = await call('Hk', 'POST', '/chat/dms', { userIds: [closing] })
      expect(made.status, JSON.stringify(made.body)).equals(201)
      const hk = await db
        .selectFrom('chat_identities')
        .select(['id'])
        .where('user_id', '=', fixture.id('Hk'))
        .where('replaced_at', 'is', null)
        .executeTakeFirstOrThrow()
      await db
        .insertInto('chat_epochs')
        .values({
          conversation_id: made.body.id,
          epoch: 1,
          created_by_user_id: fixture.id('Hk'),
          identity_id: hk.id,
          previous_key_box: null,
          chain_break: false,
          signature: new Uint8Array(64)
        })
        .execute()

      await closeInto(db, closing, survivor)
      // The survivor is in the DM, with no identity and so no request yet.
      const members = await db
        .selectFrom('chat_members')
        .select(['user_id'])
        .where('conversation_id', '=', made.body.id)
        .where('left_at', 'is', null)
        .execute()
      expect(members.map(row => row.user_id)).to.include(survivor)
      expect(await openRequests(survivor)).deep.equals([])

      notes = []
      const device = await register('Y')
      const { body } = newIdentity('Y', device)
      const enrolledNow = ok(
        await call('Y', 'PUT', '/chat/identity', body),
        201
      )
      expect(enrolledNow.grantRequests).equals(1)
      expect(await openRequests(survivor)).deep.equals([
        { conversationId: made.body.id, reset: false }
      ])
      await settle()
      expect(notes).deep.include({ c: made.body.id, k: 'grant' })
    })
  })
})
