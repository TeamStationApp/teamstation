import Module from 'node:module'

import { expect } from 'chai'
import { before, describe, it } from 'mocha'

import { newDeviceKeys } from '../../common/chatCrypto/keys'
import { userIdOfGumbo } from '../../common/userId'
import legacyRecord from '../../test/legacyChatKeyRecord.json'
import { type ChatKeysClient, ensureEnrolled } from './engine/links'
import {
  type ChatKeyStore,
  newRecord,
  recordFromJson,
  recordToJson
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
  calls: [] as string[],
  ACCESSIBLE: {
    AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY:
      'AccessibleAfterFirstUnlockThisDeviceOnly'
  },
  async hasGenericPassword(options?: { service?: string }) {
    keychain.calls.push('has')
    return keychain.saved.has(options?.service ?? '')
  },
  async getGenericPassword(options?: { service?: string }) {
    keychain.calls.push('get')
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
    options?: { service?: string }
  ) {
    keychain.calls.push('set')
    if (keychain.refuse) return false
    keychain.saved.set(options?.service ?? '', { username, password, options })
    return { service: options?.service ?? '', storage: 'keychain' }
  },
  async resetGenericPassword(options?: { service?: string }) {
    keychain.calls.push('reset')
    return keychain.saved.delete(options?.service ?? '')
  }
}

describe('chat key store on the phone', function () {
  let nativeKeyStore: (module: typeof keychain) => ChatKeyStore
  let keyStore: ChatKeyStore
  let KEY_SERVICE: string

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
  })

  const sample = newRecord(userIdOfGumbo(5), 'cdv_phone', newDeviceKeys())

  it('round-trips a record as one Keychain item, this device only', async function () {
    keychain.saved.clear()
    const store = nativeKeyStore(keychain)
    expect(await store.load()).equals(undefined)
    await store.save(sample)
    const saved = keychain.saved.get(KEY_SERVICE)
    expect(KEY_SERVICE).equals('app.teamstation.chat')
    expect(saved?.password).equals(recordToJson(sample))
    expect(saved?.options).deep.equals({
      service: 'app.teamstation.chat',
      accessible: 'AccessibleAfterFirstUnlockThisDeviceOnly'
    })
    const back = await store.load()
    expect(back == null ? undefined : recordToJson(back)).equals(
      recordToJson(sample)
    )
  })

  it('says whether a record is kept, without changing anything', async function () {
    keychain.saved.clear()
    keychain.calls = []
    expect(await keyStore.exists()).equals(false)
    await keyStore.save(sample)
    expect(await keyStore.exists()).equals(true)
    await keyStore.wipe()
    expect(await keyStore.exists()).equals(false)
    expect(keychain.calls).deep.equals(['has', 'set', 'has', 'reset', 'has'])
  })

  it('wipes it', async function () {
    keychain.saved.clear()
    await keyStore.save(sample)
    expect((await keyStore.load())?.deviceId).equals('cdv_phone')
    await keyStore.wipe()
    expect(keychain.saved.size).equals(0)
    expect(await keyStore.load()).equals(undefined)
  })

  it('preserves malformed persisted key bytes and blocks automatic enrollment', async function () {
    for (const key of ['AA', '*'.repeat(43)]) {
      keychain.saved.clear()
      const raw = structuredClone(legacyRecord)
      raw.device.box.secretKey = key
      keychain.saved.set(KEY_SERVICE, {
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
    keychain.saved.set(KEY_SERVICE, {
      username: 'chat',
      password: '{"version":9}',
      options: undefined
    })
    const before = keychain.saved.get(KEY_SERVICE)
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
    expect(calls).deep.equals([])
    expect(keychain.calls).deep.equals(['get'])
    expect(keychain.saved.get(KEY_SERVICE)).equals(before)
    expect(await keyStore.exists()).equals(true)
  })

  it('loads saved v1 keys, survives a refused save, then atomically writes v2 under the same service', async () => {
    const text = JSON.stringify(legacyRecord)
    keychain.saved.clear()
    keychain.saved.set(KEY_SERVICE, {
      username: 'chat',
      password: text,
      options: undefined
    })
    const record = await keyStore.load()
    expect(record).deep.equals(recordFromJson(text))
    expect(record?.userId).equals(userIdOfGumbo(42))
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
    expect(keychain.saved.get(KEY_SERVICE)?.password).equals(text)
    expect(await keyStore.load()).deep.equals(record)
    await keyStore.save(record!)
    expect(
      JSON.parse(keychain.saved.get(KEY_SERVICE)!.password).version
    ).equals(2)
    expect(await keyStore.load()).deep.equals(record)
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
})
