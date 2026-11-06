import Module from 'node:module'

import { expect } from 'chai'
import { before, describe, it } from 'mocha'

import { newDeviceKeys } from '../../common/chatCrypto/keys'
import { userIdOfGumbo } from '../../common/userId'
import legacyRecord from '../../test/legacyChatKeyRecord.json'
import {
  type ChatKeysClient,
  ensureEnrolled,
  resetUnreadableChat
} from './engine/links'
import {
  type ChatKeyStore,
  newRecord,
  recordFromJson,
  recordToJson,
  UnreadableKeyRecordError
} from './keyRecord'

/**
 * U11: the phone's store, on a stand-in for `react-native-keychain` (whose
 * real module needs React Native's native side). The stand-in is put where
 * Node would load the package from, so the store's own import finds it.
 */
interface Saved {
  username: string
  password: string
  options: Record<string, unknown> | undefined
}

const keychain = {
  saved: new Map<string, Saved>(),
  refuse: false,
  /** A reset of this service reports failure and deletes nothing. */
  failReset: undefined as string | undefined,
  /** A Keychain that will not answer (locked since boot, say). */
  locked: false,
  calls: [] as string[],
  seen: [] as Array<{
    op: string
    options: Record<string, unknown> | undefined
  }>,
  ACCESSIBLE: {
    AFTER_FIRST_UNLOCK: 'AccessibleAfterFirstUnlock',
    AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY:
      'AccessibleAfterFirstUnlockThisDeviceOnly'
  },
  note(op: string, options?: Record<string, unknown>) {
    keychain.calls.push(op)
    keychain.seen.push({ op, options })
  },
  async hasGenericPassword(options?: {
    service?: string
    cloudSync?: boolean
  }) {
    keychain.note('has', options)
    return keychain.saved.has(options?.service ?? '')
  },
  async getGenericPassword(options?: {
    service?: string
    cloudSync?: boolean
  }) {
    keychain.note('get', options)
    if (keychain.locked) throw new Error('User interaction is not allowed')
    const found = keychain.saved.get(options?.service ?? '')
    return found == null
      ? false
      : {
          service: options?.service,
          username: found.username,
          password: found.password,
          storage: 'keychain'
        }
  },
  async setGenericPassword(
    username: string,
    password: string,
    options?: { service?: string; cloudSync?: boolean; accessible?: string }
  ) {
    keychain.note('set', options)
    if (keychain.refuse) return false
    keychain.saved.set(options?.service ?? '', { username, password, options })
    return { service: options?.service ?? '', storage: 'keychain' }
  },
  async resetGenericPassword(options?: {
    service?: string
    cloudSync?: boolean
  }) {
    keychain.note('reset', options)
    if (options?.service != null && options.service === keychain.failReset)
      return false
    return keychain.saved.delete(options?.service ?? '')
  }
}

describe('chat key store on the phone', function () {
  let nativeKeyStore: (module: typeof keychain) => ChatKeyStore
  let keyStore: ChatKeyStore
  let KEY_SERVICE: string
  let accountKeyService: (userId: string) => string

  before(async function () {
    const path = require.resolve('react-native-keychain')
    const stand = new Module(path)
    stand.filename = path
    stand.loaded = true
    stand.exports = keychain
    require.cache[path] = stand
    const loaded = await import('./keyStore.native')
    nativeKeyStore = loaded.nativeKeyStore as unknown as typeof nativeKeyStore
    keyStore = loaded.keyStore
    KEY_SERVICE = loaded.KEY_SERVICE
    accountKeyService = loaded.accountKeyService
  })

  const sample = newRecord(userIdOfGumbo(5), 'cdv_phone', newDeviceKeys())

  it('round-trips a record as one Keychain item for that account', async function () {
    keychain.saved.clear()
    const store = nativeKeyStore(keychain)
    const service = accountKeyService(sample.userId)
    expect(await store.load(sample.userId)).equals(undefined)
    await store.save(sample)
    const saved = keychain.saved.get(service)
    expect(service).equals(`app.teamstation.chat.${sample.userId}`)
    expect(saved?.password).equals(recordToJson(sample))
    expect(saved?.options).deep.equals({
      service,
      cloudSync: true,
      accessible: 'AccessibleAfterFirstUnlock'
    })
    const back = await store.load(sample.userId)
    expect(back == null ? undefined : recordToJson(back)).equals(
      recordToJson(sample)
    )
  })

  it('says whether a record is kept, without changing anything', async function () {
    keychain.saved.clear()
    keychain.calls = []
    expect(await keyStore.exists(sample.userId)).equals(false)
    await keyStore.save(sample)
    expect(await keyStore.exists(sample.userId)).equals(true)
    await keyStore.wipe(sample.userId)
    expect(await keyStore.exists(sample.userId)).equals(false)
    expect(keychain.calls).deep.equals([
      'has',
      'has',
      'set',
      'has',
      'has',
      'reset',
      'has',
      'has'
    ])
  })

  it('wipes it', async function () {
    keychain.saved.clear()
    await keyStore.save(sample)
    expect((await keyStore.load(sample.userId))?.deviceId).equals('cdv_phone')
    await keyStore.wipe(sample.userId)
    expect(keychain.saved.size).equals(0)
    expect(await keyStore.load(sample.userId)).equals(undefined)
  })

  it('preserves malformed persisted key bytes and blocks automatic enrollment', async function () {
    for (const key of ['AA', '*'.repeat(43)]) {
      keychain.saved.clear()
      const raw = structuredClone(legacyRecord)
      raw.device.box.secretKey = key
      keychain.saved.set(accountKeyService(userIdOfGumbo(42)), {
        username: 'chat',
        password: JSON.stringify(raw),
        options: undefined
      })
      const before = structuredClone([...keychain.saved])
      keychain.calls = []
      const calls: string[] = []
      const client = {
        registerChatDevice: async () => {
          calls.push('enroll')
        }
      } as unknown as ChatKeysClient
      let failed: unknown
      await ensureEnrolled({
        client,
        store: nativeKeyStore(keychain),
        userId: userIdOfGumbo(42),
        device: { name: 'Test Phone', platform: 'ios' }
      }).catch((error: unknown) => {
        failed = error
      })
      expect(failed).instanceOf(Error)
      expect(calls).deep.equals([])
      expect([...keychain.saved]).deep.equals(before)
      expect(keychain.calls).deep.equals(['get'])
    }
  })

  it('preserves an unknown record and blocks automatic enrollment', async function () {
    keychain.saved.clear()
    keychain.saved.set(accountKeyService(sample.userId), {
      username: 'chat',
      password: '{"version":9}',
      options: undefined
    })
    const before = keychain.saved.get(accountKeyService(sample.userId))
    keychain.calls = []
    const calls: string[] = []
    const client = {
      registerChatDevice: async () => {
        calls.push('enroll')
      }
    } as unknown as ChatKeysClient
    let failed: unknown
    await ensureEnrolled({
      client,
      store: keyStore,
      userId: sample.userId,
      device: { name: 'Test Device', platform: 'ios' }
    }).catch((error: unknown) => {
      failed = error
    })
    expect(String(failed)).contains('Unknown chat key record version')
    expect((failed as UnreadableKeyRecordError).reason).equals('unknownVersion')
    expect(calls).deep.equals([])
    expect(keychain.calls).deep.equals(['get'])
    expect(keychain.saved.get(accountKeyService(sample.userId))).equals(before)
    expect(await keyStore.exists(sample.userId)).equals(true)
  })

  it('calls a record it cannot parse unreadable, and a Keychain that will not answer no such thing', async function () {
    keychain.saved.clear()
    keychain.saved.set(accountKeyService(sample.userId), {
      username: 'chat',
      password: '{"secret":"do-not-log"',
      options: undefined
    })
    const before = keychain.saved.get(accountKeyService(sample.userId))
    const unreadable = await keyStore
      .load(sample.userId)
      .catch((error: unknown) => error)
    expect(unreadable).instanceOf(UnreadableKeyRecordError)
    expect((unreadable as UnreadableKeyRecordError).reason).equals('invalid')
    expect(String(unreadable)).not.contains('do-not-log')
    expect(keychain.saved.get(accountKeyService(sample.userId))).equals(before)
    keychain.locked = true
    try {
      const locked = await keyStore
        .load(sample.userId)
        .catch((error: unknown) => error)
      expect(locked).instanceOf(Error)
      expect(locked).not.instanceOf(UnreadableKeyRecordError)
    } finally {
      keychain.locked = false
    }
    expect(keychain.saved.get(accountKeyService(sample.userId))).equals(before)
  })

  it('copies a legacy v1 record into the account service, then deletes the legacy item', async () => {
    const text = JSON.stringify(legacyRecord)
    const owner = userIdOfGumbo(42)
    keychain.saved.clear()
    keychain.saved.set(KEY_SERVICE, {
      username: 'chat',
      password: text,
      options: undefined
    })
    const record = await keyStore.load(owner)
    expect(record).deep.equals(recordFromJson(text))
    expect(record?.userId).equals(owner)
    expect(keychain.saved.has(KEY_SERVICE)).equals(false)
    expect(keychain.saved.get(accountKeyService(owner))?.password).equals(text)
    keychain.refuse = true
    let failed: unknown
    try {
      await keyStore.save(record!)
    } catch (error) {
      failed = error
    } finally {
      keychain.refuse = false
    }
    expect(String(failed)).contains('could not be saved')
    expect(keychain.saved.get(accountKeyService(owner))?.password).equals(text)
    expect(await keyStore.load(owner)).deep.equals(record)
    await keyStore.save(record!)
    expect(
      JSON.parse(keychain.saved.get(accountKeyService(owner))!.password).version
    ).equals(2)
    expect(await keyStore.load(owner)).deep.equals(record)
  })

  /**
   * A keychain whose every call takes a while, noting when two run at
   * once, the way a reset on Android runs beside a save.
   */
  function slowKeychain(): typeof keychain & {
    overlaps: number
    order: string[]
  } {
    let running = 0
    const slow = {
      ...keychain,
      overlaps: 0,
      order: [] as string[]
    }
    const wrap =
      <A extends unknown[], R>(
        name: string,
        call: (...args: A) => Promise<R>
      ) =>
      async (...args: A): Promise<R> => {
        running += 1
        if (running > 1) slow.overlaps += 1
        slow.order.push(`${name}:start`)
        try {
          await new Promise(resolve => setTimeout(resolve, 5))
          return await call(...args)
        } finally {
          slow.order.push(`${name}:end`)
          running -= 1
        }
      }
    slow.getGenericPassword = wrap(
      'get',
      keychain.getGenericPassword.bind(keychain)
    )
    slow.hasGenericPassword = wrap(
      'has',
      keychain.hasGenericPassword.bind(keychain)
    )
    slow.setGenericPassword = wrap(
      'set',
      keychain.setGenericPassword.bind(keychain)
    )
    slow.resetGenericPassword = wrap(
      'reset',
      keychain.resetGenericPassword.bind(keychain)
    )
    return slow
  }

  it('overlapping saves and wipes still run one at a time', async function () {
    keychain.saved.clear()
    const slow = slowKeychain()
    const store = nativeKeyStore(slow)
    const other = newRecord(userIdOfGumbo(6), 'cdv_next', newDeviceKeys())
    // One user's sign-out wipe, and the next user's enrolment, at once.
    const [, , loaded, kept] = await Promise.all([
      store.save(sample),
      store.wipe(sample.userId),
      store.load(sample.userId),
      store.exists(sample.userId),
      store.save(other)
    ])
    expect(slow.overlaps).equals(0)
    expect(slow.order).deep.equals([
      'set:start',
      'set:end',
      'reset:start',
      'reset:end',
      'get:start',
      'get:end',
      'has:start',
      'has:end',
      'has:start',
      'has:end',
      'has:start',
      'has:end',
      'set:start',
      'set:end'
    ])
    expect(loaded).equals(undefined)
    expect(kept).equals(false)
    expect(await store.load(sample.userId)).equals(undefined)
    expect((await store.load(other.userId))?.deviceId).equals('cdv_next')
  })

  it('goes on with the next call after one fails', async function () {
    keychain.saved.clear()
    const slow = slowKeychain()
    let refusals = 2
    const set = slow.setGenericPassword.bind(slow)
    slow.setGenericPassword = async (...args) => {
      if (refusals-- > 0) throw new Error('Keystore unavailable')
      return await set(...args)
    }
    const store = nativeKeyStore(slow)
    const first = store.save(sample).catch((error: unknown) => error)
    const second = store.save(sample).catch((error: unknown) => error)
    const third = store.save(sample)
    expect(String(await first)).contains('Keystore unavailable')
    expect(String(await second)).contains('Keystore unavailable')
    await third
    expect((await store.load(sample.userId))?.deviceId).equals('cdv_phone')
    expect(slow.overlaps).equals(0)
  })

  /** The rejection `react-native-keychain` gives for a Keystore failure. */
  function cryptoFailed(message: string): Error {
    const error = new Error(message) as Error & { code: string }
    error.name = 'com.oblador.keychain.exceptions.CryptoFailedException'
    error.code = 'E_CRYPTO_FAILED'
    return error
  }

  it('calls a record its Keystore key does not open unreadable, and lets the person reset it', async function () {
    keychain.saved.clear()
    const service = accountKeyService(sample.userId)
    keychain.saved.set(service, {
      username: 'chat',
      password: recordToJson(sample),
      options: undefined
    })
    const store = nativeKeyStore({
      ...keychain,
      getGenericPassword: async (options?: { service?: string }) => {
        if (options?.service !== service || !keychain.saved.has(service))
          return false
        throw cryptoFailed(
          'Decryption failed: Authentication tag verification failed. ' +
            'This usually indicates that the encrypted data was modified, ' +
            'corrupted, or is being decrypted with the wrong key.'
        )
      }
    })
    const unreadable = await store
      .load(sample.userId)
      .catch((error: unknown) => error)
    expect(unreadable).instanceOf(UnreadableKeyRecordError)
    expect((unreadable as UnreadableKeyRecordError).reason).equals(
      'undecryptable'
    )
    expect(keychain.saved.has(service)).equals(true)
    // Only by name, as some builds report it.
    const named = new Error(
      'com.oblador.keychain.exceptions.CryptoFailedException: Decryption failed'
    )
    const byName = await nativeKeyStore({
      ...keychain,
      getGenericPassword: async () => {
        throw named
      }
    })
      .load(sample.userId)
      .catch((error: unknown) => error)
    expect(byName).instanceOf(UnreadableKeyRecordError)

    // Reset chat on this device: the device is revoked, the record wiped.
    const revoked: string[] = []
    await resetUnreadableChat({
      client: {
        myChatKeys: async () => ({ deviceId: 'cdv_phone' }),
        revokeChatDevice: async (deviceId: string) => {
          revoked.push(deviceId)
        }
      } as unknown as ChatKeysClient,
      store,
      userId: sample.userId
    })
    expect(revoked).deep.equals(['cdv_phone'])
    expect(keychain.saved.has(service)).equals(false)
    expect(await store.load(sample.userId)).equals(undefined)
  })

  it('passes on any other Keystore failure as it is', async function () {
    keychain.saved.clear()
    for (const failure of [
      cryptoFailed('Wrapped error: User not authenticated'),
      Object.assign(new Error('Decryption failed'), {
        code: 'E_KEYSTORE_ACCESS_ERROR'
      })
    ]) {
      const store = nativeKeyStore({
        ...keychain,
        getGenericPassword: async () => {
          throw failure
        }
      })
      const failed = await store
        .load(sample.userId)
        .catch((error: unknown) => error)
      expect(failed).equals(failure)
    }
  })

  it('fails loudly when the Keychain will not keep it', async function () {
    keychain.refuse = true
    try {
      let failed: unknown
      await keyStore.save(sample).catch((error: unknown) => {
        failed = error
      })
      expect(String(failed)).contains('could not be saved')
    } finally {
      keychain.refuse = false
    }
  })

  /** Puts `password` at `service` without going through the store. */
  function keep(service: string, password: string): void {
    keychain.saved.set(service, {
      username: 'chat',
      password,
      options: undefined
    })
  }

  it('keeps each account in its own service', async function () {
    keychain.saved.clear()
    const other = newRecord(userIdOfGumbo(6), 'cdv_next', newDeviceKeys())
    await keyStore.save(sample)
    await keyStore.save(other)
    expect((await keyStore.load(sample.userId))?.deviceId).equals('cdv_phone')
    expect((await keyStore.load(other.userId))?.deviceId).equals('cdv_next')
    await keyStore.wipe(sample.userId)
    expect(await keyStore.load(sample.userId)).equals(undefined)
    expect(await keyStore.exists(sample.userId)).equals(false)
    expect(await keyStore.exists(other.userId)).equals(true)
    expect((await keyStore.load(other.userId))?.deviceId).equals('cdv_next')
  })

  it('load of another account leaves a legacy record that is not theirs', async function () {
    keychain.saved.clear()
    const text = recordToJson(sample)
    keep(KEY_SERVICE, text)
    const other = userIdOfGumbo(6)
    expect(await keyStore.load(other)).equals(undefined)
    expect(await keyStore.exists(other)).equals(false)
    expect(keychain.saved.get(KEY_SERVICE)?.password).equals(text)
    expect(keychain.saved.has(accountKeyService(other))).equals(false)
  })

  it('does not overwrite a per-account record, and deletes the legacy slot when it is the same account', async function () {
    keychain.saved.clear()
    keep(KEY_SERVICE, recordToJson({ ...sample, deviceId: 'cdv_old' }))
    await keyStore.save(sample)
    const kept = keychain.saved.get(accountKeyService(sample.userId))?.password
    expect((await keyStore.load(sample.userId))?.deviceId).equals('cdv_phone')
    expect(
      keychain.saved.get(accountKeyService(sample.userId))?.password
    ).equals(kept)
    expect(keychain.saved.has(KEY_SERVICE)).equals(false)
  })

  it('a failed per-account write leaves the legacy slot', async function () {
    keychain.saved.clear()
    const text = recordToJson(sample)
    keep(KEY_SERVICE, text)
    keychain.refuse = true
    try {
      const failed = await keyStore
        .load(sample.userId)
        .catch((error: unknown) => error)
      expect(String(failed)).contains('could not be saved')
    } finally {
      keychain.refuse = false
    }
    expect(keychain.saved.get(KEY_SERVICE)?.password).equals(text)
    expect(keychain.saved.has(accountKeyService(sample.userId))).equals(false)
  })

  it('a failed legacy delete leaves the per-account record, and the next load deletes the legacy slot', async function () {
    keychain.saved.clear()
    const text = recordToJson(sample)
    keep(KEY_SERVICE, text)
    keychain.failReset = KEY_SERVICE
    const failed = await keyStore
      .load(sample.userId)
      .catch((error: unknown) => error)
    expect(String(failed)).contains('could not be removed')
    expect(
      keychain.saved.get(accountKeyService(sample.userId))?.password
    ).equals(text)
    expect(keychain.saved.has(KEY_SERVICE)).equals(true)
    keychain.failReset = undefined
    expect((await keyStore.load(sample.userId))?.deviceId).equals('cdv_phone')
    expect(keychain.saved.has(KEY_SERVICE)).equals(false)
  })

  it('an unreadable legacy record throws from load and exists and stays', async function () {
    keychain.saved.clear()
    keep(KEY_SERVICE, '{"secret":"do-not-log"')
    const before = keychain.saved.get(KEY_SERVICE)
    const loaded = await keyStore
      .load(sample.userId)
      .catch((error: unknown) => error)
    expect(loaded).instanceOf(UnreadableKeyRecordError)
    const existed = await keyStore
      .exists(sample.userId)
      .catch((error: unknown) => error)
    expect(existed).instanceOf(UnreadableKeyRecordError)
    expect(keychain.saved.get(KEY_SERVICE)).equals(before)
    expect(keychain.saved.has(accountKeyService(sample.userId))).equals(false)
  })

  it('an unreadable per-account slot does not read the legacy slot', async function () {
    keychain.saved.clear()
    const service = accountKeyService(sample.userId)
    keep(service, '{"version":9}')
    const other = newRecord(userIdOfGumbo(6), 'cdv_next', newDeviceKeys())
    keep(KEY_SERVICE, recordToJson(other))
    const asked: string[] = []
    const store = nativeKeyStore({
      ...keychain,
      getGenericPassword: async (options?: { service?: string }) => {
        asked.push(options?.service ?? '')
        const found = keychain.saved.get(options?.service ?? '')
        if (found == null) return false
        return {
          service: options?.service,
          username: found.username,
          password: found.password,
          storage: 'keychain'
        }
      }
    })
    const failed = await store
      .load(sample.userId)
      .catch((error: unknown) => error)
    expect((failed as UnreadableKeyRecordError).reason).equals('unknownVersion')
    expect(asked).deep.equals([service])
    expect(keychain.saved.has(KEY_SERVICE)).equals(true)
  })

  it('exists on a present per-account slot returns true without parsing it', async function () {
    keychain.saved.clear()
    keychain.calls = []
    keep(accountKeyService(sample.userId), '{"secret":"do-not-log"')
    expect(await keyStore.exists(sample.userId)).equals(true)
    expect(keychain.calls).deep.equals(['has', 'has'])
  })

  it('iOS per-account get, has, set, and reset pass cloudSync: true; set uses AFTER_FIRST_UNLOCK; legacy get and reset omit cloudSync', async function () {
    keychain.saved.clear()
    keychain.seen = []
    const service = accountKeyService(sample.userId)
    await keyStore.save(sample)
    await keyStore.load(sample.userId)
    await keyStore.exists(sample.userId)
    await keyStore.wipe(sample.userId)
    keep(KEY_SERVICE, recordToJson(sample))
    await keyStore.load(sample.userId)
    await keyStore.discardLegacy?.(sample.userId)
    const perAccount = keychain.seen.filter(
      call => call.options?.service === service
    )
    expect(perAccount.some(call => call.op === 'get')).equals(true)
    expect(perAccount.some(call => call.op === 'has')).equals(true)
    expect(perAccount.some(call => call.op === 'set')).equals(true)
    expect(perAccount.some(call => call.op === 'reset')).equals(true)
    for (const call of perAccount) expect(call.options?.cloudSync).equals(true)
    for (const call of perAccount.filter(call => call.op === 'set')) {
      expect(call.options?.accessible).equals('AccessibleAfterFirstUnlock')
    }
    const legacy = keychain.seen.filter(
      call => call.options?.service === KEY_SERVICE
    )
    expect(legacy.some(call => call.op === 'get')).equals(true)
    expect(legacy.some(call => call.op === 'reset')).equals(true)
    for (const call of legacy) {
      expect(Object.hasOwn(call.options ?? {}, 'cloudSync')).equals(false)
    }
  })

  function resetClient(deviceId: string): {
    client: ChatKeysClient
    revoked: string[]
  } {
    const revoked: string[] = []
    return {
      revoked,
      client: {
        myChatKeys: async () => ({ deviceId }),
        revokeChatDevice: async (id: string) => {
          revoked.push(id)
        }
      } as unknown as ChatKeysClient
    }
  }

  it("reset of an unreadable account leaves another account's legacy record", async function () {
    keychain.saved.clear()
    const service = accountKeyService(sample.userId)
    keep(service, '{"secret":"do-not-log"')
    const other = newRecord(userIdOfGumbo(6), 'cdv_next', newDeviceKeys())
    const legacy = recordToJson(other)
    keep(KEY_SERVICE, legacy)
    const { client, revoked } = resetClient('cdv_phone')
    await resetUnreadableChat({
      client,
      store: keyStore,
      userId: sample.userId
    })
    expect(revoked).deep.equals(['cdv_phone'])
    expect(keychain.saved.has(service)).equals(false)
    expect(keychain.saved.get(KEY_SERVICE)?.password).equals(legacy)
  })

  it('reset deletes a legacy record that is this account or unreadable', async function () {
    for (const password of [recordToJson(sample), '{"nope"']) {
      keychain.saved.clear()
      const service = accountKeyService(sample.userId)
      keep(service, '{"secret":"do-not-log"')
      keep(KEY_SERVICE, password)
      const { client } = resetClient('cdv_phone')
      await resetUnreadableChat({
        client,
        store: keyStore,
        userId: sample.userId
      })
      expect(keychain.saved.has(service)).equals(false)
      expect(keychain.saved.has(KEY_SERVICE)).equals(false)
    }
  })

  it('load and exists keep a per-account record when the legacy slot is unreadable', async function () {
    keychain.saved.clear()
    await keyStore.save(sample)
    keep(KEY_SERVICE, '{"secret":"do-not-log"')
    expect((await keyStore.load(sample.userId))?.deviceId).equals('cdv_phone')
    expect(await keyStore.exists(sample.userId)).equals(true)
    expect(keychain.saved.has(KEY_SERVICE)).equals(true)
  })
})
