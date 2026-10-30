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

/** Where a queued write is: waiting, being sent, held, or refused. */
export type OutboxState = 'pending' | 'inflight' | 'parked' | 'dead'

/** One write the phone has queued for the server. */
export interface OutboxRow {
  id: string
  /** Sent as `Idempotency-Key`, the same each time the row is sent. */
  idempotencyKey: string
  /** Order of queueing, across every chain. */
  seq: number
  /** `game:<gameId>` or `team:<teamId>`: rows of one chain go in order. */
  chain: string
  method: string
  path: string
  /** The request's JSON, as queued. */
  body: string
  /** The ids of the rows this one waits for: a JSON array. */
  dependsOn: string[]
  state: OutboxState
  attempts: number
  /** Until when a send in flight holds the row, in epoch milliseconds. */
  leaseUntil: number | null
  gameId: string | null
  /** The server's refusal of a dead or parked row, for its screen. */
  message: string | null
  /**
   * The names of the players the row's body names, by gumbo id, as JSON:
   * kept on the phone beside the body and never sent, so the documents the
   * row writes read named (`appliedEvents`). Null for a row with none.
   */
  names: string | null
}

export type NewOutboxRow = Omit<
  OutboxRow,
  'seq' | 'state' | 'attempts' | 'leaseUntil' | 'message' | 'names'
> & { names?: string | null }

/** A player made on the phone with no signal, until the server has made him. */
export interface LocalPlayer {
  /** The gumbo id the phone gave him, until the server's replaces it. */
  localId: number
  /** The server's gumbo id, once his create has landed. */
  serverId: number | null
  teamId: string
  /** His roster entry: the phone's, and the server's once it landed. */
  body: string
}

/**
 * One transaction on the cache: a document and the queued write that made
 * it commit together, or neither does.
 */
export interface CacheTransaction {
  read: (key: string) => Promise<StoredDocument | undefined>
  /** Writes `key` whatever it held, pending or not. */
  write: (key: string, document: StoredDocument) => Promise<void>
  /** Drops `key`, unless a queued write holds it. */
  forget: (key: string) => Promise<void>
  /** Every queued write, oldest first. */
  outbox: () => Promise<OutboxRow[]>
  /** Queues a write after every other, as `pending`. */
  enqueue: (row: NewOutboxRow) => Promise<OutboxRow>
  update: (
    id: string,
    fields: Partial<
      Pick<OutboxRow, 'body' | 'state' | 'attempts' | 'leaseUntil' | 'message'>
    >
  ) => Promise<void>
  remove: (id: string) => Promise<void>
  /** Removes the row queued with `idempotencyKey`, if there is one. */
  removeKey: (idempotencyKey: string) => Promise<void>
  localPlayers: () => Promise<LocalPlayer[]>
  addLocalPlayer: (player: LocalPlayer) => Promise<void>
  /** Forgets a player the phone made whose create was given up. */
  forgetLocalPlayer: (localId: number) => Promise<void>
  /** Records the server's id and entry for a player the phone made. */
  landPlayer: (localId: number, serverId: number, body: string) => Promise<void>
}

/** The cache as the client uses it. */
export interface DocumentStore {
  read: (key: string) => Promise<StoredDocument | undefined>
  /**
   * Stores a server answer for `key`, unless a queued write holds it, and
   * answers what the key holds afterwards.
   */
  store: (key: string, document: ServerDocument) => Promise<StoredDocument>
  /** Runs `work` as one transaction, after any other. */
  atomically: <T>(work: (tx: CacheTransaction) => Promise<T>) => Promise<T>
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
    game_id text,
    message text
  )`,
  `CREATE TABLE IF NOT EXISTS local_players (
    local_id integer PRIMARY KEY,
    server_id integer,
    team_id text NOT NULL,
    body text NOT NULL
  )`
]

/** Columns added after a file may already have been made without them. */
const ADDED_COLUMNS: Array<[table: string, column: string, type: string]> = [
  ['outbox', 'message', 'text'],
  ['outbox', 'names', 'text']
]

function outboxRowOf(row: SqlRow): OutboxRow {
  const dependsOn: unknown = JSON.parse(String(row.depends_on))
  return {
    id: String(row.id),
    idempotencyKey: String(row.idempotency_key),
    seq: Number(row.seq),
    chain: String(row.chain),
    method: String(row.method),
    path: String(row.path),
    body: String(row.body),
    dependsOn: Array.isArray(dependsOn) ? dependsOn.map(String) : [],
    state: String(row.state) as OutboxState,
    attempts: Number(row.attempts),
    leaseUntil: row.lease_until == null ? null : Number(row.lease_until),
    gameId: typeof row.game_id === 'string' ? row.game_id : null,
    message: typeof row.message === 'string' ? row.message : null,
    names: typeof row.names === 'string' ? row.names : null
  }
}

const OUTBOX_COLUMNS: Record<string, string> = {
  body: 'body',
  state: 'state',
  attempts: 'attempts',
  leaseUntil: 'lease_until',
  message: 'message'
}

function transactionOf(tx: SqlTransaction): CacheTransaction {
  return {
    read: async key => await readIn(tx, key),
    forget: async key => {
      await tx.execute('DELETE FROM documents WHERE key = ? AND pending = 0', [
        key
      ])
    },
    write: async (key, document) => {
      await tx.execute(
        `INSERT INTO documents (key, body, revision, server_digest, pending)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT (key) DO UPDATE SET
           body = excluded.body,
           revision = excluded.revision,
           server_digest = excluded.server_digest,
           pending = excluded.pending`,
        [
          key,
          document.body,
          document.revision,
          document.serverDigest,
          document.pending ? 1 : 0
        ]
      )
    },
    outbox: async () =>
      (await tx.execute('SELECT * FROM outbox ORDER BY seq')).map(outboxRowOf),
    enqueue: async row => {
      const [last] = await tx.execute(
        'SELECT COALESCE(MAX(seq), 0) AS seq FROM outbox'
      )
      const queued: OutboxRow = {
        ...row,
        seq: Number(last.seq) + 1,
        state: 'pending',
        attempts: 0,
        leaseUntil: null,
        message: null,
        names: row.names ?? null
      }
      await tx.execute(
        `INSERT INTO outbox (id, idempotency_key, seq, chain, method, path,
           body, depends_on, state, attempts, lease_until, game_id, message,
           names)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          queued.id,
          queued.idempotencyKey,
          queued.seq,
          queued.chain,
          queued.method,
          queued.path,
          queued.body,
          JSON.stringify(queued.dependsOn),
          queued.state,
          queued.attempts,
          queued.leaseUntil,
          queued.gameId,
          queued.message,
          queued.names
        ]
      )
      return queued
    },
    update: async (id, fields) => {
      const names = Object.keys(fields) as Array<keyof typeof fields>
      if (names.length === 0) return
      await tx.execute(
        `UPDATE outbox SET ${names
          .map(name => `${OUTBOX_COLUMNS[name]} = ?`)
          .join(', ')} WHERE id = ?`,
        [...names.map(name => fields[name] ?? null), id]
      )
    },
    remove: async id => {
      await tx.execute('DELETE FROM outbox WHERE id = ?', [id])
    },
    removeKey: async idempotencyKey => {
      await tx.execute('DELETE FROM outbox WHERE idempotency_key = ?', [
        idempotencyKey
      ])
    },
    localPlayers: async () =>
      (
        await tx.execute(
          'SELECT local_id, server_id, team_id, body FROM local_players'
        )
      ).map(row => ({
        localId: Number(row.local_id),
        serverId: row.server_id == null ? null : Number(row.server_id),
        teamId: String(row.team_id),
        body: String(row.body)
      })),
    forgetLocalPlayer: async localId => {
      await tx.execute('DELETE FROM local_players WHERE local_id = ?', [
        localId
      ])
    },
    addLocalPlayer: async player => {
      await tx.execute(
        `INSERT INTO local_players (local_id, server_id, team_id, body)
         VALUES (?, ?, ?, ?)`,
        [player.localId, player.serverId, player.teamId, player.body]
      )
    },
    landPlayer: async (localId, serverId, body) => {
      await tx.execute(
        'UPDATE local_players SET server_id = ?, body = ? WHERE local_id = ?',
        [serverId, body, localId]
      )
    }
  }
}

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
    for (const [table, column, type] of ADDED_COLUMNS) {
      const columns = await tx.execute(`PRAGMA table_info(${table})`)
      if (!columns.some(row => row.name === column))
        await tx.execute(`ALTER TABLE ${table} ADD COLUMN ${column} ${type}`)
    }
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
    atomically: async work =>
      await serially(async tx => await work(transactionOf(tx))),
    close,
    destroy: async () => {
      await close()
      await executor.delete()
    }
  }
}
