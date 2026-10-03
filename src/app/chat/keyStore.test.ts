import { expect } from 'chai'
import { IDBFactory } from 'fake-indexeddb'
import { describe, it } from 'mocha'

import { newDeviceKeys } from '../../common/chatCrypto/keys'
import { b64, type ChatKeyRecord, newRecord, recordToJson } from './keyRecord'
import { KEY_DATABASE, keyStore, webKeyStore } from './keyStore'

/** U11: the browser's store, on an in-memory IndexedDB and Node's WebCrypto. */
describe('chat key store in the browser', function () {
  const sample = (): ChatKeyRecord => ({
    ...newRecord(12, 'cdv_web', newDeviceKeys()),
    pins: { 3: 'AQID' }
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
    expect((await first.load())?.userId).equals(12)
    const wrap = await fingerprint((await raw(factory)).get('wrap'))
    await first.save(sample())
    expect(await fingerprint((await raw(factory)).get('wrap'))).equals(wrap)
    expect((await second.load())?.userId).equals(12)
  })

  it('reads a damaged record as none', async function () {
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
    expect(await store.load()).equals(undefined)
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
      expect((await keyStore.load())?.userId).equals(12)
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
