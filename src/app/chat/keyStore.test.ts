import { expect } from 'chai'
import { IDBFactory } from 'fake-indexeddb'
import { describe, it } from 'mocha'

import { utf8 } from '../../common/chatCrypto/bytes'
import { newDeviceKeys } from '../../common/chatCrypto/keys'
import { userIdOfGumbo } from '../../common/userId'
import legacyRecord from '../../test/legacyChatKeyRecord.json'
import {
  type ChatKeysClient,
  ensureEnrolled,
  resetUnreadableChat
} from './engine/links'
import {
  b64,
  type ChatKeyRecord,
  newRecord,
  recordFromJson,
  recordToJson,
  UnreadableKeyRecordError
} from './keyRecord'
import {
  KEY_DATABASE,
  keyStore,
  LEGACY_RECORD_KEY,
  recordKey,
  webKeyStore
} from './keyStore'

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
    expect(await store.load(userIdOfGumbo(12))).equals(undefined)
  })

  it('round-trips a record, sealed under a key nobody can read', async function () {
    const factory = new IDBFactory()
    const store = webKeyStore({ indexedDB: factory })
    const record = sample()
    await store.save(record)
    const back = await store.load(record.userId)
    expect(back == null ? undefined : recordToJson(back)).equals(
      recordToJson(record)
    )

    const kept = await raw(factory)
    expect([...kept.keys()].sort()).deep.equals([
      recordKey(record.userId),
      'wrap'
    ])
    const wrap = kept.get('wrap') as CryptoKey
    expect(wrap.extractable).equals(false)
    expect(wrap.algorithm).deep.include({ name: 'AES-GCM', length: 256 })
    let exported = true
    await globalThis.crypto.subtle.exportKey('raw', wrap).catch(() => {
      exported = false
    })
    expect(exported).equals(false)
    const sealed = kept.get(recordKey(record.userId)) as {
      iv: Uint8Array
      ciphertext: ArrayBuffer
    }
    expect(sealed.iv.length).equals(12)
    const bytes = Buffer.from(sealed.ciphertext).toString('latin1')
    expect(bytes).not.contains(b64(record.device.box.secretKey))
    expect(bytes).not.contains('cdv_web')

    // Another page of the same site reads the same record.
    const again = await webKeyStore({ indexedDB: factory }).load(record.userId)
    expect(again?.deviceId).equals('cdv_web')
  })

  it('keeps one wrapping key, even when two pages make one at once', async function () {
    const factory = new IDBFactory()
    const first = webKeyStore({ indexedDB: factory })
    const second = webKeyStore({ indexedDB: factory })
    await Promise.all([first.save(sample()), second.save(sample())])
    expect((await first.load(userIdOfGumbo(12)))?.userId).equals(
      userIdOfGumbo(12)
    )
    const wrap = await fingerprint((await raw(factory)).get('wrap'))
    await first.save(sample())
    expect(await fingerprint((await raw(factory)).get('wrap'))).equals(wrap)
    expect((await second.load(userIdOfGumbo(12)))?.userId).equals(
      userIdOfGumbo(12)
    )
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
        recordKey(userIdOfGumbo(12))
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
    expect(await store.exists(userIdOfGumbo(12))).equals(true)
  })

  /** Seals `text` into that record's account slot and returns the account. */
  async function installJson(
    factory: IDBFactory,
    text: string
  ): Promise<string> {
    const store = webKeyStore({ indexedDB: factory })
    await store.save(sample())
    let userId = userIdOfGumbo(12)
    try {
      const parsed = JSON.parse(text) as { userId?: number | string }
      if (typeof parsed.userId === 'number')
        userId = userIdOfGumbo(parsed.userId)
      else if (typeof parsed.userId === 'string') userId = parsed.userId
    } catch {
      // Not JSON: it replaces the sample account's slot.
    }
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
    const keys = transaction.objectStore('keys')
    keys.put({ iv, ciphertext }, recordKey(userId))
    if (userId !== userIdOfGumbo(12)) keys.delete(recordKey(userIdOfGumbo(12)))
    await new Promise(resolve => {
      transaction.oncomplete = resolve
    })
    db.close()
    return userId
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
      expect(await store.exists(userIdOfGumbo(42))).equals(true)
    }
  })

  it('reads v1 under the original wrapping key and preserves it across a failed v2 save', async () => {
    const factory = new IDBFactory()
    const text = JSON.stringify(legacyRecord)
    await installJson(factory, text)
    const before = await raw(factory)
    const store = webKeyStore({ indexedDB: factory })
    const record = await store.load(userIdOfGumbo(42))
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
    expect(await store.load(userIdOfGumbo(42))).deep.equals(record)
    await store.save(record!)
    const after = await raw(factory)
    expect(await fingerprint(after.get('wrap'))).equals(
      await fingerprint(before.get('wrap'))
    )
    const saved = after.get(recordKey(userIdOfGumbo(42)))
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
    expect(await store.load(userIdOfGumbo(42))).deep.equals(record)
  })

  it('keeps authenticated unknown JSON and a record with a missing wrapping key', async () => {
    const factory = new IDBFactory()
    await installJson(factory, JSON.stringify({ ...legacyRecord, version: 9 }))
    const store = webKeyStore({ indexedDB: factory })
    let failed: unknown
    const before = await raw(factory)
    await store.load(userIdOfGumbo(42)).catch((error: unknown) => {
      failed = error
    })
    expect(String(failed)).contains('Unknown chat key record version')
    expect(failed).instanceOf(UnreadableKeyRecordError)
    expect((failed as UnreadableKeyRecordError).reason).equals('unknownVersion')
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
    await store.load(userIdOfGumbo(42)).catch((error: unknown) => {
      failed = error
    })
    expect(String(failed)).contains('wrapping key is missing')
    expect((failed as UnreadableKeyRecordError).reason).equals(
      'wrappingKeyMissing'
    )
    expect((await raw(factory)).get(recordKey(userIdOfGumbo(42)))).deep.equals(
      before.get(recordKey(userIdOfGumbo(42)))
    )
  })

  it('names why a kept record is unreadable, without its text, and keeps it', async () => {
    const cases: Array<[string, (factory: IDBFactory) => Promise<void>]> = [
      [
        'invalid',
        async factory => {
          await installJson(factory, '{"secret":"do-not-log"')
        }
      ],
      [
        'undecryptable',
        async factory => {
          await installJson(factory, JSON.stringify(legacyRecord))
          const db = await new Promise<IDBDatabase>(resolve => {
            const request = factory.open(KEY_DATABASE, 1)
            request.onsuccess = () => {
              resolve(request.result)
            }
          })
          const transaction = db.transaction('keys', 'readwrite')
          const keys = transaction.objectStore('keys')
          const sealed = await new Promise<any>(resolve => {
            const request = keys.get(recordKey(userIdOfGumbo(42)))
            request.onsuccess = () => {
              resolve(request.result)
            }
          })
          const bytes = new Uint8Array(sealed.ciphertext as ArrayBuffer)
          bytes[0] ^= 1
          keys.put(
            { iv: sealed.iv, ciphertext: bytes.buffer },
            recordKey(userIdOfGumbo(42))
          )
          await new Promise(resolve => {
            transaction.oncomplete = resolve
          })
          db.close()
        }
      ]
    ]
    for (const [reason, install] of cases) {
      const factory = new IDBFactory()
      await install(factory)
      const before = await raw(factory)
      const failed = await webKeyStore({ indexedDB: factory })
        .load(reason === 'invalid' ? userIdOfGumbo(12) : userIdOfGumbo(42))
        .catch((error: unknown) => error)
      expect(failed, reason).instanceOf(UnreadableKeyRecordError)
      expect((failed as UnreadableKeyRecordError).reason).equals(reason)
      expect(String(failed)).not.contains('do-not-log')
      expect(await raw(factory)).deep.equals(before)
    }
  })

  it('does not call a store with no crypto to open it an unreadable record', async () => {
    const factory = new IDBFactory()
    await installJson(factory, JSON.stringify(legacyRecord))
    const noDecrypt = new Proxy(globalThis.crypto.subtle, {
      get(target, key) {
        if (key === 'decrypt')
          return async () => {
            throw new TypeError('crypto.subtle is unavailable')
          }
        const value = Reflect.get(target, key)
        return typeof value === 'function' ? value.bind(target) : value
      }
    })
    const failed = await webKeyStore({ indexedDB: factory, subtle: noDecrypt })
      .load(userIdOfGumbo(42))
      .catch((error: unknown) => error)
    expect(failed).instanceOf(TypeError)
    expect(failed).not.instanceOf(UnreadableKeyRecordError)
  })

  it('says whether a record is kept, and makes no database to say so', async function () {
    const factory = new IDBFactory()
    const store = webKeyStore({ indexedDB: factory })
    expect(await store.exists(userIdOfGumbo(12))).equals(false)
    expect(await store.load(userIdOfGumbo(12))).equals(undefined)
    expect((await factory.databases()).map(found => found.name)).not.includes(
      KEY_DATABASE
    )
    await store.save(sample())
    expect(await store.exists(userIdOfGumbo(12))).equals(true)
    // A wiped database stays, with no record in it.
    await store.wipe(userIdOfGumbo(12))
    expect(await store.exists(userIdOfGumbo(12))).equals(false)
  })

  it('wipes the record and its wrapping key', async function () {
    const factory = new IDBFactory()
    const store = webKeyStore({ indexedDB: factory })
    await store.save(sample())
    const wrap = await fingerprint((await raw(factory)).get('wrap'))
    await store.wipe(userIdOfGumbo(12))
    expect((await raw(factory)).size).equals(0)
    expect(await store.load(userIdOfGumbo(12))).equals(undefined)
    await store.save(sample())
    expect(await fingerprint((await raw(factory)).get('wrap'))).not.equals(wrap)
    expect((await store.load(userIdOfGumbo(12)))?.deviceId).equals('cdv_web')
  })

  it('uses the page’s own IndexedDB by default', async function () {
    const held = Object.getOwnPropertyDescriptor(globalThis, 'indexedDB')
    Object.defineProperty(globalThis, 'indexedDB', {
      configurable: true,
      value: new IDBFactory()
    })
    try {
      expect(await keyStore.load(userIdOfGumbo(12))).equals(undefined)
      await keyStore.save(sample())
      expect((await keyStore.load(userIdOfGumbo(12)))?.userId).equals(
        userIdOfGumbo(12)
      )
      await keyStore.wipe(userIdOfGumbo(12))
      expect(await keyStore.load(userIdOfGumbo(12))).equals(undefined)
    } finally {
      if (held == null) delete (globalThis as { indexedDB?: unknown }).indexedDB
      else Object.defineProperty(globalThis, 'indexedDB', held)
    }
  })

  async function openDb(factory: IDBFactory): Promise<IDBDatabase> {
    return await new Promise((resolve, reject) => {
      const request = factory.open(KEY_DATABASE, 1)
      request.onsuccess = () => {
        resolve(request.result)
      }
      request.onerror = () => {
        reject(request.error ?? new Error('cannot open'))
      }
    })
  }

  async function withStore(
    factory: IDBFactory,
    write: (keys: IDBObjectStore) => void
  ): Promise<void> {
    const db = await openDb(factory)
    const transaction = db.transaction('keys', 'readwrite')
    write(transaction.objectStore('keys'))
    await new Promise(resolve => {
      transaction.oncomplete = resolve
    })
    db.close()
  }

  async function slotValue(factory: IDBFactory, key: string): Promise<any> {
    const db = await openDb(factory)
    const keys = db.transaction('keys', 'readonly').objectStore('keys')
    const value = await new Promise(resolve => {
      const request = keys.get(key)
      request.onsuccess = () => {
        resolve(request.result)
      }
    })
    db.close()
    return value
  }

  /** Moves a sealed slot. The blob itself is unchanged. */
  async function moveSlot(
    factory: IDBFactory,
    from: string,
    to: string
  ): Promise<void> {
    const value = await slotValue(factory, from)
    await withStore(factory, keys => {
      keys.put(value, to)
      keys.delete(from)
    })
  }

  async function damage(factory: IDBFactory, key: string): Promise<void> {
    const sealed = await slotValue(factory, key)
    const bytes = new Uint8Array(sealed.ciphertext as ArrayBuffer)
    bytes[0] ^= 1
    await withStore(factory, keys => {
      keys.put({ iv: sealed.iv, ciphertext: bytes.buffer }, key)
    })
  }

  /**
   * The next `put` or `delete` of `key` fails its transaction and writes
   * nothing.
   */
  async function failOp(
    factory: IDBFactory,
    method: 'put' | 'delete',
    key: string
  ): Promise<() => void> {
    const db = await openDb(factory)
    const proto = Object.getPrototypeOf(
      db.transaction('keys', 'readonly').objectStore('keys')
    ) as Record<'put' | 'delete', (...args: unknown[]) => IDBRequest>
    db.close()
    const original = proto[method]
    proto[method] = function (
      this: {
        transaction: {
          _execRequestAsync: (op: {
            operation: () => never
            source: unknown
          }) => IDBRequest
        }
      },
      ...args: unknown[]
    ) {
      const asked = method === 'put' ? args[1] : args[0]
      if (asked === key) {
        return this.transaction._execRequestAsync({
          operation: () => {
            throw new Error(`${method} refused`)
          },
          source: this
        })
      }
      return original.apply(this, args)
    }
    return () => {
      proto[method] = original
    }
  }

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

  it('keeps account A and account B in their own slots', async function () {
    const factory = new IDBFactory()
    const store = webKeyStore({ indexedDB: factory })
    const a = sample()
    const b = newRecord(userIdOfGumbo(13), 'cdv_b', newDeviceKeys())
    expect(await store.exists(b.userId)).equals(false)
    expect((await factory.databases()).map(found => found.name)).not.includes(
      KEY_DATABASE
    )
    await store.save(a)
    await store.save(b)
    expect((await store.load(a.userId))?.deviceId).equals('cdv_web')
    expect((await store.load(b.userId))?.deviceId).equals('cdv_b')
    expect(await store.exists(a.userId)).equals(true)
    await store.wipe(a.userId)
    expect(await store.load(a.userId)).equals(undefined)
    expect(await store.exists(a.userId)).equals(false)
    expect((await store.load(b.userId))?.deviceId).equals('cdv_b')
    expect((await raw(factory)).has('wrap')).equals(true)
    await store.wipe(b.userId)
    expect((await raw(factory)).has('wrap')).equals(false)
  })

  it('copies the legacy record into the account slot, then deletes the legacy slot', async function () {
    const factory = new IDBFactory()
    const store = webKeyStore({ indexedDB: factory })
    const a = sample()
    const b = newRecord(userIdOfGumbo(13), 'cdv_b', newDeviceKeys())
    await store.save(a)
    await moveSlot(factory, recordKey(a.userId), LEGACY_RECORD_KEY)
    const legacy = (await raw(factory)).get(LEGACY_RECORD_KEY)
    expect(await store.load(b.userId)).equals(undefined)
    expect((await raw(factory)).get(LEGACY_RECORD_KEY)).deep.equals(legacy)
    expect((await store.load(a.userId))?.deviceId).equals('cdv_web')
    const kept = await raw(factory)
    expect(kept.has(LEGACY_RECORD_KEY)).equals(false)
    expect(kept.get(recordKey(a.userId))).deep.equals(legacy)
  })

  it('does not overwrite a per-account record, and deletes the legacy slot when it is the same account', async function () {
    const factory = new IDBFactory()
    const store = webKeyStore({ indexedDB: factory })
    const a = sample()
    await store.save({ ...a, deviceId: 'cdv_old' })
    await moveSlot(factory, recordKey(a.userId), LEGACY_RECORD_KEY)
    await store.save(a)
    const own = (await raw(factory)).get(recordKey(a.userId))
    expect((await store.load(a.userId))?.deviceId).equals('cdv_web')
    const kept = await raw(factory)
    expect(kept.get(recordKey(a.userId))).deep.equals(own)
    expect(kept.has(LEGACY_RECORD_KEY)).equals(false)
  })

  it('a failed per-account write leaves the legacy slot', async function () {
    const factory = new IDBFactory()
    const store = webKeyStore({ indexedDB: factory })
    const a = sample()
    await store.save(a)
    await moveSlot(factory, recordKey(a.userId), LEGACY_RECORD_KEY)
    const before = await raw(factory)
    const restore = await failOp(factory, 'put', recordKey(a.userId))
    try {
      const failed = await store.load(a.userId).catch((error: unknown) => error)
      expect(failed).instanceOf(Error)
    } finally {
      restore()
    }
    expect(await raw(factory)).deep.equals(before)
  })

  it('a failed legacy delete leaves the per-account record, and the next load deletes the legacy slot', async function () {
    const factory = new IDBFactory()
    const store = webKeyStore({ indexedDB: factory })
    const a = sample()
    await store.save(a)
    const sealed = (await raw(factory)).get(recordKey(a.userId))
    await moveSlot(factory, recordKey(a.userId), LEGACY_RECORD_KEY)
    const restore = await failOp(factory, 'delete', LEGACY_RECORD_KEY)
    try {
      const failed = await store.load(a.userId).catch((error: unknown) => error)
      expect(failed).instanceOf(Error)
    } finally {
      restore()
    }
    const midway = await raw(factory)
    expect(midway.get(recordKey(a.userId))).deep.equals(sealed)
    expect(midway.has(LEGACY_RECORD_KEY)).equals(true)
    expect((await store.load(a.userId))?.deviceId).equals('cdv_web')
    expect((await raw(factory)).has(LEGACY_RECORD_KEY)).equals(false)
  })

  it('an unreadable legacy record throws from load and exists and stays', async function () {
    const factory = new IDBFactory()
    const store = webKeyStore({ indexedDB: factory })
    const a = sample()
    await store.save(a)
    await moveSlot(factory, recordKey(a.userId), LEGACY_RECORD_KEY)
    await damage(factory, LEGACY_RECORD_KEY)
    const before = await raw(factory)
    const loaded = await store.load(a.userId).catch((error: unknown) => error)
    expect(loaded).instanceOf(UnreadableKeyRecordError)
    expect((loaded as UnreadableKeyRecordError).reason).equals('undecryptable')
    const existed = await store
      .exists(a.userId)
      .catch((error: unknown) => error)
    expect(existed).instanceOf(UnreadableKeyRecordError)
    expect(await raw(factory)).deep.equals(before)
  })

  it('an unreadable per-account slot does not read the legacy slot', async function () {
    const factory = new IDBFactory()
    const store = webKeyStore({ indexedDB: factory })
    const a = sample()
    const b = newRecord(userIdOfGumbo(13), 'cdv_b', newDeviceKeys())
    await store.save(a)
    await store.save(b)
    await moveSlot(factory, recordKey(b.userId), LEGACY_RECORD_KEY)
    await damage(factory, recordKey(a.userId))
    const before = await raw(factory)
    const loaded = await store.load(a.userId).catch((error: unknown) => error)
    expect((loaded as UnreadableKeyRecordError).reason).equals('undecryptable')
    expect(await raw(factory)).deep.equals(before)
    expect((await store.load(b.userId))?.deviceId).equals('cdv_b')
  })

  it('exists on a present per-account slot returns true without parsing it', async function () {
    const factory = new IDBFactory()
    const store = webKeyStore({ indexedDB: factory })
    await store.save(sample())
    await withStore(factory, keys => {
      keys.put({ nope: true }, recordKey(userIdOfGumbo(12)))
    })
    const before = await raw(factory)
    expect(await store.exists(userIdOfGumbo(12))).equals(true)
    expect(await raw(factory)).deep.equals(before)
  })

  it('load and exists keep a per-account record when the legacy slot is unreadable', async function () {
    const factory = new IDBFactory()
    const store = webKeyStore({ indexedDB: factory })
    const a = sample()
    await store.save(a)
    await withStore(factory, keys => {
      keys.put(
        { iv: new Uint8Array(12), ciphertext: new ArrayBuffer(8) },
        LEGACY_RECORD_KEY
      )
    })
    expect((await store.load(a.userId))?.deviceId).equals('cdv_web')
    expect(await store.exists(a.userId)).equals(true)
    expect((await raw(factory)).has(LEGACY_RECORD_KEY)).equals(true)
  })

  it("reset of an unreadable account leaves another account's legacy record", async function () {
    const factory = new IDBFactory()
    const store = webKeyStore({ indexedDB: factory })
    const a = sample()
    const b = newRecord(userIdOfGumbo(13), 'cdv_b', newDeviceKeys())
    await store.save(a)
    await store.save(b)
    await moveSlot(factory, recordKey(b.userId), LEGACY_RECORD_KEY)
    await damage(factory, recordKey(a.userId))
    const legacy = (await raw(factory)).get(LEGACY_RECORD_KEY)
    const { client, revoked } = resetClient(a.deviceId)
    await resetUnreadableChat({ client, store, userId: a.userId })
    expect(revoked).deep.equals([a.deviceId])
    const kept = await raw(factory)
    expect(kept.has(recordKey(a.userId))).equals(false)
    expect(kept.get(LEGACY_RECORD_KEY)).deep.equals(legacy)
    expect(kept.has('wrap')).equals(true)
    expect((await store.load(b.userId))?.deviceId).equals('cdv_b')
  })

  it('reset deletes a legacy record that is this account or unreadable', async function () {
    for (const legacyOf of ['same', 'unreadable'] as const) {
      const factory = new IDBFactory()
      const store = webKeyStore({ indexedDB: factory })
      const a = sample()
      await store.save(a)
      if (legacyOf === 'same') {
        const sealed = await slotValue(factory, recordKey(a.userId))
        await withStore(factory, keys => {
          keys.put(sealed, LEGACY_RECORD_KEY)
        })
      } else {
        await withStore(factory, keys => {
          keys.put(
            { iv: new Uint8Array(12), ciphertext: new ArrayBuffer(8) },
            LEGACY_RECORD_KEY
          )
        })
      }
      await damage(factory, recordKey(a.userId))
      const { client } = resetClient(a.deviceId)
      await resetUnreadableChat({ client, store, userId: a.userId })
      const kept = await raw(factory)
      expect(kept.has(recordKey(a.userId))).equals(false)
      expect(kept.has(LEGACY_RECORD_KEY)).equals(false)
      expect(kept.has('wrap')).equals(false)
    }
  })

  it('the wrapping key stays while a legacy record remains', async function () {
    const factory = new IDBFactory()
    const store = webKeyStore({ indexedDB: factory })
    const a = sample()
    const b = newRecord(userIdOfGumbo(13), 'cdv_b', newDeviceKeys())
    await store.save(a)
    await store.save(b)
    await moveSlot(factory, recordKey(b.userId), LEGACY_RECORD_KEY)
    await store.wipe(a.userId)
    expect((await raw(factory)).has('wrap')).equals(true)
    expect((await raw(factory)).has(LEGACY_RECORD_KEY)).equals(true)
  })

  it('surfaces a database that will not open', async function () {
    const broken = {
      databases: async () => [{ name: KEY_DATABASE }],
      open: () => {
        const request: any = { error: new Error('blocked') }
        setTimeout(() => request.onerror())
        return request
      }
    } as unknown as IDBFactory
    let failed: unknown
    await webKeyStore({ indexedDB: broken })
      .load(userIdOfGumbo(12))
      .catch((error: unknown) => {
        failed = error
      })
    expect(String(failed)).contains('blocked')
  })

  it('shares one databases() call across overlapping loads', async function () {
    const factory = new IDBFactory()
    let calls = 0
    let release: () => void = () => undefined
    const gate = new Promise<void>(resolve => {
      release = resolve
    })
    const databases = factory.databases.bind(factory)
    factory.databases = async () => {
      calls += 1
      await gate
      return await databases()
    }
    const store = webKeyStore({ indexedDB: factory })
    const first = store.load(userIdOfGumbo(12))
    const second = store.load(userIdOfGumbo(12))
    release()
    expect(await first).equals(undefined)
    expect(await second).equals(undefined)
    expect(calls).equals(1)
    expect(await factory.databases()).deep.equals([])
  })

  it('rejects a databases() that never settles, then loads again', async function () {
    this.timeout(12000)
    const started = Date.now()
    let hung = true
    const factory = {
      databases: () =>
        hung ? new Promise(() => undefined) : Promise.resolve([]),
      open: () => {
        throw new Error('must not open')
      }
    } as unknown as IDBFactory
    const store = webKeyStore({ indexedDB: factory })
    let failed: unknown
    await store.load(userIdOfGumbo(12)).catch((error: unknown) => {
      failed = error
    })
    expect(failed).instanceOf(Error)
    expect((failed as Error).message).equals('Chat keys could not be opened')
    expect(Date.now() - started).to.be.below(6000)
    hung = false
    expect(await store.load(userIdOfGumbo(12))).equals(undefined)
  })

  it('rejects an open() that never settles, then loads again', async function () {
    this.timeout(12000)
    const started = Date.now()
    let hung = true
    const factory = {
      databases: async () => (hung ? [{ name: KEY_DATABASE }] : []),
      open: () => ({}) as IDBOpenDBRequest
    } as unknown as IDBFactory
    const store = webKeyStore({ indexedDB: factory })
    let failed: unknown
    await store.load(userIdOfGumbo(12)).catch((error: unknown) => {
      failed = error
    })
    expect(failed).instanceOf(Error)
    expect((failed as Error).message).equals('Chat keys could not be opened')
    expect(Date.now() - started).to.be.below(6000)
    hung = false
    expect(await store.load(userIdOfGumbo(12))).equals(undefined)
  })

  it('closes the open connection on pagehide and loads the saved record afterwards', async function () {
    const factory = new IDBFactory()
    let opens = 0
    let closes = 0
    const store = webKeyStore({
      indexedDB: factory,
      onOpen(db) {
        opens += 1
        if (opens !== 2) return
        const close = db.close.bind(db)
        db.close = () => {
          closes += 1
          close()
        }
        const PageEvent = document.defaultView?.Event ?? Event
        document.dispatchEvent(new PageEvent('pagehide'))
      }
    })
    const record = sample()
    await store.save(record)
    await store.load(record.userId).catch(() => undefined)
    expect(closes).to.be.greaterThan(0)
    const loaded = await store.load(record.userId)
    expect(loaded?.userId).equals(record.userId)
    expect(loaded?.deviceId).equals(record.deviceId)
  })
})
