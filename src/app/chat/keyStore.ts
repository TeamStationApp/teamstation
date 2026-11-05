import { fromUtf8, utf8 } from '../../common/chatCrypto/bytes'
import {
  type ChatKeyRecord,
  type ChatKeyStore,
  recordToJson,
  storedRecordFromJson,
  UnreadableKeyRecordError
} from './keyRecord'

/**
 * The browser's chat key store.
 *
 * The records live in IndexedDB database `ts-chat`, each sealed with AES-GCM
 * under one random 256-bit wrapping key that is kept beside them as a
 * non-extractable `CryptoKey`. Script on the page can use that key, but can
 * never read its bytes, so a copy of the database files alone does not open
 * a record. Each account's ciphertext is `record:<userId>`. A record saved
 * before accounts had their own slots sits at `record` and is copied into
 * the account's slot the first time that account is read. The phone keeps
 * the same records in the Keychain or Keystore (`keyStore.native.ts`).
 */
export const KEY_DATABASE = 'ts-chat'
const STORE = 'keys'
const WRAP = 'wrap'
/** The slot written before each account had its own. */
export const LEGACY_RECORD_KEY = 'record'
/** Binds the sealed record to what it is, so no other blob passes for it. */
const AAD = utf8('ts-chat/v1/key-record')

/** The object-store key of one account's sealed record. */
export function recordKey(userId: string): string {
  return `record:${userId}`
}

export interface WebKeyStoreOptions {
  /** Defaults to the browser's own, read when first used. */
  indexedDB?: IDBFactory
  subtle?: SubtleCrypto
}

interface Sealed {
  iv: Uint8Array
  ciphertext: ArrayBuffer
}

async function done<T>(request: IDBRequest<T>): Promise<T> {
  return await new Promise<T>((resolve, reject) => {
    request.onsuccess = () => {
      resolve(request.result)
    }
    request.onerror = () => {
      reject(request.error ?? new Error('IndexedDB request failed'))
    }
  })
}

async function committed(transaction: IDBTransaction): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    transaction.oncomplete = () => {
      resolve()
    }
    transaction.onerror = () => {
      reject(transaction.error ?? new Error('IndexedDB transaction failed'))
    }
    transaction.onabort = () => {
      reject(transaction.error ?? new Error('IndexedDB transaction aborted'))
    }
  })
}

function isSealed(value: unknown): value is Sealed {
  if (value == null || typeof value !== 'object') return false
  const sealed = value as { iv?: unknown; ciphertext?: unknown }
  return sealed.iv != null && sealed.ciphertext != null
}

export function webKeyStore(options: WebKeyStoreOptions = {}): ChatKeyStore {
  const factory = (): IDBFactory => options.indexedDB ?? globalThis.indexedDB
  const subtle = (): SubtleCrypto => options.subtle ?? globalThis.crypto.subtle

  async function open(): Promise<IDBDatabase> {
    const request = factory().open(KEY_DATABASE, 1)
    request.onupgradeneeded = () => {
      request.result.createObjectStore(STORE)
    }
    return await done(request)
  }

  async function read<T>(db: IDBDatabase, key: string): Promise<T | undefined> {
    const transaction = db.transaction(STORE, 'readonly')
    return (await done(transaction.objectStore(STORE).get(key))) as
      T | undefined
  }

  async function listed(): Promise<boolean> {
    const names = await factory().databases()
    return names.some(found => found.name === KEY_DATABASE)
  }

  /**
   * The wrapping key, made the first time. Two tabs making one at once
   * agree: the second write finds the first and keeps it.
   */
  async function wrappingKey(db: IDBDatabase): Promise<CryptoKey> {
    const kept = await read<CryptoKey>(db, WRAP)
    if (kept != null) return kept
    const made = await subtle().generateKey(
      { name: 'AES-GCM', length: 256 },
      false,
      ['encrypt', 'decrypt']
    )
    const transaction = db.transaction(STORE, 'readwrite')
    const store = transaction.objectStore(STORE)
    const raced = (await done(store.get(WRAP))) as CryptoKey | undefined
    if (raced == null) store.put(made, WRAP)
    await committed(transaction)
    return raced ?? made
  }

  async function openSealed(
    db: IDBDatabase,
    value: unknown
  ): Promise<ChatKeyRecord> {
    if (!isSealed(value)) throw new UnreadableKeyRecordError('invalid')
    const key = await read<CryptoKey>(db, WRAP)
    if (key == null) throw new UnreadableKeyRecordError('wrappingKeyMissing')
    let plain: ArrayBuffer
    try {
      plain = await subtle().decrypt(
        { name: 'AES-GCM', iv: value.iv, additionalData: AAD },
        key,
        value.ciphertext
      )
    } catch (error) {
      // A record or key that does not open. Anything else (no crypto
      // here at all) says nothing about the record, so it is not one.
      if (
        error instanceof Error &&
        ['OperationError', 'InvalidAccessError'].includes(error.name)
      )
        throw new UnreadableKeyRecordError('undecryptable')
      throw error
    }
    return storedRecordFromJson(fromUtf8(new Uint8Array(plain)))
  }

  async function keysOf(db: IDBDatabase): Promise<string[]> {
    const transaction = db.transaction(STORE, 'readonly')
    const keys = await done(transaction.objectStore(STORE).getAllKeys())
    return keys.map(key => String(key))
  }

  /** Drops the wrapping key once nothing it seals is left. */
  async function dropWrapIfIdle(db: IDBDatabase): Promise<void> {
    const keys = await keysOf(db)
    const remains = keys.some(
      key => key === LEGACY_RECORD_KEY || key.startsWith('record:')
    )
    if (remains) return
    const transaction = db.transaction(STORE, 'readwrite')
    transaction.objectStore(STORE).delete(WRAP)
    await committed(transaction)
  }

  /**
   * The legacy slot still holds `userId`'s record, left by a copy that
   * already committed. Delete it. An unreadable legacy slot, or another
   * account's, stays.
   */
  async function dropLegacyIfOwner(
    db: IDBDatabase,
    userId: string
  ): Promise<void> {
    const legacy = await read<unknown>(db, LEGACY_RECORD_KEY)
    if (legacy == null) return
    let record: ChatKeyRecord
    try {
      record = await openSealed(db, legacy)
    } catch (error) {
      if (error instanceof UnreadableKeyRecordError) return
      throw error
    }
    if (record.userId !== userId) return
    const transaction = db.transaction(STORE, 'readwrite')
    transaction.objectStore(STORE).delete(LEGACY_RECORD_KEY)
    await committed(transaction)
  }

  /**
   * Copies a legacy record for `userId` into that account's slot, then
   * deletes the legacy slot. A failed copy leaves the legacy slot. A
   * failed delete leaves the copy, and the next read finishes it.
   */
  async function migrate(
    db: IDBDatabase,
    userId: string
  ): Promise<ChatKeyRecord | undefined> {
    const legacy = await read<unknown>(db, LEGACY_RECORD_KEY)
    if (legacy == null) return undefined
    const record = await openSealed(db, legacy)
    if (record.userId !== userId) return undefined
    const transaction = db.transaction(STORE, 'readwrite')
    transaction.objectStore(STORE).put(legacy, recordKey(userId))
    await committed(transaction)
    await dropLegacyIfOwner(db, userId)
    return record
  }

  return {
    async load(userId: string): Promise<ChatKeyRecord | undefined> {
      const db = await open()
      try {
        const own = await read<unknown>(db, recordKey(userId))
        if (own != null) {
          const record = await openSealed(db, own)
          await dropLegacyIfOwner(db, userId)
          return record
        }
        return await migrate(db, userId)
      } finally {
        db.close()
      }
    },

    async save(record: ChatKeyRecord): Promise<void> {
      const db = await open()
      try {
        const key = await wrappingKey(db)
        const iv = globalThis.crypto.getRandomValues(new Uint8Array(12))
        const ciphertext = await subtle().encrypt(
          { name: 'AES-GCM', iv, additionalData: AAD },
          key,
          utf8(recordToJson(record))
        )
        const transaction = db.transaction(STORE, 'readwrite')
        transaction
          .objectStore(STORE)
          .put({ iv, ciphertext }, recordKey(record.userId))
        await committed(transaction)
      } finally {
        db.close()
      }
    },

    async wipe(userId: string): Promise<void> {
      if (!(await listed())) return
      const db = await open()
      try {
        const transaction = db.transaction(STORE, 'readwrite')
        transaction.objectStore(STORE).delete(recordKey(userId))
        await committed(transaction)
        await dropWrapIfIdle(db)
      } finally {
        db.close()
      }
    },

    async exists(userId: string): Promise<boolean> {
      // Asked of the list first: opening `ts-chat` would make it.
      if (!(await listed())) return false
      const db = await open()
      try {
        const own = await read<unknown>(db, recordKey(userId))
        if (own != null) {
          await dropLegacyIfOwner(db, userId)
          return true
        }
        return (await migrate(db, userId)) != null
      } finally {
        db.close()
      }
    },

    async discardLegacy(userId: string): Promise<void> {
      if (!(await listed())) return
      const db = await open()
      try {
        const legacy = await read<unknown>(db, LEGACY_RECORD_KEY)
        if (legacy == null) {
          const transaction = db.transaction(STORE, 'readwrite')
          transaction.objectStore(STORE).delete(LEGACY_RECORD_KEY)
          await committed(transaction)
          await dropWrapIfIdle(db)
          return
        }
        let remove = false
        try {
          const record = await openSealed(db, legacy)
          remove = record.userId === userId
        } catch (error) {
          if (!(error instanceof UnreadableKeyRecordError)) throw error
          remove = true
        }
        if (!remove) return
        const transaction = db.transaction(STORE, 'readwrite')
        transaction.objectStore(STORE).delete(LEGACY_RECORD_KEY)
        await committed(transaction)
        await dropWrapIfIdle(db)
      } finally {
        db.close()
      }
    }
  }
}

/** This browser's store. */
export const keyStore: ChatKeyStore = webKeyStore()
