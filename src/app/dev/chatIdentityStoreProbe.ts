import { utf8 } from '../../common/chatCrypto/bytes'
import { b64 } from '../chat/keyRecord'
import { KEY_DATABASE, webKeyStore } from '../chat/keyStore'
import {
  type IdentityProbeResult,
  type IdentityProbeStorage,
  runIdentityStoreProbe
} from './chatIdentityStoreProbeRun'

export const PROBE_DATABASE = 'ts-chat-compatibility-fixture'
let active = false

async function done<T>(request: IDBRequest<T>): Promise<T> {
  return await new Promise((resolve, reject) => {
    request.onsuccess = () => {
      resolve(request.result)
    }
    request.onerror = () => {
      reject(new Error('Compatibility storage unavailable'))
    }
  })
}

async function committed(transaction: IDBTransaction): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    transaction.oncomplete = () => {
      resolve()
    }
    transaction.onabort = transaction.onerror = () => {
      reject(new Error('Compatibility write failed'))
    }
  })
}

/** Allocate a separate browser database; an occupied namespace is never changed. */
export async function openIdentityProbeStorage(
  options: {
    indexedDB?: IDBFactory
    subtle?: SubtleCrypto
  } = {}
): Promise<IdentityProbeStorage> {
  if (active) throw new Error('Compatibility diagnostic already running')
  active = true
  const factory = options.indexedDB ?? globalThis.indexedDB
  const subtle = options.subtle ?? globalThis.crypto.subtle
  let owned = false
  let db: IDBDatabase | undefined
  const cleanup = async (): Promise<void> => {
    try {
      db?.close()
      if (owned) {
        const deletion = factory.deleteDatabase(PROBE_DATABASE)
        await new Promise<void>((resolve, reject) => {
          deletion.onsuccess = () => {
            resolve()
          }
          deletion.onerror = deletion.onblocked = () => {
            reject(new Error('Compatibility cleanup failed'))
          }
        })
        if (
          (await factory.databases()).some(row => row.name === PROBE_DATABASE)
        )
          throw new Error('Compatibility cleanup failed')
      }
    } finally {
      active = false
    }
  }
  try {
    const request = factory.open(PROBE_DATABASE, 1)
    request.onupgradeneeded = event => {
      // IndexedDB's version transaction exclusively creates this namespace.
      owned = event.oldVersion === 0
      if (owned) request.result.createObjectStore('keys')
    }
    db = await done(request)
    if (!owned) throw new Error('Compatibility diagnostic storage is occupied')
    const database = db
    let refuse = false
    const mapped = {
      open: (name: string, version?: number) => {
        if (name !== KEY_DATABASE)
          throw new Error('Unexpected diagnostic database')
        return factory.open(PROBE_DATABASE, version)
      },
      databases: async () =>
        (await factory.databases())
          .filter(row => row.name === PROBE_DATABASE)
          .map(row => ({ ...row, name: KEY_DATABASE }))
    }
    const guardedSubtle = new Proxy(subtle, {
      get(target, key) {
        if (key === 'encrypt')
          return async (...args: Parameters<SubtleCrypto['encrypt']>) => {
            if (refuse) {
              refuse = false
              throw new Error('Injected adapter write refusal')
            }
            return await target.encrypt(...args)
          }
        const value = Reflect.get(target, key)
        return typeof value === 'function' ? value.bind(target) : value
      }
    })
    const wrap = await subtle.generateKey(
      { name: 'AES-GCM', length: 256 },
      false,
      ['encrypt', 'decrypt']
    )
    return {
      store: webKeyStore({
        indexedDB: mapped as IDBFactory,
        subtle: guardedSubtle
      }),
      install: async text => {
        const iv = globalThis.crypto.getRandomValues(new Uint8Array(12))
        const ciphertext = await subtle.encrypt(
          {
            name: 'AES-GCM',
            iv,
            additionalData: utf8('ts-chat/v1/key-record')
          },
          wrap,
          utf8(text)
        )
        const transaction = database.transaction('keys', 'readwrite')
        const complete = committed(transaction)
        transaction.objectStore('keys').put(wrap, 'wrap')
        transaction.objectStore('keys').put({ iv, ciphertext }, 'record')
        await complete
      },
      fingerprint: async () => {
        const transaction = database.transaction('keys', 'readonly')
        const complete = committed(transaction)
        const store = transaction.objectStore('keys')
        const [key, record] = await Promise.all([
          done(store.get('wrap')),
          done(store.get('record'))
        ])
        await complete
        // Check the actual non-extractable wrapping key as well as the sealed bytes.
        const keyProof = await subtle.encrypt(
          { name: 'AES-GCM', iv: new Uint8Array(12) },
          key,
          utf8('synthetic wrapping key continuity')
        )
        return JSON.stringify([
          b64(record.iv),
          b64(new Uint8Array(record.ciphertext)),
          b64(new Uint8Array(keyProof))
        ])
      },
      refuseNextSave: () => {
        refuse = true
      },
      cleanup
    }
  } catch (error) {
    await cleanup()
    throw error
  }
}

export async function probeIdentityStorage(
  signal: AbortSignal
): Promise<IdentityProbeResult> {
  return await runIdentityStoreProbe(
    async () => await openIdentityProbeStorage(),
    signal
  )
}
