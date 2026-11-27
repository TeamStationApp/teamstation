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
      databases: async () =>
        hung ? await new Promise(() => undefined) : await Promise.resolve([]),
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
      // A request that never answers.
      open: () => ({})
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

  it('loads a record saved just before, while an older databases() was still answering', async function () {
    const factory = new IDBFactory()
    let release: () => void = () => undefined
    const gate = new Promise<void>(resolve => {
      release = resolve
    })
    const databases = factory.databases.bind(factory)
    factory.databases = async () => {
      await gate
      return await databases()
    }
    const store = webKeyStore({ indexedDB: factory })
    const record = sample()
    const saving = store.save(record)
    // Asks the list now, before the save made `ts-chat`.
    const loading = store.load(record.userId)
    release()
    await saving
    expect((await loading)?.userId).equals(record.userId)
  })

  it('saves while a databases() asked by another call never settles', async function () {
    this.timeout(12000)
    const factory = new IDBFactory()
    factory.databases = async () => await new Promise(() => undefined)
    const store = webKeyStore({ indexedDB: factory })
    const record = sample()
    const loading = store.load(record.userId).catch((error: unknown) => error)
    await store.save(record)
    expect(await loading).instanceOf(Error)
    expect((await raw(factory)).has(recordKey(record.userId))).equals(true)
  })

  it('closes a connection that opens after its open gave up', async function () {
    this.timeout(12000)
    let request: any
    const factory = {
      databases: async () => [{ name: KEY_DATABASE }],
      open: () => {
        request = { readyState: 'pending' }
        return request
      }
    } as unknown as IDBFactory
    const failed = await webKeyStore({ indexedDB: factory })
      .load(userIdOfGumbo(12))
      .catch((error: unknown) => error)
    expect((failed as Error).message).equals('Chat keys could not be opened')
    let closed = false
    request.result = {
      close() {
        closed = true
      }
    }
    request.onsuccess()
    expect(closed).equals(true)
  })

  it('moves on from a read that never settles', async function () {
    this.timeout(12000)
    const factory = new IDBFactory()
    let stall = false
    const store = webKeyStore({
      indexedDB: factory,
      onOpen(db) {
        if (!stall) return
        stall = false
        db.transaction = (() => ({
          objectStore: () => ({ get: () => ({}) })
        })) as unknown as IDBDatabase['transaction']
      }
    })
    const record = sample()
    await store.save(record)
    stall = true
    const failed = await store
      .load(record.userId)
      .catch((error: unknown) => error)
    expect((failed as Error).message).equals('Chat keys could not be opened')
    expect((await store.load(record.userId))?.userId).equals(record.userId)
  })

  it('a queued load whose listing fails before its turn leaves no unhandled rejection', async function () {
    const factory = new IDBFactory()
    factory.databases = async () => {
      throw new Error('No list')
    }
    const subtle = globalThis.crypto.subtle
    const slow = {
      generateKey: subtle.generateKey.bind(subtle),
      decrypt: subtle.decrypt.bind(subtle),
      encrypt: async (...args: Parameters<SubtleCrypto['encrypt']>) => {
        await new Promise(resolve => setTimeout(resolve, 100))
        return await subtle.encrypt(...args)
      }
    } as unknown as SubtleCrypto
    const unhandled: unknown[] = []
    const note = (reason: unknown): void => {
      unhandled.push(reason)
    }
    process.on('unhandledRejection', note)
    try {
      const store = webKeyStore({ indexedDB: factory, subtle: slow })
      const record = sample()
      const saving = store.save(record)
      // Its listing fails at once, while the save still holds the queue.
      const loading = store.load(record.userId)
      await new Promise(resolve => setTimeout(resolve, 50))
      await saving
      // The save made `ts-chat` on this page, so the failed listing does not matter.
      expect((await loading)?.userId).equals(record.userId)
      await new Promise(resolve => setImmediate(resolve))
      expect(unhandled).deep.equals([])
    } finally {
      process.off('unhandledRejection', note)
    }
  })

  /**
   * Its readwrite transactions report their commit 5.2 s late, past the
   * step timeout, while `slow` is set. `abort()` is counted, and throws as a
   * committing transaction's does when `committing` is set.
   */
  function slowWrites(
    db: IDBDatabase,
    state: { slow: boolean; committing: boolean; aborts: number }
  ): void {
    const real = db.transaction.bind(db)
    db.transaction = ((...args: Parameters<IDBDatabase['transaction']>) => {
      const transaction = real(...args)
      if (!state.slow || args[1] !== 'readwrite') return transaction
      let complete: (() => void) | undefined
      transaction.addEventListener('complete', () => {
        setTimeout(() => complete?.(), 5200)
      })
      return new Proxy(transaction, {
        get(target, property) {
          if (property === 'abort')
            return () => {
              state.aborts += 1
              if (state.committing)
                throw new DOMException('Committing', 'InvalidStateError')
              target.abort()
            }
          const value: unknown = Reflect.get(target, property, target)
          return typeof value === 'function' ? value.bind(target) : value
        },
        set(target, property, value) {
          if (property === 'oncomplete') {
            complete = value as () => void
            return true
          }
          return Reflect.set(target, property, value, target)
        }
      })
    }) as IDBDatabase['transaction']
  }

  it('aborts a wipe that does not commit in time', async function () {
    this.timeout(12000)
    const factory = new IDBFactory()
    const state = { slow: false, committing: false, aborts: 0 }
    const store = webKeyStore({
      indexedDB: factory,
      onOpen(db) {
        const real = db.transaction.bind(db)
        db.transaction = ((...args: Parameters<IDBDatabase['transaction']>) => {
          if (!state.slow || args[1] !== 'readwrite') return real(...args)
          // A write whose commit is never reported.
          return {
            objectStore: () => ({ delete: () => ({}) }),
            abort() {
              state.aborts += 1
            }
          }
        }) as unknown as IDBDatabase['transaction']
      }
    })
    const record = sample()
    await store.save(record)
    state.slow = true
    const failed = await store
      .wipe(record.userId)
      .catch((error: unknown) => error)
    expect((failed as Error).message).equals('Chat keys could not be opened')
    expect(state.aborts).equals(1)
    expect((await raw(factory)).has(recordKey(record.userId))).equals(true)
  })

  it('reports a slow wipe that was already committing by how it ends', async function () {
    // Two writes, each reported just after its step timeout.
    this.timeout(20000)
    const factory = new IDBFactory()
    const state = { slow: false, committing: true, aborts: 0 }
    const store = webKeyStore({
      indexedDB: factory,
      onOpen(db) {
        slowWrites(db, state)
      }
    })
    const record = sample()
    await store.save(record)
    state.slow = true
    await store.wipe(record.userId)
    expect(state.aborts).equals(2)
    expect([...(await raw(factory)).keys()]).deep.equals([])
  })

  it('waits for a slow save, and never aborts it', async function () {
    // The wrapping key and the record, each committed 5.2 s late.
    this.timeout(20000)
    const factory = new IDBFactory()
    const state = { slow: true, committing: false, aborts: 0 }
    const store = webKeyStore({
      indexedDB: factory,
      onOpen(db) {
        slowWrites(db, state)
      }
    })
    const record = sample()
    await store.save(record)
    expect(state.aborts).equals(0)
    expect((await raw(factory)).has(recordKey(record.userId))).equals(true)
  })

  /** A step timeout short enough for tests, and a delay past it. */
  const STEP_MS = 50
  const PAST_STEP_MS = 150

  /** The request, with its success reported `ms` late: past the step timeout by default. */
  function late<R extends IDBRequest>(request: R, ms = PAST_STEP_MS): R {
    return new Proxy(request, {
      get(target, property) {
        const value: unknown = Reflect.get(target, property, target)
        return typeof value === 'function' ? value.bind(target) : value
      },
      set(target, property, value) {
        if (property !== 'onsuccess')
          return Reflect.set(target, property, value, target)
        const handler = value as (this: R, event: Event) => void
        target.onsuccess = event => {
          setTimeout(() => {
            handler.call(target, event)
          }, ms)
        }
        return true
      }
    })
  }

  it('waits for a save whose open answers past the step timeout', async function () {
    const factory = new IDBFactory()
    const slow = {
      databases: async () => await factory.databases(),
      open: (name: string, version?: number) =>
        late(factory.open(name, version))
    } as unknown as IDBFactory
    const record = sample()
    await webKeyStore({ indexedDB: slow, stepTimeoutMs: STEP_MS }).save(record)
    expect((await raw(factory)).has(recordKey(record.userId))).equals(true)
  })

  /** A store whose `get`s in transactions of `mode` answer past the step timeout. */
  function lateGets(
    factory: IDBFactory,
    mode: IDBTransactionMode
  ): ReturnType<typeof webKeyStore> {
    return webKeyStore({
      indexedDB: factory,
      stepTimeoutMs: STEP_MS,
      onOpen(db) {
        const real = db.transaction.bind(db)
        db.transaction = ((...args: Parameters<IDBDatabase['transaction']>) => {
          const transaction = real(...args)
          if ((args[1] ?? 'readonly') !== mode) return transaction
          const objectStore = transaction.objectStore.bind(transaction)
          transaction.objectStore = (name: string) => {
            const store = objectStore(name)
            const get = store.get.bind(store)
            store.get = (key: IDBValidKey | IDBKeyRange) => late(get(key))
            return store
          }
          return transaction
        }) as IDBDatabase['transaction']
      }
    })
  }

  it('waits for a save whose wrapping key read answers past the step timeout', async function () {
    const factory = new IDBFactory()
    const record = sample()
    await lateGets(factory, 'readonly').save(record)
    expect((await raw(factory)).has(recordKey(record.userId))).equals(true)
  })

  it('waits for a first save whose wrapping key check in its write answers past the step timeout', async function () {
    const factory = new IDBFactory()
    const puts: string[] = []
    const store = webKeyStore({
      indexedDB: factory,
      stepTimeoutMs: STEP_MS,
      onOpen(db) {
        const real = db.transaction.bind(db)
        db.transaction = ((...args: Parameters<IDBDatabase['transaction']>) => {
          if (args[1] !== 'readwrite') return real(...args)
          // No wrapping key yet: the save checks for a raced one inside its
          // write, and that check answers past the step timeout.
          const transaction: { oncomplete?: () => void } = {}
          const get = (): unknown => {
            const asked: { onsuccess?: () => void; result?: unknown } = {}
            setTimeout(() => {
              asked.onsuccess?.()
            }, PAST_STEP_MS)
            return asked
          }
          return Object.assign(transaction, {
            objectStore: () => ({
              get,
              put: (_value: unknown, key: string) => {
                puts.push(key)
                setTimeout(() => {
                  transaction.oncomplete?.()
                })
              }
            })
          })
        }) as unknown as IDBDatabase['transaction']
      }
    })
    const record = sample()
    await store.save(record)
    expect(puts).deep.equals(['wrap', recordKey(record.userId)])
  })

  it('lets the ops behind a save whose open never answers run after one step', async function () {
    const factory = new IDBFactory()
    let opens = 0
    const stuck = {
      databases: async () => [{ name: KEY_DATABASE }],
      open: (name: string, version?: number) => {
        opens += 1
        // The save's open never answers; later ones do.
        if (opens === 1) return { readyState: 'pending' }
        return factory.open(name, version)
      }
    } as unknown as IDBFactory
    const store = webKeyStore({ indexedDB: stuck, stepTimeoutMs: STEP_MS })
    let saved = false
    store
      .save(sample())
      .then(() => {
        saved = true
      })
      .catch(() => undefined)
    const started = Date.now()
    expect(await store.load(userIdOfGumbo(12))).equals(undefined)
    expect(Date.now() - started).to.be.lessThan(STEP_MS * 20)
    expect(saved).equals(false)
  })

  /**
   * WebCrypto whose next `slow.count` encryptions each take `slow.ms` (past
   * the step timeout by default): a save held after its wrapping key and
   * before its write.
   */
  function slowSeal(slow: { count: number; ms?: number }): SubtleCrypto {
    const subtle = globalThis.crypto.subtle
    return {
      generateKey: subtle.generateKey.bind(subtle),
      decrypt: subtle.decrypt.bind(subtle),
      encrypt: async (...args: Parameters<SubtleCrypto['encrypt']>) => {
        if (slow.count > 0) {
          slow.count -= 1
          await new Promise(resolve =>
            setTimeout(resolve, slow.ms ?? PAST_STEP_MS)
          )
        }
        return await subtle.encrypt(...args)
      }
    } as unknown as SubtleCrypto
  }

  it('keeps a slow first save readable when a wipe of another account comes behind it', async function () {
    const factory = new IDBFactory()
    const store = webKeyStore({
      indexedDB: factory,
      stepTimeoutMs: STEP_MS,
      subtle: slowSeal({ count: 1 })
    })
    const record = sample()
    const saving = store.save(record)
    // Run under the save, this wipe found no record yet and dropped the
    // wrapping key the save had just made. Now it fails after one step.
    const wiping = store
      .wipe(userIdOfGumbo(99))
      .catch((error: unknown) => error)
    await saving
    expect(((await wiping) as Error).message).equals(
      'Chat keys could not be opened'
    )
    expect((await store.load(record.userId))?.userId).equals(record.userId)
  })

  it('wipes a record after the save asked for before the wipe', async function () {
    const factory = new IDBFactory()
    const store = webKeyStore({
      indexedDB: factory,
      stepTimeoutMs: STEP_MS,
      subtle: slowSeal({ count: 1, ms: STEP_MS / 2 })
    })
    const record = sample()
    const saving = store.save(record)
    const wiping = store.wipe(record.userId)
    await Promise.all([saving, wiping])
    expect((await raw(factory)).has(recordKey(record.userId))).equals(false)
  })

  it('fails a wipe behind a save that has not landed within a step, and keeps the save', async function () {
    const factory = new IDBFactory()
    const store = webKeyStore({
      indexedDB: factory,
      stepTimeoutMs: STEP_MS,
      subtle: slowSeal({ count: 1 })
    })
    const record = sample()
    const saving = store.save(record)
    const wiping = store.wipe(record.userId).catch((error: unknown) => error)
    await saving
    expect(((await wiping) as Error).message).equals(
      'Chat keys could not be opened'
    )
    expect((await store.load(record.userId))?.userId).equals(record.userId)
  })

  it('lets a load run while a wipe waits behind a save whose open never answers', async function () {
    const factory = new IDBFactory()
    let opens = 0
    const stuck = {
      databases: async () => [{ name: KEY_DATABASE }],
      open: (name: string, version?: number) => {
        opens += 1
        // The save's open never answers; later ones do.
        if (opens === 1) return { readyState: 'pending' }
        return factory.open(name, version)
      }
    } as unknown as IDBFactory
    const store = webKeyStore({ indexedDB: stuck, stepTimeoutMs: STEP_MS })
    store.save(sample()).catch(() => undefined)
    const wiping = store
      .wipe(userIdOfGumbo(99))
      .catch((error: unknown) => error)
    const started = Date.now()
    expect(await store.load(userIdOfGumbo(12))).equals(undefined)
    expect(Date.now() - started).to.be.lessThan(STEP_MS * 20)
    expect(((await wiping) as Error).message).equals(
      'Chat keys could not be opened'
    )
  })

  it('never runs a wipe asked before a pagehide that came while it waited behind a save', async function () {
    const factory = new IDBFactory()
    const store = webKeyStore({
      indexedDB: factory,
      stepTimeoutMs: STEP_MS,
      subtle: slowSeal({ count: 1 })
    })
    const record = sample()
    const saving = store.save(record)
    const wiping = store.wipe(record.userId).catch((error: unknown) => error)
    // The wipe is past its turn's start and still waiting for the save.
    await new Promise(resolve => setTimeout(resolve, (STEP_MS * 3) / 2))
    window.dispatchEvent(new window.Event('pagehide'))
    await saving
    expect(((await wiping) as Error).message).equals(
      'Chat keys could not be opened'
    )
    expect((await raw(factory)).has(recordKey(record.userId))).equals(true)
  })

  it('runs a load behind save, wipe, save as soon as the first save lands', async function () {
    const step = 300
    const factory = new IDBFactory()
    const store = webKeyStore({
      indexedDB: factory,
      stepTimeoutMs: step,
      subtle: slowSeal({ count: 1, ms: 20 })
    })
    const record = sample()
    const started = Date.now()
    const first = store.save(record)
    const wiping = store.wipe(userIdOfGumbo(99))
    const second = store.save({ ...record, deviceId: 'cdv_second' })
    const loading = store.load(record.userId)
    await loading
    // Before, the second save took the queue while it waited for the wipe,
    // and everything behind it sat out its whole step.
    expect(Date.now() - started).to.be.lessThan(step / 2)
    await Promise.all([first, wiping, second])
    expect((await store.load(record.userId))?.deviceId).equals('cdv_second')
  })

  it('lets two writes behind a slow but answering load both succeed', async function () {
    const step = 200
    const factory = new IDBFactory()
    const slow = {
      databases: async () => await factory.databases(),
      // Every open answers within its step, at 0.8 of it.
      open: (name: string, version?: number) =>
        late(factory.open(name, version), (step * 4) / 5)
    } as unknown as IDBFactory
    const record = sample()
    await webKeyStore({ indexedDB: factory }).save(record)
    const store = webKeyStore({ indexedDB: slow, stepTimeoutMs: step })
    const loading = store.load(record.userId)
    const wiping = store.wipe(userIdOfGumbo(98))
    if (store.discardLegacy == null) throw new Error('No discardLegacy')
    const discarding = store.discardLegacy(userIdOfGumbo(97))
    expect((await loading)?.userId).equals(record.userId)
    await wiping
    await discarding
  })

  it('lets a write behind a save that waits behind another write succeed', async function () {
    const step = 200
    const factory = new IDBFactory()
    const slow = {
      databases: async () => await factory.databases(),
      // Every open answers within its step, at 0.6 of it.
      open: (name: string, version?: number) =>
        late(factory.open(name, version), (step * 3) / 5)
    } as unknown as IDBFactory
    // `ts-chat` exists, so each write opens it.
    await webKeyStore({ indexedDB: factory }).save({
      ...sample(),
      userId: userIdOfGumbo(96)
    })
    const store = webKeyStore({ indexedDB: slow, stepTimeoutMs: step })
    const record = sample()
    const first = store.wipe(userIdOfGumbo(98))
    const saving = store.save(record)
    // Its step counts from when the save starts to run, not from when the
    // save started waiting for the first wipe.
    const second = store.wipe(userIdOfGumbo(97))
    await first
    await saving
    await second
    expect((await raw(factory)).has(recordKey(record.userId))).equals(true)
  })

  it('gives each save ahead of a write its own step', async function () {
    const step = 200
    const factory = new IDBFactory()
    const store = webKeyStore({
      indexedDB: factory,
      stepTimeoutMs: step,
      // Two healthy saves, each sealing at 0.6 of a step.
      subtle: slowSeal({ count: 2, ms: (step * 3) / 5 })
    })
    const record = sample()
    const first = store.save(record)
    const second = store.save({ ...record, deviceId: 'cdv_second' })
    const wiping = store.wipe(userIdOfGumbo(97))
    await first
    await second
    await wiping
    expect((await store.load(record.userId))?.deviceId).equals('cdv_second')
  })

  it('does not load a record wiped just before', async function () {
    const factory = new IDBFactory()
    const store = webKeyStore({ indexedDB: factory, stepTimeoutMs: STEP_MS })
    const record = sample()
    await store.save(record)
    const wiping = store.wipe(record.userId)
    const loading = store.load(record.userId)
    await wiping
    expect(await loading).equals(undefined)
  })

  it('lands two saves in the order they were asked for, the first past its step', async function () {
    const factory = new IDBFactory()
    const store = webKeyStore({
      indexedDB: factory,
      stepTimeoutMs: STEP_MS,
      subtle: slowSeal({ count: 1 })
    })
    const older = sample()
    const newer = { ...sample(), deviceId: 'cdv_newer' }
    await Promise.all([store.save(older), store.save(newer)])
    expect((await store.load(older.userId))?.deviceId).equals('cdv_newer')
  })

  it("closes a save's connection when the open hook throws", async function () {
    const factory = new IDBFactory()
    let closed = 0
    const store = webKeyStore({
      indexedDB: factory,
      onOpen(db) {
        const close = db.close.bind(db)
        db.close = () => {
          closed += 1
          close()
        }
        throw new Error('hook')
      }
    })
    const failed = await store.save(sample()).catch((error: unknown) => error)
    expect((failed as Error).message).equals('hook')
    expect(closed).equals(1)
  })

  it('finishes a save that is running when the page is hidden', async function () {
    const factory = new IDBFactory()
    let hidden = false
    const store = webKeyStore({
      indexedDB: factory,
      onOpen() {
        // The save has opened its connection and not yet written.
        if (hidden) return
        hidden = true
        window.dispatchEvent(new window.Event('pagehide'))
      }
    })
    const record = sample()
    await store.save(record)
    expect(hidden).equals(true)
    expect((await raw(factory)).has(recordKey(record.userId))).equals(true)
  })

  it('finishes a save that is queued when the page is hidden', async function () {
    const factory = new IDBFactory()
    const databases = factory.databases.bind(factory)
    factory.databases = async () => {
      await new Promise(resolve => setTimeout(resolve, 100))
      return await databases()
    }
    const store = webKeyStore({ indexedDB: factory })
    const record = sample()
    // The save queues behind the load, then waits for the load's 100 ms
    // listing, so it starts after the pagehide.
    const loading = store.load(record.userId).catch(() => undefined)
    const saving = store.save(record)
    window.dispatchEvent(new window.Event('pagehide'))
    await loading
    await saving
    expect((await raw(factory)).has(recordKey(record.userId))).equals(true)
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
        window.dispatchEvent(new window.Event('pagehide'))
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
