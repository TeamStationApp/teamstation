import { fromUtf8, utf8 } from '../../common/chatCrypto/bytes'
import { TimeoutError, withTimeout } from '../../common/withTimeout'
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
  /** Called with each connection as soon as it is open. Tests use it. */
  onOpen?: (db: IDBDatabase) => void
  /** How long one IndexedDB step may take. 5 s; tests shorten it. */
  stepTimeoutMs?: number
}

/** How long one IndexedDB step may take before the store gives up on it. */
const STEP_TIMEOUT_MS = 5000

/** A step that never settles fails, so the queue behind it moves on. */
async function stepBounded<T>(work: Promise<T>, ms: number): Promise<T> {
  return await withTimeout(work, ms, 'Chat keys could not be opened')
}

interface Sealed {
  iv: Uint8Array
  ciphertext: ArrayBuffer
}

async function settled<T>(request: IDBRequest<T>): Promise<T> {
  return await new Promise<T>((resolve, reject) => {
    request.onsuccess = () => {
      resolve(request.result)
    }
    request.onerror = () => {
      reject(request.error ?? new Error('IndexedDB request failed'))
    }
  })
}

async function stepDone<T>(request: IDBRequest<T>, ms: number): Promise<T> {
  return await stepBounded(settled(request), ms)
}

/** When `work` ends, either way. */
async function endOf(work: Promise<unknown>): Promise<void> {
  await work.catch(() => undefined)
}

/** How a transaction ends: committed, or with its error. */
async function outcomeOf(transaction: IDBTransaction): Promise<void> {
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

/**
 * A write that does not commit in time is aborted, so a write reported as
 * failed has not landed. One already committing cannot be aborted: it gets
 * one more step, and its own outcome is the answer.
 */
async function stepCommitted(
  transaction: IDBTransaction,
  ms: number
): Promise<void> {
  const outcome = outcomeOf(transaction)
  // An abort below settles it with nobody waiting.
  outcome.catch(() => undefined)
  try {
    await stepBounded(outcome, ms)
  } catch (error) {
    if (!(error instanceof TimeoutError)) throw error
    try {
      transaction.abort()
    } catch {
      await stepBounded(outcome, ms)
      return
    }
    throw error
  }
}

function isSealed(value: unknown): value is Sealed {
  if (value == null || typeof value !== 'object') return false
  const sealed = value as { iv?: unknown; ciphertext?: unknown }
  return sealed.iv != null && sealed.ciphertext != null
}

export function webKeyStore(options: WebKeyStoreOptions = {}): ChatKeyStore {
  const factory = (): IDBFactory => options.indexedDB ?? globalThis.indexedDB
  const subtle = (): SubtleCrypto => options.subtle ?? globalThis.crypto.subtle
  const stepMs = options.stepTimeoutMs ?? STEP_TIMEOUT_MS
  const bounded = async <T>(work: Promise<T>): Promise<T> =>
    await stepBounded(work, stepMs)
  const done = async <T>(request: IDBRequest<T>): Promise<T> =>
    await stepDone(request, stepMs)
  const committed = async (transaction: IDBTransaction): Promise<void> => {
    await stepCommitted(transaction, stepMs)
  }
  let chain: Promise<void> = Promise.resolve()
  /** Every write (a save or not) asked for so far, ended either way: see `runSave`. */
  let writing: Promise<void> = Promise.resolve()
  /**
   * Writes of every kind not yet ended. With none (and no save pending), an
   * op joins the queue at once, so it keeps its place against the ops asked
   * after it.
   */
  let writesOut = 0
  /**
   * The saves not yet ended, in the order they were asked for: `runs`
   * settles once the save starts to run (or ends without running), `ended`
   * once it ends either way. See `runWrite`.
   */
  const pending: Array<{ runs: Promise<void>; ended: Promise<void> }> = []
  let generation = 0
  let live: IDBDatabase | undefined
  let listing: Promise<boolean> | undefined
  /** This page opened `ts-chat`, so it exists whatever an older listing says. */
  let made = false

  function hide(): void {
    generation += 1
    const db = live
    live = undefined
    db?.close()
  }
  globalThis.window?.addEventListener?.('pagehide', hide)

  /**
   * Runs `op` after every op before it. A `ticket` fails it if a pagehide
   * came between; a save passes none. With `hold`, the ops behind it may
   * start once it has held the queue for one step (see `runSave`).
   */
  async function queue<T>(
    op: () => Promise<T>,
    ticket?: number,
    hold = false
  ): Promise<T> {
    const turn = chain
    const result = turn.then(async () => {
      if (ticket != null && ticket !== generation) {
        throw new Error('Chat keys could not be opened')
      }
      // No step starts while databases() is still answering. A listing
      // that failed is the failure of the op that asked for it, not this one.
      if (listing != null) await listing.catch(() => undefined)
      return await op()
    })
    chain = turn.then(async () => {
      await (hold ? bounded(result) : result).catch(() => undefined)
    })
    return await result
  }

  async function run<T>(ticket: number, op: () => Promise<T>): Promise<T> {
    return await queue(op, ticket)
  }

  /**
   * A save keeps device keys the server already holds the other half of (a
   * registration, a link or a rotation has just been accepted). Giving up
   * would leave the server a device whose keys exist nowhere, so a save is
   * never failed by the store: its open, reads and commit have no step
   * deadline (`openOwn`, `settled`, `outcomeOf`), and a pagehide neither
   * fails it nor closes its connection.
   *
   * Saves land in the order they were asked for, each after every write
   * asked before it. A save holds the queue for one step at most: after
   * that the reads behind it (`load`, `exists`) run and may not see it yet,
   * as may a read asked while the save still waits for an earlier write. A
   * write behind it (`wipe`, `discardLegacy`) never runs before it lands:
   * see `runWrite`.
   */
  async function runSave(op: () => Promise<void>): Promise<void> {
    const before = writing
    let started: () => void = () => {}
    const runs = new Promise<void>(resolve => {
      started = resolve
    })
    const turn = async (): Promise<void> => {
      started()
      await op()
    }
    // Behind an earlier write, the save waits outside the queue: it takes
    // the queue, and starts its one step, only when it can run.
    const result =
      writesOut === 0
        ? queue(turn, undefined, true)
        : (async () => {
            await before
            await queue(turn, undefined, true)
          })()
    writesOut += 1
    const entry = {
      runs,
      ended: endOf(result).then(() => {
        started()
        pending.splice(pending.indexOf(entry), 1)
        writesOut -= 1
      })
    }
    pending.push(entry)
    writing = Promise.all([writing, entry.ended]).then(() => undefined)
    await result
  }

  /**
   * A write that is not a save (`wipe`, `discardLegacy`). It waits for every
   * save asked for before it to land, outside the queue so that reads go on
   * meanwhile, giving each of them one step from when that save starts to
   * run: a write behind a save that has not landed one step after it
   * started fails, as a step that does not answer does, rather than run
   * under it. Time a save spends waiting for an earlier write is not
   * counted, as that write has its own deadlines. Earlier writes that are
   * not saves need no wait: the queue keeps them in order. It then queues
   * like any op, so a pagehide since it was asked fails it too. A save
   * asked after it lands after it.
   */
  async function runWrite(op: () => Promise<void>): Promise<void> {
    const ticket = generation
    const ahead = [...pending]
    const result =
      ahead.length === 0
        ? run(ticket, op)
        : (async () => {
            // Saves run in the order asked, so each one's step follows the
            // one before it.
            for (const save of ahead) {
              await save.runs
              await bounded(save.ended)
            }
            await run(ticket, op)
          })()
    writesOut += 1
    const ended = endOf(result).then(() => {
      writesOut -= 1
    })
    writing = Promise.all([writing, ended]).then(() => undefined)
    await result
  }

  function openRequest(): IDBOpenDBRequest {
    const request = factory().open(KEY_DATABASE, 1)
    request.onupgradeneeded = () => {
      request.result.createObjectStore(STORE)
    }
    return request
  }

  /** A save's own connection: see `runSave`. The save closes it. */
  async function openOwn(): Promise<IDBDatabase> {
    const db = await settled(openRequest())
    made = true
    try {
      options.onOpen?.(db)
    } catch (error) {
      db.close()
      throw error
    }
    return db
  }

  async function open(): Promise<IDBDatabase> {
    const openedAt = generation
    const request = openRequest()
    let db: IDBDatabase
    try {
      db = await done(request)
    } catch (error) {
      // An open that gives up keeps going. Close what it opens late.
      if (request.readyState === 'done' && request.error == null)
        request.result?.close()
      else
        request.onsuccess = () => {
          request.result.close()
        }
      throw error
    }
    made = true
    live = db
    options.onOpen?.(db)
    if (openedAt !== generation) {
      finish(db)
      throw new Error('Chat keys could not be opened')
    }
    return db
  }

  function finish(db: IDBDatabase): void {
    if (live === db) live = undefined
    try {
      db.close()
    } catch {
      // pagehide already closed it.
    }
  }

  /** `wait` is `done` (the step deadline), or `settled` for a save. */
  async function read<T>(
    db: IDBDatabase,
    key: string,
    wait: (request: IDBRequest) => Promise<unknown> = done
  ): Promise<T | undefined> {
    const transaction = db.transaction(STORE, 'readonly')
    return (await wait(transaction.objectStore(STORE).get(key))) as
      T | undefined
  }

  /** Whether `ts-chat` exists, without opening it (which would make it). */
  async function present(asked: Promise<boolean>): Promise<boolean> {
    const found = await asked.catch((error: unknown) => {
      if (made) return true
      throw error
    })
    return made || found
  }

  async function listed(): Promise<boolean> {
    listing ??= bounded(
      Promise.resolve().then(async () => await factory().databases())
    )
      .then(names => names.some(found => found.name === KEY_DATABASE))
      .finally(() => {
        listing = undefined
      })
    return await listing
  }

  /**
   * The wrapping key, made the first time. Two tabs making one at once
   * agree: the second write finds the first and keeps it. Only a save asks
   * for it, so no step has a deadline (see `runSave`).
   */
  async function wrappingKey(db: IDBDatabase): Promise<CryptoKey> {
    const kept = await read<CryptoKey>(db, WRAP, settled)
    if (kept != null) return kept
    const made = await subtle().generateKey(
      { name: 'AES-GCM', length: 256 },
      false,
      ['encrypt', 'decrypt']
    )
    const transaction = db.transaction(STORE, 'readwrite')
    const store = transaction.objectStore(STORE)
    const raced = (await settled(store.get(WRAP))) as CryptoKey | undefined
    if (raced == null) store.put(made, WRAP)
    await outcomeOf(transaction)
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
    return keys.flatMap(key => (typeof key === 'string' ? [key] : []))
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
    const store = transaction.objectStore(STORE)
    // A save may have landed since the read above: its record wins.
    const own = await done(store.get(recordKey(userId)))
    if (own == null) store.put(legacy, recordKey(userId))
    await committed(transaction)
    await dropLegacyIfOwner(db, userId)
    return own == null ? record : await openSealed(db, own)
  }

  return {
    async load(userId: string): Promise<ChatKeyRecord | undefined> {
      const ticket = generation
      const asked = listed()
      // A listing that fails while this op is still queued is its failure,
      // reported when its turn comes, not an unhandled rejection before.
      asked.catch(() => undefined)
      return await run(ticket, async () => {
        // Opening would create `ts-chat`. A browser with no record stays without one.
        if (!(await present(asked))) return undefined
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
          finish(db)
        }
      })
    },

    async save(record: ChatKeyRecord): Promise<void> {
      await runSave(async () => {
        const db = await openOwn()
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
          await outcomeOf(transaction)
        } finally {
          finish(db)
        }
      })
    },

    async wipe(userId: string): Promise<void> {
      const asked = listed()
      asked.catch(() => undefined)
      await runWrite(async () => {
        if (!(await present(asked))) return
        const db = await open()
        try {
          const transaction = db.transaction(STORE, 'readwrite')
          transaction.objectStore(STORE).delete(recordKey(userId))
          await committed(transaction)
          await dropWrapIfIdle(db)
        } finally {
          finish(db)
        }
      })
    },

    async exists(userId: string): Promise<boolean> {
      const ticket = generation
      const asked = listed()
      asked.catch(() => undefined)
      return await run(ticket, async () => {
        // Asked of the list first: opening `ts-chat` would make it.
        if (!(await present(asked))) return false
        const db = await open()
        try {
          const own = await read<unknown>(db, recordKey(userId))
          if (own != null) {
            await dropLegacyIfOwner(db, userId)
            return true
          }
          return (await migrate(db, userId)) != null
        } finally {
          finish(db)
        }
      })
    },

    async discardLegacy(userId: string): Promise<void> {
      const asked = listed()
      asked.catch(() => undefined)
      await runWrite(async () => {
        if (!(await present(asked))) return
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
          finish(db)
        }
      })
    }
  }
}

/** This browser's store. */
export const keyStore: ChatKeyStore = webKeyStore()
