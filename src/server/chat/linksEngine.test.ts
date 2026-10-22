import { expect } from 'chai'
import { after, before, describe, it } from 'mocha'

import {
  approveLink,
  type ChatKeysClient,
  type ChatSetup,
  ensureEnrolled,
  leaveChat,
  ownLinkCode,
  pendingLinkCode,
  pollLink,
  reasonOf,
  resetIdentity,
  resetUnreadableChat,
  revokeOtherDevice,
  rotatePuk,
  spacedCode,
  startLink
} from '../../app/chat/engine/links'
import {
  b64,
  type ChatKeyRecord,
  type ChatKeyStore,
  newRecord,
  recordFromJson,
  recordToJson,
  UnreadableKeyRecordError,
  withEpochKey
} from '../../app/chat/keyRecord'
import { type ChatMyKeys, TeamStationClient } from '../../common/api'
import type { ChatCoreStatus } from '../../common/chatCrypto/coreCall'
import { newDeviceKeys } from '../../common/chatCrypto/keys'
import { HttpError } from '../../common/errors'
import { userIdOfGumbo } from '../../common/userId'
import { type ChatFixture, openChatFixture } from './chatTestFixture'

/**
 * U11: enrolment, linking, resume, reset, revocation and sign-out, run by
 * the app's own engine (`src/app/chat/engine/links.ts`) against the real key
 * routes on a scratch database. It sits with the server's tests because it
 * runs the server, which the app's browser typecheck cannot hold.
 * Each device is a session of the fixture and a store of its own.
 */

/** A store in memory, written through the same JSON the real ones keep. */
class MemoryStore implements ChatKeyStore {
  text: string | undefined
  wipes = 0
  async load(): Promise<ChatKeyRecord | undefined> {
    return this.text == null ? undefined : recordFromJson(this.text)
  }

  async save(record: ChatKeyRecord): Promise<void> {
    this.text = recordToJson(record)
  }

  async wipe(): Promise<void> {
    this.wipes += 1
    this.text = undefined
  }

  async exists(): Promise<boolean> {
    return this.text != null
  }
}

describe('chat keys on the device', function () {
  let fixture: ChatFixture | undefined

  before(async function () {
    this.timeout(60000)
    fixture = await openChatFixture('links')
    if (fixture == null) this.skip()
  })

  after(async function () {
    await fixture?.close()
  })

  const f = (): ChatFixture => {
    if (fixture == null) throw new Error('no fixture')
    return fixture
  }

  const clientOf = (who: string): TeamStationClient =>
    new TeamStationClient({ baseUrl: f().api, token: f().tokenOf(who) })

  const devices = new Map<string, ChatSetup & { store: MemoryStore }>()

  it('opens an actually enrolled saved numeric record as the same migrated device without wiping or enrolling', async () => {
    await f().person('legacy', { userId: userIdOfGumbo(42) })
    const setup = deviceOf('legacy', 'legacy')
    const enrolled = await ensureEnrolled(setup)
    expect(enrolled.state).equals('ready')
    const before = recordToJson(enrolled.record)
    const raw = JSON.parse(before)
    raw.version = 1
    raw.userId = 42
    // This device enrolled before the account cutover, with its same keys.
    setup.store.text = JSON.stringify(raw)
    const counts = async (): Promise<{
      devices: Array<{ id: string }>
      identities: unknown[]
    }> => ({
      devices: await f()
        .db.selectFrom('chat_devices')
        .select('id')
        .where('user_id', '=', userIdOfGumbo(42))
        .execute(),
      identities: await f()
        .db.selectFrom('chat_identities')
        .selectAll()
        .where('user_id', '=', userIdOfGumbo(42))
        .execute()
    })
    const saved = await counts()
    const reopened = await ensureEnrolled(setup)
    expect(reopened.state).equals('ready')
    expect(recordToJson(reopened.record)).equals(before)
    expect(setup.store.wipes).equals(0)
    expect(await counts()).deep.equals(saved)
    expect((await setup.store.load())?.deviceId).equals(
      enrolled.record.deviceId
    )
  })

  /**
   * One device: a session (`who`) of `key`, with a store. The same `who`
   * is the same device from one case to the next, unless a store is given.
   */
  function deviceOf(
    who: string,
    key: string,
    store?: MemoryStore
  ): ChatSetup & { store: MemoryStore } {
    const known = devices.get(who)
    if (known != null && store == null) return known
    const device = {
      client: clientOf(who),
      store: store ?? new MemoryStore(),
      userId: f().id(key),
      device: { name: who, platform: 'web' as const }
    }
    if (store == null) devices.set(who, device)
    return device
  }

  /** A new session for `key`, as the person signing in again. */
  async function session(who: string, key: string): Promise<string> {
    await f().signIn(who, key)
    return who
  }

  async function refusal(work: Promise<unknown>): Promise<unknown> {
    try {
      await work
    } catch (error) {
      return error
    }
    throw new Error('expected a refusal')
  }

  it('enrols once, and a second look finds the device ready', async function () {
    const one = deviceOf('C', 'C')
    const first = await ensureEnrolled(one)
    expect(first.state).equals('ready')
    expect(first.record.identity?.id).matches(/^cid_/)
    expect(first.record.puks.map(puk => puk.generation)).deep.equals([1])
    const mine = await one.client.myChatKeys()
    expect(mine.linked).equals(true)
    expect(mine.identity?.id).equals(first.record.identity?.id)
    expect(mine.identity?.publicKey).equals(
      b64(first.record.identity!.keys.publicKey)
    )
    const again = await ensureEnrolled(one)
    expect(again.state).equals('ready')
    expect(again.record.deviceId).equals(first.record.deviceId)
    expect(await one.client.chatDevices()).length(1)
  })

  it('registers one device when two screens ask at once', async function () {
    const one = deviceOf('A', 'A')
    const [a, b] = await Promise.all([ensureEnrolled(one), ensureEnrolled(one)])
    expect(a.record.deviceId).equals(b.record.deviceId)
    expect(await one.client.chatDevices()).length(1)
  })

  it('links a second device by the six digits, and both hold the same keys', async function () {
    const one = deviceOf('B', 'B')
    const ready = await ensureEnrolled(one)
    expect(ready.state).equals('ready')

    const two = deviceOf(await session('B~2', 'B'), 'B')
    const asking = await ensureEnrolled(two)
    expect(asking.state).equals('link')
    expect(asking.record.identity).equals(undefined)
    const started = await startLink(two, asking.record)
    expect(started.code).matches(/^\d{6}$/)
    expect(started.record.pendingLinkId).equals(started.link.id)
    // Asked again before an answer, it is the same request.
    const same = await startLink(two, started.record)
    expect(same.link.id).equals(started.link.id)
    expect((await pollLink(two, started.record)).state).equals('waiting')

    // The old device sees the request with the very same digits.
    const pending = await one.client.chatLinks()
    expect(pending).length(1)
    expect(pendingLinkCode(pending[0])).equals(started.code)
    expect(ownLinkCode(started.record, started.link.id)).equals(started.code)
    await approveLink(one, ready.record, pending[0])

    const polled = await pollLink(two, started.record)
    expect(polled.state).equals('installed')
    if (polled.state !== 'installed') return
    const linked = polled.record
    expect(linked.pendingLinkId).equals(undefined)
    expect(linked.identity?.id).equals(ready.record.identity?.id)
    expect(b64(linked.identity!.keys.secretKey)).equals(
      b64(ready.record.identity!.keys.secretKey)
    )
    expect(linked.puks.map(puk => b64(puk.keys.secretKey))).deep.equals(
      ready.record.puks.map(puk => b64(puk.keys.secretKey))
    )
    const listed = await two.client.chatDevices()
    expect(listed.filter(device => device.linked)).length(2)
    const keysOne = await one.client.myChatKeys()
    const keysTwo = await two.client.myChatKeys()
    expect(keysTwo.identity?.publicKey).equals(keysOne.identity?.publicKey)
    expect((await ensureEnrolled(two)).state).equals('ready')
  })

  it('installs an approved link when Chat opens again, and lets a link expire', async function () {
    const one = deviceOf('B', 'B')
    const ready = await ensureEnrolled(one)
    const three = deviceOf(await session('B~3', 'B'), 'B')
    const asking = await ensureEnrolled(three)
    const started = await startLink(three, asking.record)
    const [pending] = (await one.client.chatLinks()).filter(
      link => link.id === started.link.id
    )
    await approveLink(one, ready.record, pending)
    const opened = await ensureEnrolled(three)
    expect(opened.state).equals('ready')
    expect(opened.record.identity?.id).equals(ready.record.identity?.id)

    // A fourth device asks and nobody answers for ten minutes.
    const four = deviceOf(await session('B~4', 'B'), 'B')
    const waiting = await startLink(four, (await ensureEnrolled(four)).record)
    const held = f().now
    f().now = new Date(held.getTime() + 11 * 60_000)
    try {
      const expired = await pollLink(four, waiting.record)
      expect(expired.state).equals('expired')
      if (expired.state !== 'expired') return
      expect(expired.record.pendingLinkId).equals(undefined)
      expect((await four.store.load())?.pendingLinkId).equals(undefined)
      // Asking again opens a new request with its own digits.
      const again = await startLink(four, expired.record)
      expect(again.link.id).not.equals(waiting.link.id)
      expect(again.code).equals(ownLinkCode(again.record, again.link.id))
      // An expired request found while starting is replaced too.
      f().now = new Date(f().now.getTime() + 11 * 60_000)
      const third = await startLink(four, again.record)
      expect(third.link.id).not.equals(again.link.id)
      // On the next look, the device asks again and is still linking.
      expect((await ensureEnrolled(four)).state).equals('link')
    } finally {
      f().now = held
    }
    // No request at all, or one the server does not know, reads as expired.
    const none = await pollLink(four, {
      ...waiting.record,
      pendingLinkId: undefined
    })
    expect(none.state).equals('expired')
    const unknown = await pollLink(four, {
      ...waiting.record,
      pendingLinkId: 'clk_unknown'
    })
    expect(unknown.state).equals('expired')
  })

  it('removes another device and moves the per-user key on', async function () {
    const one = deviceOf('B', 'B')
    const ready = await ensureEnrolled(one)
    const devices = await one.client.chatDevices()
    const pendingFour = devices.find(device => device.name === 'B~4')
    const linkedTwo = devices.find(device => device.name === 'B~2')
    expect(pendingFour?.linked).equals(false)
    expect(linkedTwo?.linked).equals(true)

    // A device never linked held no key: nothing to move on.
    const kept = await revokeOtherDevice(one, ready.record, pendingFour!.id)
    expect(kept.puks).length(1)
    const moved = await revokeOtherDevice(one, kept, linkedTwo!.id)
    expect(moved.puks.map(puk => puk.generation)).deep.equals([1, 2])
    const mine = await one.client.myChatKeys()
    expect(mine.pukNeedsRotation).equals(false)
    expect(mine.generations.map(row => row.generation)).deep.equals([1, 2])
    // The removed device's session ended with it.
    const gone = await refusal(clientOf('B~2').myChatKeys())
    expect((gone as HttpError).code).equals('unauthorized')

    // Device three, still linked, opens generation 2 on its next look.
    const three = await ensureEnrolled(deviceOf('B~3', 'B'))
    expect(three.state).equals('ready')
    expect(three.record.puks.map(puk => b64(puk.keys.secretKey))).deep.equals(
      moved.puks.map(puk => b64(puk.keys.secretKey))
    )
  })

  it('resumes a device in a new session with its keys', async function () {
    const one = deviceOf('B', 'B')
    const before = await ensureEnrolled(one)
    const again = deviceOf(await session('B~5', 'B'), 'B', one.store)
    const resumed = await ensureEnrolled(again)
    expect(resumed.state).equals('ready')
    expect(resumed.record.deviceId).equals(before.record.deviceId)
    expect(resumed.record.identity?.id).equals(before.record.identity?.id)
    const mine = await again.client.myChatKeys()
    expect(mine.deviceId).equals(before.record.deviceId)
    expect(one.store.wipes).equals(0)
  })

  it('starts again as a new device when the server refuses to resume it', async function () {
    // B~2 was removed above: its keys are wiped and it asks to be linked.
    const removed = await f()
      .db.selectFrom('chat_devices')
      .select(['id'])
      .where('name', '=', 'B~2')
      .executeTakeFirstOrThrow()
    const store = new MemoryStore()
    await store.save(newRecord(f().id('B'), removed.id, newDeviceKeys()))
    const revoked = deviceOf(await session('B~6', 'B'), 'B', store)
    const fresh = await ensureEnrolled(revoked)
    expect(store.wipes).equals(1)
    expect(fresh.state).equals('link')
    expect(fresh.record.deviceId).not.equals(removed.id)

    // A device id the server never had.
    const madeUp = new MemoryStore()
    await madeUp.save(newRecord(f().id('B'), 'cdv_madeup', newDeviceKeys()))
    const unknown = await ensureEnrolled(
      deviceOf(await session('B~7', 'B'), 'B', madeUp)
    )
    expect(madeUp.wipes).equals(1)
    expect(unknown.record.deviceId).not.equals('cdv_madeup')

    // Another user's record on this device.
    const theirs = new MemoryStore()
    const other = await ensureEnrolled(deviceOf('A', 'A'))
    await theirs.save(other.record)
    const mine = await ensureEnrolled(
      deviceOf(await session('B~8', 'B'), 'B', theirs)
    )
    expect(theirs.wipes).equals(1)
    expect(mine.record.userId).equals(f().id('B'))
    expect(mine.record.deviceId).not.equals(other.record.deviceId)
    expect(mine.state).equals('link')
  })

  it('passes on any other refusal to resume', async function () {
    const one = deviceOf('B', 'B')
    const ready = await ensureEnrolled(one)
    const store = new MemoryStore()
    // The right device, the wrong signing key.
    await store.save({
      ...ready.record,
      device: { ...ready.record.device, sign: newDeviceKeys().sign }
    })
    const error = await refusal(
      ensureEnrolled(deviceOf(await session('B~9', 'B'), 'B', store))
    )
    expect(reasonOf(error)).equals('badSignature')
    expect(store.wipes).equals(0)
  })

  it('signs out: the device leaves chat and its keys are wiped', async function () {
    const one = deviceOf(await session('K~1', 'K'), 'K')
    const ready = await ensureEnrolled(one)
    await leaveChat(one)
    expect(one.store.text).equals(undefined)
    const device = await f()
      .db.selectFrom('chat_devices')
      .select(['revoked_at'])
      .where('id', '=', ready.record.deviceId)
      .executeTakeFirstOrThrow()
    expect(device.revoked_at).not.equals(null)
    expect(((await refusal(one.client.myChatKeys())) as HttpError).code).equals(
      'unauthorized'
    )
    // Nothing kept: nothing to remove, no call made, nothing wiped again.
    await leaveChat(one)
    expect(one.store.wipes).equals(1)
  })

  it('signs out from a session the device was not bound to', async function () {
    const one = deviceOf(await session('Hs~1', 'Hs'), 'Hs')
    const ready = await ensureEnrolled(one)
    const later = deviceOf(await session('Hs~2', 'Hs'), 'Hs', one.store)
    await leaveChat(later)
    expect(later.store.text).equals(undefined)
    const device = await f()
      .db.selectFrom('chat_devices')
      .select(['revoked_at'])
      .where('id', '=', ready.record.deviceId)
      .executeTakeFirstOrThrow()
    expect(device.revoked_at).not.equals(null)
  })

  describe('signing out where the chat crypto core is not', function () {
    const unavailable = async (): Promise<ChatCoreStatus> => ({
      ready: false,
      reason: 'noWebAssembly'
    })

    it('with nothing stored, touches nothing and loads no core', async function () {
      const store = new MemoryStore()
      let loads = 0
      await leaveChat({
        client: clientOf(await session('Ek~1', 'Ek')),
        store,
        loadCore: async () => {
          loads += 1
          return await unavailable()
        }
      })
      expect(store.wipes).equals(0)
      expect(loads).equals(0)
    })

    it('revokes a device bound to this session, and wipes it', async function () {
      const one = deviceOf(await session('Ek~2', 'Ek'), 'Ek')
      const ready = await ensureEnrolled(one)
      await leaveChat({ ...one, loadCore: unavailable })
      expect(one.store.text).equals(undefined)
      const device = await f()
        .db.selectFrom('chat_devices')
        .select(['revoked_at'])
        .where('id', '=', ready.record.deviceId)
        .executeTakeFirstOrThrow()
      expect(device.revoked_at).not.equals(null)
    })

    it('wipes a store that cannot say what it holds', async function () {
      const store = new MemoryStore()
      await store.save(newRecord(f().id('Es'), 'cdv_unknown', newDeviceKeys()))
      store.exists = async () => {
        throw new Error('no indexedDB.databases()')
      }
      await leaveChat({
        client: clientOf(await session('Es~3', 'Es')),
        store,
        loadCore: unavailable
      })
      expect(store.text).equals(undefined)
      expect(store.wipes).equals(1)
    })

    it('goes on without a core that never settles, or that throws', async function () {
      const empty = new MemoryStore()
      await leaveChat({
        client: clientOf(await session('Ek~3', 'Ek')),
        store: empty,
        loadCore: async () => await new Promise<never>(() => {}),
        coreWaitMs: 20
      })
      expect(empty.wipes).equals(0)
      const kept = new MemoryStore()
      await kept.save(newRecord(f().id('Ek'), 'cdv_unknown', newDeviceKeys()))
      await leaveChat({
        client: clientOf(await session('Ek~4', 'Ek')),
        store: kept,
        loadCore: async () => {
          throw new Error('no module')
        }
      })
      expect(kept.text).equals(undefined)
    })

    it('wipes a device it cannot prove to a new session, signing nothing', async function () {
      const one = deviceOf(await session('Es~1', 'Es'), 'Es')
      const ready = await ensureEnrolled(one)
      const later = deviceOf(await session('Es~2', 'Es'), 'Es', one.store)
      await leaveChat({ ...later, loadCore: unavailable })
      expect(later.store.text).equals(undefined)
      // No signed resume, so the server never bound it here to revoke it.
      const device = await f()
        .db.selectFrom('chat_devices')
        .select(['revoked_at'])
        .where('id', '=', ready.record.deviceId)
        .executeTakeFirstOrThrow()
      expect(device.revoked_at).equals(null)
    })
  })

  it('wipes the keys even when the server cannot be reached', async function () {
    const store = new MemoryStore()
    await store.save(newRecord(f().id('C'), 'cdv_x', newDeviceKeys()))
    const offline = new TeamStationClient({
      baseUrl: 'http://127.0.0.1:9/api/v1',
      token: 'nope'
    })
    await leaveChat({ client: offline, store })
    expect(store.text).equals(undefined)
  })

  describe('resetting chat on a device whose saved keys cannot be read', function () {
    /**
     * Makes the record `store` holds now one that will not open, as the
     * real stores report it. A record saved later opens as usual.
     */
    function unreadable(store: MemoryStore): void {
      const sealed = store.text
      const load = store.load.bind(store)
      store.load = async () => {
        if (store.text != null && store.text === sealed) {
          throw new UnreadableKeyRecordError('undecryptable')
        }
        return await load()
      }
    }

    /** `client`, noting each device revoke and the options it carried. */
    function noting(client: ChatKeysClient): {
      client: ChatKeysClient
      revokes: Array<[string, unknown]>
    } {
      const revokes: Array<[string, unknown]> = []
      const spy = Object.create(client) as ChatKeysClient
      spy.revokeChatDevice = async (deviceId, options) => {
        revokes.push([deviceId, options])
        return await client.revokeChatDevice(deviceId, options)
      }
      return { client: spy, revokes }
    }

    async function revokedAt(deviceId: string): Promise<Date | null> {
      const device = await f()
        .db.selectFrom('chat_devices')
        .select(['revoked_at'])
        .where('id', '=', deviceId)
        .executeTakeFirstOrThrow()
      return device.revoked_at
    }

    it('revokes the device bound to this session, keeps the session, and starts again at reset, not link', async function () {
      await f().person('Ru')
      const one = deviceOf(await session('Ru~1', 'Ru'), 'Ru')
      const ready = await ensureEnrolled(one)
      expect(ready.state).equals('ready')
      unreadable(one.store)
      const error = await refusal(ensureEnrolled(one))
      expect(error).instanceOf(UnreadableKeyRecordError)

      const { client, revokes } = noting(one.client)
      const setup = { ...one, client }
      await resetUnreadableChat(setup)
      expect(revokes).deep.equals([
        [ready.record.deviceId, { keepSession: true }]
      ])
      expect(one.store.text).equals(undefined)
      expect(one.store.wipes).equals(1)
      expect(await revokedAt(ready.record.deviceId)).not.equals(null)
      // Still signed in, and bound to nothing.
      expect((await client.myChatKeys()).deviceId).equals(null)

      // The person's only device is gone: a new identity, not a link
      // nobody can approve.
      const again = await ensureEnrolled(setup)
      expect(again.state).equals('reset')
      expect(again.record.deviceId).not.equals(ready.record.deviceId)
      const listed = await client.chatDevices()
      expect(
        listed
          .filter(device => device.revokedAt == null)
          .map(device => device.id)
      ).deep.equals([again.record.deviceId])
      expect((await resetIdentity(setup, again.record)).identity).not.equals(
        undefined
      )
      expect((await ensureEnrolled(setup)).state).equals('ready')
    })

    it('leaves the person’s other devices able to link this one, without the dead one listed', async function () {
      await f().person('Rv')
      const one = deviceOf(await session('Rv~1', 'Rv'), 'Rv')
      const first = await ensureEnrolled(one)
      const two = deviceOf(await session('Rv~2', 'Rv'), 'Rv')
      const asking = await ensureEnrolled(two)
      expect(asking.state).equals('link')
      await startLink(two, asking.record)
      const [pending] = await one.client.chatLinks()
      await approveLink(one, first.record, pending)
      const linked = await ensureEnrolled(two)
      expect(linked.state).equals('ready')

      unreadable(two.store)
      await resetUnreadableChat(two)
      expect(await revokedAt(linked.record.deviceId)).not.equals(null)
      const again = await ensureEnrolled(two)
      expect(again.state).equals('link')
      const active = (await one.client.chatDevices()).filter(
        device => device.revokedAt == null
      )
      expect(active.map(device => device.id).sort()).deep.equals(
        [first.record.deviceId, again.record.deviceId].sort()
      )
    })

    it('keeps the record, and passes the failure on, when the device cannot be revoked', async function () {
      await f().person('Rw')
      const one = deviceOf(await session('Rw~1', 'Rw'), 'Rw')
      const ready = await ensureEnrolled(one)
      unreadable(one.store)
      const text = one.store.text
      const offline = Object.create(one.client) as ChatKeysClient
      offline.revokeChatDevice = async () => {
        throw new HttpError('offline', 'The request never left')
      }
      const failed = await refusal(
        resetUnreadableChat({ client: offline, store: one.store })
      )
      expect((failed as HttpError).code).equals('offline')
      const unreached = Object.create(one.client) as ChatKeysClient
      unreached.myChatKeys = async () => {
        throw new HttpError('offline', 'The request never left')
      }
      await refusal(
        resetUnreadableChat({ client: unreached, store: one.store })
      )
      expect(one.store.text).equals(text)
      expect(one.store.wipes).equals(0)
      expect(await revokedAt(ready.record.deviceId)).equals(null)
      // Tried again once the server answers, it goes through.
      await resetUnreadableChat(one)
      expect(await revokedAt(ready.record.deviceId)).not.equals(null)
      expect(one.store.wipes).equals(1)
    })

    it('wipes without revoking when this session is bound to no device', async function () {
      await f().person('Rx')
      const one = deviceOf(await session('Rx~1', 'Rx'), 'Rx')
      const ready = await ensureEnrolled(one)
      const later = deviceOf(await session('Rx~2', 'Rx'), 'Rx', one.store)
      unreadable(later.store)
      const { client, revokes } = noting(later.client)
      await resetUnreadableChat({ client, store: later.store })
      expect(revokes).deep.equals([])
      expect(later.store.text).equals(undefined)
      // Nothing here could prove it, so it stays for another device to remove.
      expect(await revokedAt(ready.record.deviceId)).equals(null)
    })

    it('touches nothing for a record that reads, none, or another failure to read', async function () {
      await f().person('Ry')
      const one = deviceOf(await session('Ry~1', 'Ry'), 'Ry')
      const ready = await ensureEnrolled(one)
      const { client, revokes } = noting(one.client)
      await resetUnreadableChat({ client, store: one.store })
      await resetUnreadableChat({ client, store: new MemoryStore() })
      const broken = new MemoryStore()
      broken.text = 'kept'
      broken.load = async () => {
        throw new Error('IndexedDB will not open')
      }
      const error = await refusal(
        resetUnreadableChat({ client, store: broken })
      )
      expect((error as Error).message).equals('IndexedDB will not open')
      // A newer version's record is still good: refused, never revoked or wiped.
      const newer = new MemoryStore()
      newer.text = 'newer'
      newer.load = async () => {
        throw new UnreadableKeyRecordError('unknownVersion')
      }
      const kept = await refusal(resetUnreadableChat({ client, store: newer }))
      expect((kept as UnreadableKeyRecordError).reason).equals('unknownVersion')
      expect(newer.wipes).equals(0)
      expect(newer.text).equals('newer')
      expect(revokes).deep.equals([])
      expect(one.store.wipes + broken.wipes).equals(0)
      expect(broken.text).equals('kept')
      expect(await revokedAt(ready.record.deviceId)).equals(null)
      expect((await ensureEnrolled(one)).state).equals('ready')
    })

    it('leaves sign-out as it was: the device is revoked with its session, and the keys go', async function () {
      await f().person('Rz')
      const one = deviceOf(await session('Rz~1', 'Rz'), 'Rz')
      const ready = await ensureEnrolled(one)
      const { client, revokes } = noting(one.client)
      await leaveChat({ client, store: one.store })
      expect(revokes).deep.equals([[ready.record.deviceId, undefined]])
      expect(one.store.text).equals(undefined)
      expect(((await refusal(client.myChatKeys())) as HttpError).code).equals(
        'unauthorized'
      )
    })
  })

  it('goes straight to reset with no active device left, and the reset drops every old key', async function () {
    // K signed out of the only device above.
    const back = deviceOf(await session('K~2', 'K'), 'K')
    const asking = await ensureEnrolled(back)
    expect(asking.state).equals('reset')
    const before = (await back.client.myChatKeys()).identity?.id
    const withOld = withEpochKey(
      asking.record,
      'cnv_old',
      1,
      new Uint8Array(32)
    )
    const reset = await resetIdentity(back, withOld)
    expect(reset.identity?.id).not.equals(before)
    expect(reset.puks.map(puk => puk.generation)).deep.equals([1])
    expect(reset.epochKeys).deep.equals({})
    expect((await back.client.myChatKeys()).identity?.id).equals(
      reset.identity?.id
    )
    expect((await ensureEnrolled(back)).state).equals('ready')
  })

  it('resets from the link screen and leaves the other devices locked out', async function () {
    const one = deviceOf('Hk', 'Hk')
    const ready = await ensureEnrolled(one)
    const two = deviceOf(await session('Hk~2', 'Hk'), 'Hk')
    const asking = await ensureEnrolled(two)
    expect(asking.state).equals('link')
    const started = await startLink(two, asking.record)
    const reset = await resetIdentity(two, started.record)
    expect(reset.pendingLinkId).equals(undefined)
    expect(reset.identity?.id).not.equals(ready.record.identity?.id)
    // The first device is revoked by the reset: it wipes, and asks to link.
    const after = await ensureEnrolled(
      deviceOf(await session('Hk~3', 'Hk'), 'Hk', one.store)
    )
    expect(one.store.wipes).equals(1)
    expect(after.state).equals('link')
    expect(after.record.identity).equals(undefined)
  })

  it('opens older per-user keys through the newest one’s chain, and checks each', async function () {
    const one = deviceOf('Ha', 'Ha')
    const ready = await ensureEnrolled(one)
    const rotated = await rotatePuk(one, ready.record)
    expect(rotated.puks.map(puk => puk.generation)).deep.equals([1, 2])

    // A device holding only generation 2's box reaches 1 through its chain.
    const onlyNewest = {
      ...one,
      client: {
        ...one.client,
        myChatKeys: async (): Promise<ChatMyKeys> => {
          const mine = await one.client.myChatKeys()
          return {
            ...mine,
            generations: mine.generations.map(row =>
              row.generation === 1 ? { ...row, box: null } : row
            )
          }
        }
      }
    }
    await one.store.save({ ...rotated, puks: [] })
    const synced = await ensureEnrolled(onlyNewest)
    expect(synced.record.puks.map(puk => b64(puk.keys.secretKey))).deep.equals(
      rotated.puks.map(puk => b64(puk.keys.secretKey))
    )

    // A published key that is not the one in the box is refused.
    const forged = {
      ...one,
      client: {
        ...one.client,
        myChatKeys: async (): Promise<ChatMyKeys> => {
          const mine = await one.client.myChatKeys()
          return {
            ...mine,
            generations: mine.generations.map(row => ({
              ...row,
              publicKey: b64(new Uint8Array(32).fill(7))
            }))
          }
        }
      }
    }
    await one.store.save({ ...rotated, puks: [] })
    const error = await refusal(ensureEnrolled(forged))
    expect(String(error)).contains('does not match')
  })

  it('takes the other device’s generation when two move the key on at once', async function () {
    const one = deviceOf('Ha', 'Ha')
    const ready = await ensureEnrolled(one)
    const two = deviceOf(await session('Ha~2', 'Ha'), 'Ha')
    const asking = await ensureEnrolled(two)
    const started = await startLink(two, asking.record)
    const [pending] = await one.client.chatLinks()
    await approveLink(one, ready.record, pending)
    const linked = await pollLink(two, started.record)
    if (linked.state !== 'installed') throw new Error('not linked')
    const first = await rotatePuk(one, ready.record)
    const second = await rotatePuk(two, linked.record)
    expect(second.puks.map(puk => puk.generation)).deep.equals(
      first.puks.map(puk => puk.generation)
    )
    expect(b64(second.puks[second.puks.length - 1].keys.secretKey)).equals(
      b64(first.puks[first.puks.length - 1].keys.secretKey)
    )
    // A refusal other than a taken generation is passed on.
    const forged = await refusal(
      rotatePuk(two, {
        ...second,
        identity: {
          id: second.identity?.id ?? '',
          keys: newDeviceKeys().sign
        }
      })
    )
    expect(reasonOf(forged)).equals('badSignature')
  })

  it('has nothing to approve or move on without an identity', async function () {
    const empty = newRecord(userIdOfGumbo(1), 'cdv', newDeviceKeys())
    const one = deviceOf('A', 'A')
    expect(await rotatePuk(one, empty)).equals(empty)
    const error = await refusal(
      approveLink(one, empty, {
        id: 'clk',
        newDevice: {
          id: 'cdv',
          name: 'x',
          platform: 'web',
          boxPublicKey: b64(new Uint8Array(32))
        },
        createdAt: '',
        expiresAt: ''
      })
    )
    expect(String(error)).contains('no identity')
  })

  it('reads refusal reasons and spaces the digits', function () {
    expect(
      reasonOf(new HttpError('forbidden', 'no', { reason: 'deviceRevoked' }))
    ).equals('deviceRevoked')
    expect(reasonOf(new HttpError('forbidden', 'no'))).equals(undefined)
    expect(reasonOf(new HttpError('forbidden', 'no', { reason: 4 }))).equals(
      undefined
    )
    expect(reasonOf(new Error('plain'))).equals(undefined)
    expect(spacedCode('012345')).equals('012 345')
  })
})
