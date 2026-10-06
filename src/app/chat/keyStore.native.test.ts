import Module from 'node:module'

import { expect } from 'chai'
import { before, describe, it } from 'mocha'

import { newDeviceKeys } from '../../common/chatCrypto/keys'
import { type ChatKeyStore, newRecord, recordToJson } from './keyRecord'

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

  const sample = newRecord(5, 'cdv_phone', newDeviceKeys())

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
    expect(keychain.calls).deep.equals(['get', 'set', 'get', 'reset', 'get'])
  })

  it('wipes it', async function () {
    keychain.saved.clear()
    await keyStore.save(sample)
    expect((await keyStore.load())?.deviceId).equals('cdv_phone')
    await keyStore.wipe()
    expect(keychain.saved.size).equals(0)
    expect(await keyStore.load()).equals(undefined)
  })

  it('reads an item it did not write as none', async function () {
    keychain.saved.clear()
    keychain.saved.set(KEY_SERVICE, {
      username: 'chat',
      password: '{"version":9}',
      options: undefined
    })
    expect(await keyStore.load()).equals(undefined)
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
