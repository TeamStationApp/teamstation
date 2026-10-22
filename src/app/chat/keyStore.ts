import { fromUtf8, utf8 } from '../../common/chatCrypto/bytes'
import {
  type ChatKeyRecord,
  type ChatKeyStore,
  recordFromJson,
  recordToJson
} from './keyRecord'

/**
 * The browser's chat key store.
 *
 * The record lives in IndexedDB database `ts-chat`, sealed with AES-GCM
 * under a random 256-bit wrapping key that is kept beside it as a
 * non-extractable `CryptoKey`. Script on the page can use that key, but can
 * never read its bytes, so a copy of the database files alone does not open
 * the record. The phone keeps the same record in the Keychain or Keystore
 * (`keyStore.native.ts`).
 */
export const KEY_DATABASE = 'ts-chat'
const STORE = 'keys'
const WRAP = 'wrap'
const RECORD = 'record'
/** Binds the sealed record to what it is, so no other blob passes for it. */
const AAD = utf8('ts-chat/v1/key-record')

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

  return {
    async load(): Promise<ChatKeyRecord | undefined> {
      const db = await open()
      try {
        const sealed = await read<Sealed>(db, RECORD)
        const key = await read<CryptoKey>(db, WRAP)
        if (sealed == null) return undefined
        if (key == null)
          throw new Error('The saved chat wrapping key is missing')
        const plain = await subtle().decrypt(
          { name: 'AES-GCM', iv: sealed.iv, additionalData: AAD },
          key,
          sealed.ciphertext
        )
        return recordFromJson(fromUtf8(new Uint8Array(plain)))
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
        transaction.objectStore(STORE).put({ iv, ciphertext }, RECORD)
        await committed(transaction)
      } finally {
        db.close()
      }
    },

    async wipe(): Promise<void> {
      const db = await open()
      try {
        const transaction = db.transaction(STORE, 'readwrite')
        const store = transaction.objectStore(STORE)
        store.delete(RECORD)
        store.delete(WRAP)
        await committed(transaction)
      } finally {
        db.close()
      }
    },

    async exists(): Promise<boolean> {
      // Asked of the list first: opening `ts-chat` would make it.
      const listed = await factory().databases()
      if (!listed.some(found => found.name === KEY_DATABASE)) return false
      const db = await open()
      try {
        return (await read(db, RECORD)) != null
      } finally {
        db.close()
      }
    }
  }
}

/** This browser's store. */
export const keyStore: ChatKeyStore = webKeyStore()
