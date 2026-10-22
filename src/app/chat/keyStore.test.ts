import { expect } from 'chai'
import { IDBFactory } from 'fake-indexeddb'
import { describe, it } from 'mocha'

import { utf8 } from '../../common/chatCrypto/bytes'
import { newDeviceKeys } from '../../common/chatCrypto/keys'
import { userIdOfGumbo } from '../../common/userId'
import legacyRecord from '../../test/legacyChatKeyRecord.json'
import { type ChatKeysClient, ensureEnrolled } from './engine/links'
import {
  b64,
  type ChatKeyRecord,
  newRecord,
  recordFromJson,
  recordToJson
} from './keyRecord'
import { KEY_DATABASE, keyStore, webKeyStore } from './keyStore'

/** U11: the browser's store, on an in-memory IndexedDB and Node's WebCrypto. */
describe('chat key store in the browser', function () {
  const sample = (): ChatKeyRecord => ({
    ...newRecord(userIdOfGumbo(12), 'cdv_web', newDeviceKeys()),
    pins: { [userIdOfGumbo(3)]: b64(new Uint8Array(32).fill(3)) }
  })

  /** Every value kept in `ts-chat`, by key. */
  async function raw(factory: IDBFactory): Promise<Map<string, any>> {
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = factory.open(KEY_DATABASE, 1)
      request.onsuccess = () => {
        resolve(request.result)
      }
      request.onerror = () => {
        reject(request.error ?? new Error('cannot open'))
      }
    })
    const store = db.transaction('keys', 'readonly').objectStore('keys')
    const keys = await new Promise<IDBValidKey[]>(resolve => {
      const request = store.getAllKeys()
      request.onsuccess = () => {
        resolve(request.result)
      }
    })
    const values = await new Promise<unknown[]>(resolve => {
      const request = store.getAll()
      request.onsuccess = () => {
        resolve(request.result)
      }
    })
    db.close()
    return new Map(keys.map((key, index) => [key as string, values[index]]))
  }

  /** Which key a `CryptoKey` is, without reading it: one fixed encryption. */
  async function fingerprint(key: unknown): Promise<string> {
    const sealed = await globalThis.crypto.subtle.encrypt(
      { name: 'AES-GCM', iv: new Uint8Array(12) },
      key as CryptoKey,
      new Uint8Array(16)
    )
    return Buffer.from(sealed).toString('hex')
  }

  it('has nothing to load at first', async function () {
    const store = webKeyStore({ indexedDB: new IDBFactory() })
    expect(await store.load()).equals(undefined)
  })

  it('round-trips a record, sealed under a key nobody can read', async function () {
    const factory = new IDBFactory()
    const store = webKeyStore({ indexedDB: factory })
    const record = sample()
    await store.save(record)
    const back = await store.load()
    expect(back == null ? undefined : recordToJson(back)).equals(
      recordToJson(record)
    )

    const kept = await raw(factory)
    expect([...kept.keys()].sort()).deep.equals(['record', 'wrap'])
    const wrap = kept.get('wrap') as CryptoKey
    expect(wrap.extractable).equals(false)
    expect(wrap.algorithm).deep.include({ name: 'AES-GCM', length: 256 })
    let exported = true
    await globalThis.crypto.subtle.exportKey('raw', wrap).catch(() => {
      exported = false
    })
    expect(exported).equals(false)
    const sealed = kept.get('record') as {
      iv: Uint8Array
      ciphertext: ArrayBuffer
    }
    expect(sealed.iv.length).equals(12)
    const bytes = Buffer.from(sealed.ciphertext).toString('latin1')
    expect(bytes).not.contains(b64(record.device.box.secretKey))
    expect(bytes).not.contains('cdv_web')

    // Another page of the same site reads the same record.
    const again = await webKeyStore({ indexedDB: factory }).load()
    expect(again?.deviceId).equals('cdv_web')
  })

  it('keeps one wrapping key, even when two pages make one at once', async function () {
    const factory = new IDBFactory()
    const first = webKeyStore({ indexedDB: factory })
    const second = webKeyStore({ indexedDB: factory })
    await Promise.all([first.save(sample()), second.save(sample())])
    expect((await first.load())?.userId).equals(userIdOfGumbo(12))
    const wrap = await fingerprint((await raw(factory)).get('wrap'))
    await first.save(sample())
    expect(await fingerprint((await raw(factory)).get('wrap'))).equals(wrap)
    expect((await second.load())?.userId).equals(userIdOfGumbo(12))
  })

  it('preserves damaged ciphertext and blocks automatic enrollment', async function () {
    const factory = new IDBFactory()
    const store = webKeyStore({ indexedDB: factory })
    await store.save(sample())
    const db = await new Promise<IDBDatabase>(resolve => {
      const request = factory.open(KEY_DATABASE, 1)
      request.onsuccess = () => {
        resolve(request.result)
      }
    })
    const transaction = db.transaction('keys', 'readwrite')
    transaction
      .objectStore('keys')
      .put(
        { iv: new Uint8Array(12), ciphertext: new ArrayBuffer(40) },
        'record'
      )
    await new Promise(resolve => {
      transaction.oncomplete = resolve
    })
    db.close()
    const before = await raw(factory)
    const calls: string[] = []
    const client = {
      registerChatDevice: async () => {
        calls.push('enroll')
      }
    } as unknown as ChatKeysClient
    let failed: unknown
    await ensureEnrolled({
      client,
      store,
      userId: userIdOfGumbo(12),
      device: { name: 'Test Browser', platform: 'web' }
    }).catch((error: unknown) => {
      failed = error
    })
    expect(failed).instanceOf(Error)
    expect(calls).deep.equals([])
    expect(await raw(factory)).deep.equals(before)
    expect(await store.exists()).equals(true)
  })

  async function installJson(factory: IDBFactory, text: string): Promise<void> {
    const store = webKeyStore({ indexedDB: factory })
    await store.save(sample())
    const wrap = (await raw(factory)).get('wrap') as CryptoKey
    const iv = new Uint8Array(12)
    const ciphertext = await globalThis.crypto.subtle.encrypt(
      { name: 'AES-GCM', iv, additionalData: utf8('ts-chat/v1/key-record') },
      wrap,
      utf8(text)
    )
    const db = await new Promise<IDBDatabase>(resolve => {
      const request = factory.open(KEY_DATABASE, 1)
      request.onsuccess = () => {
        resolve(request.result)
      }
    })
    const transaction = db.transaction('keys', 'readwrite')
    transaction.objectStore('keys').put({ iv, ciphertext }, 'record')
    await new Promise(resolve => {
      transaction.oncomplete = resolve
    })
    db.close()
  }

  it('preserves malformed persisted key bytes and blocks automatic enrollment', async () => {
    for (const key of ['AA', '*'.repeat(43)]) {
      const factory = new IDBFactory()
      const rawRecord = structuredClone(legacyRecord)
      rawRecord.device.box.secretKey = key
      await installJson(factory, JSON.stringify(rawRecord))
      const before = await raw(factory)
      const store = webKeyStore({ indexedDB: factory })
      const calls: string[] = []
      const client = {
        registerChatDevice: async () => {
          calls.push('enroll')
        }
      } as unknown as ChatKeysClient
      let failed: unknown
      await ensureEnrolled({
        client,
        store,
        userId: userIdOfGumbo(42),
        device: { name: 'Test Browser', platform: 'web' }
      }).catch((error: unknown) => {
        failed = error
      })
      expect(failed).instanceOf(Error)
      expect(calls).deep.equals([])
      expect(await raw(factory)).deep.equals(before)
      expect(await store.exists()).equals(true)
    }
  })

  it('reads v1 under the original wrapping key and preserves it across a failed v2 save', async () => {
    const factory = new IDBFactory()
    const text = JSON.stringify(legacyRecord)
    await installJson(factory, text)
    const before = await raw(factory)
    const store = webKeyStore({ indexedDB: factory })
    const record = await store.load()
    expect(record).deep.equals(recordFromJson(text))
    const brokenSubtle = new Proxy(globalThis.crypto.subtle, {
      get(target, key) {
        if (key === 'encrypt')
          return async () => {
            throw new Error('Save denied')
          }
        const value = Reflect.get(target, key)
        return typeof value === 'function' ? value.bind(target) : value
      }
    })
    let failed: unknown
    await webKeyStore({ indexedDB: factory, subtle: brokenSubtle })
      .save(record!)
      .catch((error: unknown) => {
        failed = error
      })
    expect(String(failed)).contains('Save denied')
    expect(await raw(factory)).deep.equals(before)
    expect(await store.load()).deep.equals(record)
    await store.save(record!)
    const after = await raw(factory)
    expect(await fingerprint(after.get('wrap'))).equals(
      await fingerprint(before.get('wrap'))
    )
    const saved = after.get('record')
    const plain = await globalThis.crypto.subtle.decrypt(
      {
        name: 'AES-GCM',
        iv: saved.iv,
        additionalData: utf8('ts-chat/v1/key-record')
      },
      after.get('wrap'),
      saved.ciphertext
    )
    expect(JSON.parse(Buffer.from(plain).toString()).version).equals(2)
    expect(await store.load()).deep.equals(record)
  })

  it('keeps authenticated unknown JSON and a record with a missing wrapping key', async () => {
    const factory = new IDBFactory()
    await installJson(factory, JSON.stringify({ ...legacyRecord, version: 9 }))
    const store = webKeyStore({ indexedDB: factory })
    let failed: unknown
    const before = await raw(factory)
    await store.load().catch((error: unknown) => {
      failed = error
    })
    expect(String(failed)).contains('Unknown chat key record version')
    expect(await raw(factory)).deep.equals(before)
    const db = await new Promise<IDBDatabase>(resolve => {
      const request = factory.open(KEY_DATABASE, 1)
      request.onsuccess = () => {
        resolve(request.result)
      }
    })
    const transaction = db.transaction('keys', 'readwrite')
    transaction.objectStore('keys').delete('wrap')
    await new Promise(resolve => {
      transaction.oncomplete = resolve
    })
    db.close()
    failed = undefined
    await store.load().catch((error: unknown) => {
      failed = error
    })
    expect(String(failed)).contains('wrapping key is missing')
    expect((await raw(factory)).get('record')).deep.equals(before.get('record'))
  })

  it('says whether a record is kept, and makes no database to say so', async function () {
    const factory = new IDBFactory()
    const store = webKeyStore({ indexedDB: factory })
    expect(await store.exists()).equals(false)
    expect((await factory.databases()).map(found => found.name)).not.includes(
      KEY_DATABASE
    )
    await store.save(sample())
    expect(await store.exists()).equals(true)
    // A wiped database stays, with no record in it.
    await store.wipe()
    expect(await store.exists()).equals(false)
  })

  it('wipes the record and its wrapping key', async function () {
    const factory = new IDBFactory()
    const store = webKeyStore({ indexedDB: factory })
    await store.save(sample())
    const wrap = await fingerprint((await raw(factory)).get('wrap'))
    await store.wipe()
    expect((await raw(factory)).size).equals(0)
    expect(await store.load()).equals(undefined)
    await store.save(sample())
    expect(await fingerprint((await raw(factory)).get('wrap'))).not.equals(wrap)
    expect((await store.load())?.deviceId).equals('cdv_web')
  })

  it('uses the page’s own IndexedDB by default', async function () {
    const held = Object.getOwnPropertyDescriptor(globalThis, 'indexedDB')
    Object.defineProperty(globalThis, 'indexedDB', {
      configurable: true,
      value: new IDBFactory()
    })
    try {
      expect(await keyStore.load()).equals(undefined)
      await keyStore.save(sample())
      expect((await keyStore.load())?.userId).equals(userIdOfGumbo(12))
      await keyStore.wipe()
      expect(await keyStore.load()).equals(undefined)
    } finally {
      if (held == null) delete (globalThis as { indexedDB?: unknown }).indexedDB
      else Object.defineProperty(globalThis, 'indexedDB', held)
    }
  })

  it('surfaces a database that will not open', async function () {
    const broken = {
      open: () => {
        const request: any = { error: new Error('blocked') }
        setTimeout(() => request.onerror())
        return request
      }
    } as unknown as IDBFactory
    let failed: unknown
    await webKeyStore({ indexedDB: broken })
      .load()
      .catch((error: unknown) => {
        failed = error
      })
    expect(String(failed)).contains('blocked')
  })
})
