/**
 * The phone's document cache: the SQL, and where each transaction begins and
 * ends, over whatever runs the statements. On the phone that is op-sqlite
 * (`cache.native.ts`); in the tests it is `node:sqlite`. One file belongs to
 * one signed-in person, and sign-out deletes it.
 */

/** A value a statement binds or a row holds. */
export type SqlValue = string | number | null

export type SqlRow = Record<string, unknown>

/** Statements inside one transaction. */
export interface SqlTransaction {
  execute: (sql: string, params?: SqlValue[]) => Promise<SqlRow[]>
}

/** What runs the statements: one database file. */
export interface SqlExecutor {
  /**
   * Runs `work` as one transaction, committed when it resolves and rolled
   * back when it throws.
   */
  transaction: <T>(work: (tx: SqlTransaction) => Promise<T>) => Promise<T>
  close: () => void | Promise<void>
  /** Removes the file. Called after `close`. */
  delete: () => void | Promise<void>
}

/** One stored answer. */
export interface StoredDocument {
  /** The answer's JSON, as the server sent it. */
  body: string
  /** `x-teamstation-revision` of that answer; `0` when it carried none. */
  revision: string
  /** The answer's `lineupsDigest` or `digest`, when it had one. */
  serverDigest: string | null
  /** A queued write holds this document: a server answer does not replace it. */
  pending: boolean
}

export type ServerDocument = Omit<StoredDocument, 'pending'>

/** The cache as the client uses it. */
export interface DocumentStore {
  read: (key: string) => Promise<StoredDocument | undefined>
  /**
   * Stores a server answer for `key`, unless a queued write holds it, and
   * answers what the key holds afterwards.
   */
  store: (key: string, document: ServerDocument) => Promise<StoredDocument>
  close: () => Promise<void>
  /** Closes the file and deletes it: sign-out. */
  destroy: () => Promise<void>
}

/** The file one person's cache lives in. */
export function cacheFileName(userId: string): string {
  return `teamstation-${userId.replace(/[^A-Za-z0-9_-]/g, '_')}.sqlite`
}

const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS documents (
    key text PRIMARY KEY,
    body text NOT NULL,
    revision text NOT NULL,
    server_digest text,
    pending integer NOT NULL DEFAULT 0
  )`,
  `CREATE TABLE IF NOT EXISTS outbox (
    id text PRIMARY KEY,
    idempotency_key text NOT NULL UNIQUE,
    seq integer NOT NULL,
    chain text NOT NULL,
    method text NOT NULL,
    path text NOT NULL,
    body text NOT NULL,
    depends_on text NOT NULL,
    state text NOT NULL,
    attempts integer NOT NULL,
    lease_until integer,
    game_id text
  )`,
  `CREATE TABLE IF NOT EXISTS local_players (
    local_id integer PRIMARY KEY,
    server_id integer,
    team_id text NOT NULL,
    body text NOT NULL
  )`
]

function documentOf(row: SqlRow): StoredDocument {
  return {
    body: String(row.body),
    revision: String(row.revision),
    serverDigest:
      typeof row.server_digest === 'string' ? row.server_digest : null,
    pending: Number(row.pending) !== 0
  }
}

async function readIn(
  tx: SqlTransaction,
  key: string
): Promise<StoredDocument | undefined> {
  const rows = await tx.execute(
    'SELECT body, revision, server_digest, pending FROM documents WHERE key = ?',
    [key]
  )
  const row = rows[0]
  return row == null ? undefined : documentOf(row)
}

export interface OpenCacheStoreOptions {
  /** Milliseconds since the epoch, for the outbox's leases. */
  now?: () => number
}

/**
 * Opens the cache on `executor`: makes the tables if they are not there, and
 * returns to `pending` every queued write whose send was in flight when the
 * process last stopped and whose lease has run out.
 */
export async function openCacheStore(
  executor: SqlExecutor,
  options: OpenCacheStoreOptions = {}
): Promise<DocumentStore> {
  const now = options.now ?? Date.now
  // One transaction at a time, whatever the executor does about overlap.
  let tail: Promise<unknown> = Promise.resolve()
  const serially = async <T>(
    work: (tx: SqlTransaction) => Promise<T>
  ): Promise<T> => {
    // `tail` never rejects: a failed transaction does not stop the next.
    const run = tail.then(async () => await executor.transaction(work))
    tail = run.catch(() => undefined)
    return await run
  }

  await serially(async tx => {
    for (const statement of SCHEMA) await tx.execute(statement)
    await tx.execute(
      `UPDATE outbox SET state = 'pending', lease_until = NULL
       WHERE state = 'inflight' AND (lease_until IS NULL OR lease_until < ?)`,
      [now()]
    )
  })

  let closed: Promise<void> | undefined
  const close = async (): Promise<void> => {
    closed ??= tail.then(async () => {
      await executor.close()
    })
    await closed
  }

  return {
    read: async key => await serially(async tx => await readIn(tx, key)),
    store: async (key, document) =>
      await serially(async tx => {
        const held = await readIn(tx, key)
        if (held?.pending === true) return held
        await tx.execute(
          `INSERT INTO documents (key, body, revision, server_digest, pending)
           VALUES (?, ?, ?, ?, 0)
           ON CONFLICT (key) DO UPDATE SET
             body = excluded.body,
             revision = excluded.revision,
             server_digest = excluded.server_digest`,
          [key, document.body, document.revision, document.serverDigest]
        )
        return { ...document, pending: false }
      }),
    close,
    destroy: async () => {
      await close()
      await executor.delete()
    }
  }
}
