import { HttpError } from '../../common/errors'
import type { NewRosterPlayer } from '../../common/playerSettings'
import { userIdOfGumbo } from '../../common/userId'
import type {
  CacheTransaction,
  DocumentStore,
  OutboxRow,
  OutboxState,
  StoredDocument
} from './cacheStore'
import {
  eventsKey,
  fullRosterKey,
  gameKey,
  lineupsKey,
  rosterKey
} from './documentKeys'
import {
  appliedEvents,
  appliedLineups,
  isLocal,
  type LandedIds,
  LOCAL_PREFIX,
  localRosterEntry,
  namedLocalIds,
  plainEntry,
  renamedEvents,
  renamedGuestEntry,
  withServerIds
} from './optimistic'

/**
 * The phone's queue of writes the server has not answered: a roster player
 * made, a lineup saved, a live play posted. Each is written onto the phone's
 * documents as it is queued, in the same SQLite transaction, and sent later
 * in order, with one `Idempotency-Key` however many times it is sent.
 *
 * Rows go in chains, `game:<gameId>` and `team:<teamId>`. One drain sends at
 * a time: the oldest row of each chain, the lowest `seq` first, and nothing
 * of a chain while an earlier row of it is unfinished.
 *
 * - A 2xx deletes the row and stores its answer on the documents it wrote,
 *   with the chain's later rows written over it again.
 * - No signal or a 5xx returns it to `pending` and waits 1s, 2s, 4s, 8s,
 *   then 15s, each up to a fifth longer, before the next send; a 2xx
 *   resets the wait.
 * - A 401 returns it to `pending` and sends nothing until the token changes.
 * - A stale 409 on a game parks that game's chain; any other 4xx is dead.
 *   Either stops that chain, and a row that waits for a player whose create
 *   is held parks too. Every other chain keeps draining. A game-only
 *   player's rename the server refuses is dropped alone: its game's chain
 *   keeps draining, and the documents it wrote are read again.
 *
 * The drain runs when woken: the app coming to the front, the network
 * coming back, any request that succeeded. It never runs in the background.
 */

/**
 * The names of the players a queued write's body names, by gumbo id, kept on
 * the phone beside it and never sent.
 */
export type DeviceNames = Record<string, string>

/** A write the phone queues when the server cannot answer it. */
export type QueuedCall =
  | { kind: 'roster'; teamId: string; path: string; body: unknown }
  | { kind: 'lineups'; gameId: string; path: string; body: unknown }
  | {
      kind: 'events'
      gameId: string
      path: string
      body: unknown
      /** The names of the players its plays name, which the body holds none of. */
      names?: DeviceNames
    }
  | {
      /** A game-only player's name corrected: `PUT`, on the game's chain. */
      kind: 'guestRename'
      gameId: string
      userId: string
      path: string
      body: unknown
      /** The player's gumbo id, and the name he is given. */
      names?: DeviceNames
    }

const ROSTER_PATH = /^\/teams\/([^/?]+)\/roster-players$/
const LINEUPS_PATH = /^\/games\/([^/?]+)\/lineups$/
const EVENTS_PATH = /^\/games\/([^/?]+)\/events$/
const GUEST_PATH = /^\/games\/([^/?]+)\/guest-players\/([^/?]+)$/

function decoded(id: string): string | undefined {
  try {
    return decodeURIComponent(id)
  } catch {
    return undefined
  }
}

/**
 * The queued write `method path` is, or none for a call that is not one:
 * a `POST` of a roster player, a lineup or a live post, or the `PUT` of a
 * game-only player's name. `names` are the device's names kept beside it.
 */
export function queuedCallOf(
  method: string,
  path: string,
  body: unknown,
  names?: DeviceNames
): QueuedCall | undefined {
  if (method === 'PUT') {
    const guest = GUEST_PATH.exec(path)
    const gameId = guest == null ? undefined : decoded(guest[1])
    const userId = guest == null ? undefined : decoded(guest[2])
    if (gameId == null || userId == null) return undefined
    return {
      kind: 'guestRename',
      gameId,
      userId,
      path,
      body,
      ...(names == null ? {} : { names })
    }
  }
  if (method !== 'POST') return undefined
  const roster = ROSTER_PATH.exec(path)
  const teamId = roster == null ? undefined : decoded(roster[1])
  if (teamId != null) return { kind: 'roster', teamId, path, body }
  const lineups = LINEUPS_PATH.exec(path)
  const lineupsGame = lineups == null ? undefined : decoded(lineups[1])
  if (lineupsGame != null)
    return { kind: 'lineups', gameId: lineupsGame, path, body }
  const events = EVENTS_PATH.exec(path)
  const eventsGame = events == null ? undefined : decoded(events[1])
  // Only a live post, a play at a time, is queued.
  if (eventsGame != null && (body as { mode?: unknown })?.mode === 'live')
    return {
      kind: 'events',
      gameId: eventsGame,
      path,
      body,
      ...(names == null ? {} : { names })
    }
  return undefined
}

/** The method a queued write is sent with. */
export function methodOf(call: QueuedCall): 'POST' | 'PUT' {
  return call.kind === 'guestRename' ? 'PUT' : 'POST'
}

export function chainOf(call: QueuedCall): string {
  return call.kind === 'roster' ? `team:${call.teamId}` : `game:${call.gameId}`
}

/** The row id of a player's create: what a write naming him waits for. */
const createRowId = (localId: number): string => `player-${localId}`

/** Why a write waits for good: a player it names was given up on. */
export const LOST_PLAYER_MESSAGE =
  'A player this names was not saved, and was taken off this phone.'

const localIdOfRow = (id: string): number | undefined => {
  const match = /^player-(\d+)$/.exec(id)
  return match == null ? undefined : Number(match[1])
}

/** How long a send holds its row before another process may send it. */
export const LEASE_MS = 60_000
/** The waits after a send that could not be answered, the last repeating. */
export const BACKOFF_MS = [1000, 2000, 4000, 8000, 15000]
/** Each wait is up to this much longer, so phones do not retry in step. */
export const JITTER = 0.2

/** A game or team whose queue has stopped, and why. */
export interface HeldChain {
  state: Extract<OutboxState, 'parked' | 'dead'>
  /** The server's message, for the screen that owns the game. */
  message: string | null
  /**
   * `player`: parked behind a player it names whose create the server
   * refused, or the phone gave up; `message` is why. A park with no cause is
   * a stale lineup.
   */
  cause?: 'player'
}

/** What the shell shows of the queue. */
export interface OutboxSummary {
  /** Writes still on the phone, sent or not. */
  count: number
  /** Those writes by chain (`game:<id>`, `team:<id>`): a game's own wait. */
  chains: Record<string, number>
  /** Each game whose queue is held, by its id. */
  games: Record<string, HeldChain>
  /** Each team whose queue of new players is held, by its id. */
  teams: Record<string, HeldChain>
}

export type OutboxListener = (summary: OutboxSummary) => void

export interface OutboxOptions {
  /** The open cache, or none. */
  store: () => Promise<DocumentStore | undefined>
  /**
   * Sends one request, with `Idempotency-Key` when `key` is set, and answers
   * the server's JSON or throws its `HttpError`.
   */
  send: (
    method: 'POST' | 'PUT',
    path: string,
    body: unknown,
    key: string | undefined
  ) => Promise<unknown>
  /** The session's token now: after a 401 the drain waits for another. */
  token: () => string | undefined
  /**
   * Whether the file is still the session's to send from, asked again just
   * before each send. Always, when not given.
   */
  owns?: () => boolean
  /**
   * Reads `path` from the server into its document: what a discard or a
   * reused key dropped comes back from there. Throws when it does not.
   */
  read?: (path: string) => Promise<void>
  now?: () => number
  random?: () => number
  setTimer?: (run: () => void, ms: number) => unknown
  clearTimer?: (handle: unknown) => void
}

type Outcome =
  | { kind: 'ok'; answer: unknown }
  | { kind: 'retry'; network: boolean }
  | { kind: 'auth' }
  | { kind: 'park'; message: string }
  | { kind: 'dead'; message: string }
  | { kind: 'reused' }

/** What a failed send means for the row, by the error it threw. */
function outcomeOf(error: unknown, call: QueuedCall): Outcome {
  if (!(error instanceof HttpError))
    return {
      kind: 'dead',
      message: error instanceof Error ? error.message : String(error)
    }
  if (error.code === 'offline') return { kind: 'retry', network: true }
  if (error.status >= 500 || error.code === 'rateLimited')
    return { kind: 'retry', network: false }
  if (error.code === 'unauthorized') return { kind: 'auth' }
  // The key went with another body once: the change may have landed under
  // it. Not a refusal to show, and not one to send again.
  if (error.code === 'idempotencyKeyReused') return { kind: 'reused' }
  const details = error.details as
    { stale?: unknown; retry?: unknown } | null | undefined
  // A conflict the server says to send again as it is: the game moved while
  // it saved (a lineup save that raced another write). Waited for, as a 5xx.
  if (error.code === 'conflict' && details?.retry === true)
    return { kind: 'retry', network: false }
  const stale = details?.stale === true
  if (error.code === 'conflict' && stale && call.kind !== 'roster')
    return { kind: 'park', message: error.message }
  return { kind: 'dead', message: error.message }
}

/** A failure a queued write survives: no signal, a 5xx, too many requests. */
function isRetryable(error: unknown, call: QueuedCall): boolean {
  return outcomeOf(error, call).kind === 'retry'
}

const isHeld = (state: OutboxState): boolean =>
  state === 'parked' || state === 'dead'

type Json = Record<string, unknown>

const parsed = (text: string): Json => {
  const raw: unknown = JSON.parse(text)
  return raw != null && typeof raw === 'object' && !Array.isArray(raw)
    ? (raw as Json)
    : {}
}

/** The field a game write names the lineups digest it was built on in. */
function baseField(call: QueuedCall): 'base' | 'lineupsBase' | undefined {
  return call.kind === 'lineups'
    ? 'base'
    : call.kind === 'events'
      ? 'lineupsBase'
      : undefined
}

/** The device names a row keeps beside its body. */
function namesOfRow(row: OutboxRow): DeviceNames | undefined {
  if (row.names == null) return undefined
  const raw = parsed(row.names)
  return Object.fromEntries(
    Object.entries(raw).filter(
      (pair): pair is [string, string] => typeof pair[1] === 'string'
    )
  )
}

/** The call a queued row is. */
function callOfRow(row: OutboxRow): QueuedCall {
  return queuedCallOf(row.method, row.path, parsed(row.body), namesOfRow(row))!
}

/** The gumbo id a rename names, and the name it gives him. */
function renameOf(call: Extract<QueuedCall, { kind: 'guestRename' }>): {
  gumboId: number | null
  name: { firstName: string; lastName: string }
} {
  const body = (call.body ?? {}) as Json
  const part = (value: unknown): string =>
    typeof value === 'string' ? value.trim() : ''
  const id = Number(Object.keys(call.names ?? {})[0])
  return {
    gumboId: Number.isSafeInteger(id) && id > 0 ? id : null,
    name: { firstName: part(body.firstName), lastName: part(body.lastName) }
  }
}

/** The documents a queued call writes, and the read that fills each. */
function documentsOf(call: QueuedCall): Array<{ key: string; path: string }> {
  if (call.kind === 'roster') {
    const team = `/teams/${encodeURIComponent(call.teamId)}/roster`
    return [
      { key: rosterKey(call.teamId), path: team },
      { key: fullRosterKey(call.teamId), path: `${team}?includeFullNames=true` }
    ]
  }
  const game = `/games/${encodeURIComponent(call.gameId)}`
  return call.kind === 'lineups'
    ? [{ key: lineupsKey(call.gameId), path: `${game}/lineups` }]
    : [{ key: eventsKey(call.gameId), path: `${game}/events` }]
}

/** The document a game write keeps: its lineups, or its plays. */
function ownKey(call: Exclude<QueuedCall, { kind: 'roster' }>): string {
  return call.kind === 'lineups'
    ? lineupsKey(call.gameId)
    : eventsKey(call.gameId)
}

export class Outbox {
  private readonly options: Required<Omit<OutboxOptions, 'read' | 'owns'>> &
    Pick<OutboxOptions, 'read' | 'owns'>

  private draining: Promise<void> | undefined
  private again = false
  private active = true
  /** How many sends in a row could not be answered. */
  private failures = 0
  /** No send before this, in epoch milliseconds. */
  private retryAt = 0
  /** Whether the last failure was no signal, which a working request ends. */
  private lastNetwork = false
  /** Set by a 401: nothing is sent while the token is still this one. */
  private paused: { token: string | undefined } | undefined
  private timer: unknown
  /** The last drain found nothing it could send, and nothing was queued since. */
  private idle = false
  private readonly chains = new Map<string, Promise<unknown>>()
  private readonly listeners = new Set<OutboxListener>()

  constructor(options: OutboxOptions) {
    this.options = {
      now: Date.now,
      random: Math.random,
      setTimer: (run, ms) => setTimeout(run, ms),
      clearTimer: handle => {
        clearTimeout(handle as ReturnType<typeof setTimeout>)
      },
      ...options
    }
  }

  /**
   * Sends `call` now when nothing of its chain is queued before it, and
   * queues it when its chain has a write waiting or a player it names is
   * not made yet. A send that cannot be answered (no signal, a 5xx) is
   * queued with the key it was sent with. Answers the server's JSON, or for
   * a queued write the phone's.
   */
  async submit(call: QueuedCall): Promise<unknown> {
    const chain = chainOf(call)
    const before = this.chains.get(chain) ?? Promise.resolve()
    const run = before.then(async () => await this.submitNow(call))
    // The next call of the chain waits for this one, whatever it came to.
    const settled: Promise<void> = run.then(
      () => {
        if (this.chains.get(chain) === settled) this.chains.delete(chain)
      },
      () => {
        if (this.chains.get(chain) === settled) this.chains.delete(chain)
      }
    )
    this.chains.set(chain, settled)
    return await run
  }

  /** Sends what can be sent, one row at a time. One drain runs at once. */
  async drain(): Promise<void> {
    if (this.draining != null) {
      this.again = true
      await this.draining
      return
    }
    this.draining = (async () => {
      do {
        this.again = false
        try {
          await this.drainOnce()
        } catch {
          // A file that cannot be read or written sends nothing this time.
          return
        }
      } while (this.again)
    })().finally(() => {
      this.draining = undefined
    })
    await this.draining
  }

  /**
   * Starts a drain. `reachable` is a sign the server answers again: a
   * request that succeeded, the network back. It ends a wait that no signal
   * began, and is passed over when nothing is queued.
   */
  wake(reachable = false): void {
    if (reachable) {
      if (this.idle) return
      if (this.lastNetwork) this.retryAt = 0
    }
    this.drain().catch(() => undefined)
  }

  /** Whether the app is in front. Nothing is sent from the background. */
  setActive(active: boolean): void {
    this.active = active
    if (active) this.wake()
  }

  /** A new person's file, or none: forget every wait. */
  reset(): void {
    this.options.clearTimer(this.timer)
    this.timer = undefined
    this.failures = 0
    this.retryAt = 0
    this.lastNetwork = false
    this.paused = undefined
    this.idle = false
  }

  /**
   * Gives up what the phone still holds for `chain`, which the server has
   * stopped (a stale lineup, a refusal): every row of the chain, and a held
   * create one of them waits for that no row left behind waits for too. A
   * player whose create goes is no longer the phone's to name. The
   * documents those rows wrote are dropped, unless another row still queued
   * writes them, so nothing given up is shown as the server's: they are read
   * again from the server. Answers whether those reads all came back. A
   * chain with a row in flight is left as it is.
   */
  async discard(chain: string): Promise<boolean> {
    const store = await this.options.store()
    if (store == null) return true
    const reads = await store.atomically(async tx => {
      const rows = await tx.outbox()
      const own = rows.filter(row => row.chain === chain)
      if (own.some(row => row.state === 'inflight')) return undefined
      const byId = new Map(rows.map(row => [row.id, row]))
      const dropped = new Set(own.map(row => row.id))
      for (const row of own)
        for (const id of row.dependsOn) {
          const create = byId.get(id)
          if (create == null || !isHeld(create.state)) continue
          const sharedWith = rows.some(
            other =>
              !dropped.has(other.id) &&
              other.chain !== chain &&
              other.chain !== create.chain &&
              other.dependsOn.includes(id)
          )
          if (!sharedWith) dropped.add(id)
        }
      return await this.drop(tx, dropped)
    })
    if (reads == null) return false
    this.notify()
    return await this.reread(reads)
  }

  /**
   * Deletes `ids`, forgets the players their creates would have made, and
   * drops the documents they wrote that no row left writes. Answers the
   * reads that bring those documents back.
   */
  private async drop(
    tx: CacheTransaction,
    ids: Set<string>
  ): Promise<string[]> {
    const rows = await tx.outbox()
    const byId = new Map(rows.map(row => [row.id, row]))
    const kept = rows.filter(row => !ids.has(row.id))
    const stillWritten = new Set(
      kept.flatMap(row => documentsOf(callOfRow(row)).map(doc => doc.key))
    )
    const unmade = new Set(
      (await tx.localPlayers())
        .filter(player => player.serverId == null)
        .map(player => player.localId)
    )
    const reads = new Map<string, string>()
    for (const id of ids) {
      const row = byId.get(id)
      if (row == null) continue
      await tx.remove(id)
      const localId = localIdOfRow(id)
      if (localId != null && unmade.has(localId))
        await tx.forgetLocalPlayer(localId)
      for (const doc of documentsOf(callOfRow(row)))
        if (!stillWritten.has(doc.key)) reads.set(doc.key, doc.path)
    }
    for (const key of reads.keys()) {
      const held = await tx.read(key)
      if (held == null) continue
      // Unheld first: `forget` keeps a document a queued write holds.
      if (held.pending) await tx.write(key, { ...held, pending: false })
      await tx.forget(key)
    }
    return [...reads.values()]
  }

  /** Reads `paths` from the server again; whether every one came back. */
  private async reread(paths: string[]): Promise<boolean> {
    const read = this.options.read
    if (read == null) return paths.length === 0
    const answers = await Promise.allSettled(
      paths.map(async path => {
        await read(path)
      })
    )
    return answers.every(answer => answer.status === 'fulfilled')
  }

  /**
   * Sends `chain` again from where the server stopped it, with a held create
   * one of its rows waits for: for a refusal that may not repeat.
   */
  async retry(chain: string): Promise<void> {
    const store = await this.options.store()
    if (store == null) return
    await store.atomically(async tx => {
      const rows = await tx.outbox()
      const byId = new Map(rows.map(row => [row.id, row]))
      const again = new Set<OutboxRow>()
      for (const row of rows)
        if (row.chain === chain) {
          if (isHeld(row.state)) again.add(row)
          for (const id of row.dependsOn) {
            const create = byId.get(id)
            if (create != null && isHeld(create.state)) again.add(create)
          }
        }
      // A team's creates going again: each game parked behind one of them
      // goes after it, from its head on. A game whose head is parked for a
      // stale lineup is its own to try again.
      const own = new Set(
        rows.filter(row => row.chain === chain).map(row => row.id)
      )
      const heads = new Map<string, OutboxRow>()
      for (const row of rows)
        if (!heads.has(row.chain)) heads.set(row.chain, row)
      for (const head of heads.values()) {
        if (head.chain === chain || head.state !== 'parked') continue
        if (!head.dependsOn.some(id => own.has(id))) continue
        for (const row of rows)
          if (row.chain === head.chain && row.state === 'parked') again.add(row)
      }
      for (const row of again)
        await tx.update(row.id, { state: 'pending', message: null })
    })
    this.idle = false
    this.notify()
    this.wake(true)
  }

  /** Tells `listener` the queue each time it changes, until unsubscribed. */
  subscribe(listener: OutboxListener): () => void {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  /** The queue as it stands. */
  async summary(): Promise<OutboxSummary> {
    const store = await this.options.store()
    const { rows, made } =
      store == null
        ? { rows: [], made: new Set<number>() }
        : await store.atomically(async tx => ({
            rows: await tx.outbox(),
            made: new Set(
              (await tx.localPlayers())
                .filter(player => player.serverId != null)
                .map(player => player.localId)
            )
          }))
    const byId = new Map(rows.map(row => [row.id, row]))
    // A create still held, or gone with its player never made.
    const blocks = (id: string): boolean => {
      const create = byId.get(id)
      if (create != null) return isHeld(create.state)
      const localId = localIdOfRow(id)
      return localId != null && !made.has(localId)
    }
    const summary: OutboxSummary = {
      count: rows.length,
      chains: {},
      games: {},
      teams: {}
    }
    for (const row of rows)
      summary.chains[row.chain] = (summary.chains[row.chain] ?? 0) + 1
    const heads = new Set<string>()
    for (const row of rows) {
      if (heads.has(row.chain)) continue
      heads.add(row.chain)
      if (!isHeld(row.state)) continue
      const held: HeldChain = {
        state: row.state as HeldChain['state'],
        message: row.message,
        ...(row.state === 'parked' && row.dependsOn.some(blocks)
          ? { cause: 'player' as const }
          : {})
      }
      const [kind, id] = [row.chain.slice(0, 5), row.chain.slice(5)]
      if (kind === 'game:') summary.games[id] = held
      else summary.teams[id] = held
    }
    return summary
  }

  private notify(): void {
    if (this.listeners.size === 0) return
    this.summary().then(
      summary => {
        for (const listener of this.listeners) listener(summary)
      },
      () => undefined
    )
  }

  private makeId(): string {
    return [...randomBytes(16)]
      .map(byte => byte.toString(16).padStart(2, '0'))
      .join('')
  }

  private async submitNow(call: QueuedCall): Promise<unknown> {
    const store = await this.options.store()
    const method = methodOf(call)
    if (store == null)
      return await this.options.send(method, call.path, call.body, undefined)
    const chain = chainOf(call)
    let waits: boolean
    try {
      waits = await store.atomically(async tx => {
        const rows = await tx.outbox()
        if (rows.some(row => row.chain === chain)) return true
        return (await this.dependencies(tx, rows, call.body)).length > 0
      })
    } catch {
      // A file that cannot be read queues nothing: the call is sent as is.
      return await this.options.send(method, call.path, call.body, undefined)
    }
    // A session that is not the file's: its write is not this file's either.
    if (this.options.owns?.() === false)
      return await this.options.send(method, call.path, call.body, undefined)
    const key = this.makeId()
    if (waits) return await this.enqueue(store, call, key)
    const body = await store.atomically(
      async tx => await this.prepared(tx, call, call.body)
    )
    let answer: unknown
    try {
      answer = await this.options.send(method, call.path, body, key)
    } catch (error: unknown) {
      if (!isRetryable(error, call)) throw error
      this.failed(outcomeOf(error, call) as { kind: 'retry'; network: boolean })
      // Queued as sent, so a retry under the same key is the same request.
      return await this.enqueue(store, call, key, error, body)
    }
    this.succeeded()
    await store.atomically(async tx => {
      await this.landed(tx, call, undefined, key, body, answer)
    })
    this.notify()
    return answer
  }

  /** Writes `call` onto the documents and queues it, in one transaction. */
  private async enqueue(
    store: DocumentStore,
    call: QueuedCall,
    key: string,
    cause?: unknown,
    /** The body already sent under `key`, when it was. */
    sent?: unknown
  ): Promise<unknown> {
    const answer = await store.atomically(async tx => {
      const dependsOn = await this.dependencies(
        tx,
        await tx.outbox(),
        call.body
      )
      const written = await this.optimistic(tx, call)
      if (written == null) return undefined
      await tx.enqueue({
        id: written.id ?? this.makeId(),
        idempotencyKey: key,
        chain: chainOf(call),
        method: methodOf(call),
        path: call.path,
        body: JSON.stringify(sent === undefined ? call.body : sent),
        names:
          call.kind === 'events' || call.kind === 'guestRename'
            ? call.names == null
              ? null
              : JSON.stringify(call.names)
            : null,
        dependsOn,
        gameId: call.kind === 'roster' ? null : call.gameId
      })
      return written.answer
    })
    if (answer === undefined)
      throw cause instanceof Error
        ? cause
        : new HttpError(
            'unavailable',
            'This game is not on the phone yet. Try again in a moment.'
          )
    this.idle = false
    this.notify()
    this.wake()
    return answer
  }

  /** The creates still queued of the players the phone made that `body` names. */
  private async dependencies(
    tx: CacheTransaction,
    rows: OutboxRow[],
    body: unknown
  ): Promise<string[]> {
    const unmade = new Set(
      (await tx.localPlayers())
        .filter(player => player.serverId == null)
        .map(player => player.localId)
    )
    if (unmade.size === 0) return []
    const queued = new Set(rows.map(row => row.id))
    return namedLocalIds(body, unmade)
      .map(createRowId)
      .filter(id => queued.has(id))
  }

  /**
   * The phone's answer to `call`, written onto its documents and marked
   * pending; or none when the documents it builds on are not on the phone.
   */
  private async optimistic(
    tx: CacheTransaction,
    call: QueuedCall
  ): Promise<{ answer: unknown; id?: string } | undefined> {
    if (call.kind === 'roster') return await this.localPlayer(tx, call)
    if (call.kind === 'guestRename') return await this.renamed(tx, call)
    const key = ownKey(call)
    const held = await tx.read(key)
    if (held == null) return undefined
    const next = await this.applied(tx, call, parsed(held.body), call.body)
    await tx.write(key, {
      ...held,
      body: JSON.stringify(next),
      pending: true
    })
    return { answer: next }
  }

  /**
   * A game-only player's rename, written onto the game's plays on the phone:
   * the name is the device's for his id until the server answers. The answer
   * is his roster entry as the server would give it.
   */
  private async renamed(
    tx: CacheTransaction,
    call: Extract<QueuedCall, { kind: 'guestRename' }>
  ): Promise<{ answer: unknown }> {
    const { gumboId, name } = renameOf(call)
    const held = await tx.read(eventsKey(call.gameId))
    if (held != null && gumboId != null)
      await tx.write(eventsKey(call.gameId), {
        ...held,
        body: JSON.stringify(renamedEvents(parsed(held.body), gumboId, name)),
        pending: true
      })
    const game = await tx.read(gameKey(call.gameId))
    return {
      answer: renamedGuestEntry(
        game == null ? {} : parsed(game.body),
        call.userId,
        gumboId,
        name
      )
    }
  }

  /** The server's ids of the players the phone made whose create landed. */
  private async landedIds(
    tx: CacheTransaction
  ): Promise<Map<number, LandedIds>> {
    const landed = new Map<number, LandedIds>()
    for (const player of await tx.localPlayers())
      if (player.serverId != null) {
        const userId = parsed(player.body).userId
        landed.set(player.localId, {
          serverId: player.serverId,
          userId: typeof userId === 'string' ? userId : null
        })
      }
    return landed
  }

  /** `body` applied onto `document` as the server would answer it. */
  private async applied(
    tx: CacheTransaction,
    call: Exclude<QueuedCall, { kind: 'roster' }>,
    document: Json,
    body: unknown
  ): Promise<Json> {
    if (call.kind === 'guestRename') {
      const { gumboId, name } = renameOf(call)
      return gumboId == null ? document : renamedEvents(document, gumboId, name)
    }
    if (call.kind === 'lineups')
      return appliedLineups(document, body, `${LOCAL_PREFIX}${this.makeId()}`)
    // The lineups digest the phone answers is the one the post was built
    // on, when it names one: the scorer's next post names it in turn, and
    // as the base of an earlier row of the chain it is rewritten from that
    // row's answer, so a phone's own chain never refuses itself as stale.
    // A post naming none builds on the lineups the phone shows.
    const named = (body as Json | null)?.lineupsBase
    const lineups = await tx.read(lineupsKey(call.gameId))
    const digest =
      typeof named === 'string'
        ? named
        : lineups == null
          ? document.lineupsDigest
          : parsed(lineups.body).digest
    // The names kept beside it, by the phone's ids and by the server's for
    // a player whose create has landed since.
    const names = call.names ?? {}
    return appliedEvents(document, body, {
      gameId: call.gameId,
      plays: `${LOCAL_PREFIX}${this.makeId()}`,
      lineups: typeof digest === 'string' ? digest : null,
      newPlayId: () => `${LOCAL_PREFIX}${this.makeId()}`,
      names: {
        ...(withServerIds(names, await this.landedIds(tx)) as DeviceNames),
        ...names
      }
    })
  }

  /**
   * A player made on the phone: a gumbo id no roster on the phone has, his
   * entry on the team's rosters, and his create's row id.
   */
  private async localPlayer(
    tx: CacheTransaction,
    call: Extract<QueuedCall, { kind: 'roster' }>
  ): Promise<{ answer: unknown; id: string }> {
    const plain = await tx.read(rosterKey(call.teamId))
    const full = await tx.read(fullRosterKey(call.teamId))
    const taken = new Set<unknown>(
      (await tx.localPlayers()).map(player => player.localId)
    )
    for (const document of [plain, full])
      for (const entry of document == null ? [] : listOf(document.body)) {
        taken.add(entry.gumboId)
        taken.add(entry.userId)
      }
    let localId: number
    do localId = randomGumboId()
    while (taken.has(localId) || taken.has(userIdOfGumbo(localId)))
    const entry = localRosterEntry(localId, call.body as NewRosterPlayer, true)
    await tx.addLocalPlayer({
      localId,
      serverId: null,
      teamId: call.teamId,
      body: JSON.stringify(entry)
    })
    for (const [key, document, shown] of [
      [rosterKey(call.teamId), plain, plainEntry(entry)],
      [fullRosterKey(call.teamId), full, entry]
    ] as const)
      if (document != null)
        await tx.write(key, {
          ...document,
          body: JSON.stringify([...listOf(document.body), shown]),
          pending: true
        })
    return { answer: entry, id: createRowId(localId) }
  }

  /**
   * `body` as it is sent: the server's ids for every player the phone made
   * whose create has landed, and never a digest the phone made. A digest
   * the phone made is the game's last one from the server.
   */
  private async prepared(
    tx: CacheTransaction,
    call: QueuedCall,
    body: unknown
  ): Promise<unknown> {
    const sent = withServerIds(body, await this.landedIds(tx))
    const field = baseField(call)
    if (field == null || call.kind === 'roster') return sent
    const { [field]: base, ...rest } = sent as Json
    if (!isLocal(base)) return sent
    const digest = await this.serverDigest(tx, call.gameId)
    // A lineup save names a base, empty or not; a live post may name none.
    if (digest == null) return field === 'base' ? { ...rest, base: '' } : rest
    return { ...rest, [field]: digest }
  }

  /** The lineups digest of the game's last answer from the server. */
  private async serverDigest(
    tx: CacheTransaction,
    gameId: string
  ): Promise<string | null> {
    return (
      (await tx.read(lineupsKey(gameId)))?.serverDigest ??
      (await tx.read(eventsKey(gameId)))?.serverDigest ??
      null
    )
  }

  /**
   * A 2xx for `call`: its row deleted, and its answer stored on the
   * documents it wrote, with every later row of its chain that wrote them
   * written over it again. Those documents stay pending until no row of the
   * chain that wrote them is left. A later row built on the lineups this
   * one replaced, or on the phone's own digest, now builds on its answer.
   */
  private async landed(
    tx: CacheTransaction,
    call: QueuedCall,
    row: OutboxRow | undefined,
    key: string,
    sent: unknown,
    answer: unknown
  ): Promise<void> {
    if (row == null) await tx.removeKey(key)
    else await tx.remove(row.id)
    const chain = chainOf(call)
    const later = (await tx.outbox()).filter(other => other.chain === chain)
    if (call.kind === 'roster') {
      await this.landedPlayer(tx, call, row, answer, later)
      return
    }
    if (call.kind === 'guestRename') {
      await this.landedRename(tx, call)
      return
    }
    const response = (answer ?? {}) as Json
    const digestOf = (raw: Json): unknown =>
      call.kind === 'lineups' ? raw.digest : raw.lineupsDigest
    const digest = digestOf(response)
    const serverDigest = typeof digest === 'string' ? digest : null
    const field = baseField(call)!
    const bases = new Set<unknown>([
      (sent as Json)?.[field],
      row == null ? undefined : parsed(row.body)[field]
    ])
    for (const other of later) {
      const otherCall = callOfRow(other)
      const otherField = baseField(otherCall)
      if (otherField == null || serverDigest == null) continue
      const body = parsed(other.body)
      const base = body[otherField]
      if (typeof base !== 'string') continue
      if (!isLocal(base) && !bases.has(base)) continue
      body[otherField] = serverDigest
      other.body = JSON.stringify(body)
      await tx.update(other.id, { body: other.body })
    }
    const own = ownKey(call)
    const rewriting = later.filter(other =>
      documentsOf(callOfRow(other)).some(doc => doc.key === own)
    )
    let document = response
    for (const other of rewriting)
      document = await this.applied(
        tx,
        callOfRow(other) as Exclude<QueuedCall, { kind: 'roster' }>,
        document,
        parsed(other.body)
      )
    const held = await tx.read(own)
    await tx.write(own, {
      body: JSON.stringify(document),
      revision: held?.revision ?? '0',
      serverDigest,
      pending: rewriting.length > 0
    })
    // The game's other document carries the same lineups digest: as its
    // server digest, and in its body too unless a queued write holds it,
    // so the next answer the phone makes from it names the server's.
    const other =
      call.kind === 'lineups' ? eventsKey(call.gameId) : lineupsKey(call.gameId)
    const kept = await tx.read(other)
    if (kept != null && serverDigest != null) {
      const field = call.kind === 'lineups' ? 'lineupsDigest' : 'digest'
      await tx.write(other, {
        ...kept,
        serverDigest,
        body: kept.pending
          ? kept.body
          : JSON.stringify({ ...parsed(kept.body), [field]: serverDigest })
      })
    }
  }

  /**
   * A rename landed: the game's plays the phone wrote it onto are the
   * server's to answer again, once no write still queued holds them.
   */
  private async landedRename(
    tx: CacheTransaction,
    call: Extract<QueuedCall, { kind: 'guestRename' }>
  ): Promise<void> {
    const key = eventsKey(call.gameId)
    const writing = (await tx.outbox()).some(other =>
      documentsOf(callOfRow(other)).some(doc => doc.key === key)
    )
    const held = await tx.read(key)
    if (held != null && !writing && held.pending)
      await tx.write(key, { ...held, pending: false })
  }

  /** A player's create landed: his ids recorded, his entries the server's. */
  private async landedPlayer(
    tx: CacheTransaction,
    call: Extract<QueuedCall, { kind: 'roster' }>,
    row: OutboxRow | undefined,
    answer: unknown,
    later: OutboxRow[]
  ): Promise<void> {
    const entry = (answer ?? {}) as Json
    const localId = row == null ? undefined : localIdOfRow(row.id)
    if (localId != null && typeof entry.gumboId === 'number')
      await tx.landPlayer(localId, entry.gumboId, JSON.stringify(entry))
    for (const [key, shown] of [
      [rosterKey(call.teamId), plainEntry(entry)],
      [fullRosterKey(call.teamId), entry]
    ] as const) {
      const held: StoredDocument | undefined = await tx.read(key)
      if (held == null) continue
      const others = listOf(held.body).filter(
        listed =>
          listed.userId !== entry.userId &&
          (localId == null || listed.gumboId !== localId)
      )
      await tx.write(key, {
        ...held,
        body: JSON.stringify([...others, shown]),
        pending: later.length > 0 && held.pending
      })
    }
  }

  private failed(outcome: { kind: 'retry'; network: boolean }): void {
    this.failures++
    this.lastNetwork = outcome.network
    const wait =
      BACKOFF_MS[Math.min(this.failures, BACKOFF_MS.length) - 1] *
      (1 + this.options.random() * JITTER)
    this.retryAt = this.options.now() + wait
    this.schedule(wait)
  }

  private succeeded(): void {
    this.failures = 0
    this.retryAt = 0
    this.lastNetwork = false
  }

  private schedule(ms: number): void {
    this.options.clearTimer(this.timer)
    this.timer = this.options.setTimer(() => {
      this.timer = undefined
      this.wake()
    }, ms)
  }

  /** The next row to send, or none, as one transaction. */
  private async pick(tx: CacheTransaction): Promise<{
    row?: OutboxRow
    call?: QueuedCall
    body?: unknown
    changed: boolean
    leaseEnds?: number
  }> {
    const now = this.options.now()
    const rows = await tx.outbox()
    for (const row of rows)
      if (
        row.state === 'inflight' &&
        (row.leaseUntil == null || row.leaseUntil < now)
      ) {
        row.state = 'pending'
        row.leaseUntil = null
        await tx.update(row.id, { state: 'pending', leaseUntil: null })
      }
    const heads = new Map<string, OutboxRow>()
    for (const row of rows) if (!heads.has(row.chain)) heads.set(row.chain, row)
    const byId = new Map(rows.map(row => [row.id, row]))
    // A row held, or behind a held row of its own chain, will not land.
    const stuck = (id: string): OutboxRow | undefined => {
      const row = byId.get(id)
      if (row == null) return undefined
      if (isHeld(row.state)) return row
      const head = heads.get(row.chain)!
      return isHeld(head.state) ? head : undefined
    }
    const made = new Set(
      (await tx.localPlayers())
        .filter(player => player.serverId != null)
        .map(player => player.localId)
    )
    const unmade = (id: string): boolean => {
      const localId = localIdOfRow(id)
      return localId != null && !made.has(localId)
    }
    let changed = false
    let leaseEnds: number | undefined
    const ready: OutboxRow[] = []
    for (const head of heads.values()) {
      if (isHeld(head.state)) continue
      if (head.state === 'inflight') {
        leaseEnds = Math.min(leaseEnds ?? Infinity, head.leaseUntil!)
        continue
      }
      const holding = head.dependsOn.map(stuck).find(row => row != null)
      if (holding != null) {
        changed = true
        await this.park(
          tx,
          rows,
          head,
          holding.message ?? 'A player this names could not be added.'
        )
        continue
      }
      // A create given up on this phone: the player it names was never
      // made, and the server would refuse the phone's own id for him.
      const lost = head.dependsOn.some(id => !byId.has(id) && unmade(id))
      if (lost) {
        changed = true
        await this.park(tx, rows, head, LOST_PLAYER_MESSAGE)
        continue
      }
      if (head.dependsOn.some(id => byId.has(id))) continue
      ready.push(head)
    }
    const row = ready.sort((a, b) => a.seq - b.seq)[0]
    if (row == null) return { changed, leaseEnds }
    const call = callOfRow(row)
    // The body goes as it went the first time, byte for byte, under its
    // key: built once (the server's ids, the server's digest) and kept on
    // the row. Built again, it is the same request, so the key still is.
    const text = JSON.stringify(await this.prepared(tx, call, parsed(row.body)))
    await tx.update(row.id, {
      state: 'inflight',
      leaseUntil: now + LEASE_MS,
      ...(text === row.body ? {} : { body: text })
    })
    return { row, call, body: JSON.parse(text) as unknown, changed }
  }

  /** Parks `row` and every later row of its chain. */
  private async park(
    tx: CacheTransaction,
    rows: OutboxRow[],
    row: OutboxRow,
    message: string
  ): Promise<void> {
    for (const other of rows)
      if (other.chain === row.chain && other.seq >= row.seq)
        await tx.update(other.id, {
          state: 'parked',
          leaseUntil: null,
          ...(other.id === row.id ? { message } : {})
        })
  }

  private async drainOnce(): Promise<void> {
    for (;;) {
      if (!this.active) return
      if (this.paused != null) {
        if (this.options.token() === this.paused.token) return
        this.paused = undefined
      }
      const wait = this.retryAt - this.options.now()
      if (wait > 0) {
        if (this.timer == null) this.schedule(wait)
        return
      }
      const store = await this.options.store()
      if (store == null) return
      const picked = await store.atomically(async tx => await this.pick(tx))
      if (picked.changed) this.notify()
      const { row, call } = picked
      if (row == null || call == null) {
        if (picked.leaseEnds != null)
          this.schedule(Math.max(0, picked.leaseEnds - this.options.now()))
        else this.idle = true
        return
      }
      // The session changed while the row was read: it is not the new
      // session's to send. It waits for its own person's.
      if (this.options.owns?.() === false) {
        await store
          .atomically(async tx => {
            await tx.update(row.id, { state: 'pending', leaseUntil: null })
          })
          .catch(() => undefined)
        return
      }
      let outcome: Outcome
      try {
        outcome = {
          kind: 'ok',
          answer: await this.options.send(
            methodOf(call),
            row.path,
            picked.body,
            row.idempotencyKey
          )
        }
      } catch (error: unknown) {
        outcome = outcomeOf(error, call)
      }
      const go = await this.settle(store, row, call, picked.body, outcome)
      this.notify()
      if (!go) return
    }
  }

  /**
   * A refused rename, dropped on its own: the game's later writes still go,
   * and the documents it wrote that nothing queued holds are read again, so
   * the player's name is the server's once more.
   */
  private async dropAlone(
    store: DocumentStore,
    row: OutboxRow
  ): Promise<boolean> {
    const reads = await store.atomically(
      async tx => await this.drop(tx, new Set([row.id]))
    )
    await this.reread(reads)
    return true
  }

  /** Records what a send came to. Whether the drain goes on. */
  private async settle(
    store: DocumentStore,
    row: OutboxRow,
    call: QueuedCall,
    sent: unknown,
    outcome: Outcome
  ): Promise<boolean> {
    switch (outcome.kind) {
      case 'ok':
        this.succeeded()
        await store.atomically(async tx => {
          await this.landed(
            tx,
            call,
            row,
            row.idempotencyKey,
            sent,
            outcome.answer
          )
        })
        return true
      case 'retry':
        await store.atomically(async tx => {
          await tx.update(row.id, {
            state: 'pending',
            attempts: row.attempts + 1,
            leaseUntil: null
          })
        })
        this.failed(outcome)
        return false
      case 'auth':
        await store.atomically(async tx => {
          await tx.update(row.id, { state: 'pending', leaseUntil: null })
        })
        this.paused = { token: this.options.token() }
        return false
      case 'park':
        if (call.kind === 'guestRename') return await this.dropAlone(store, row)
        await store.atomically(async tx => {
          await this.park(tx, await tx.outbox(), row, outcome.message)
        })
        return true
      case 'dead':
        if (call.kind === 'guestRename') return await this.dropAlone(store, row)
        await store.atomically(async tx => {
          await tx.update(row.id, {
            state: 'dead',
            leaseUntil: null,
            message: outcome.message
          })
        })
        return true
      case 'reused': {
        // What it wrote is read from the server again, as a discard does.
        const reads = await store.atomically(
          async tx => await this.drop(tx, new Set([row.id]))
        )
        await this.reread(reads)
        return true
      }
    }
  }
}

/**
 * Random bytes: the platform's, or on Hermes without a crypto polyfill,
 * `Math.random`'s. A key only has to differ from this phone's others.
 */
function randomBytes(length: number): Uint8Array {
  const bytes = new Uint8Array(length)
  const crypto = (
    globalThis as {
      crypto?: { getRandomValues?: (array: Uint8Array) => Uint8Array }
    }
  ).crypto
  if (crypto?.getRandomValues != null) return crypto.getRandomValues(bytes)
  for (let i = 0; i < length; i++) bytes[i] = Math.floor(Math.random() * 256)
  return bytes
}

/** A positive safe integer, as a gumbo id is. */
function randomGumboId(): number {
  const bytes = randomBytes(7)
  // 53 bits: the high byte keeps five.
  let value = bytes[0] & 0x1f
  for (let i = 1; i < 7; i++) value = value * 256 + bytes[i]
  return value === 0 ? 1 : value
}

/** A roster document's entries. */
function listOf(body: string): Json[] {
  const raw: unknown = JSON.parse(body)
  return Array.isArray(raw)
    ? raw.filter(
        (entry): entry is Json => entry != null && typeof entry === 'object'
      )
    : []
}
