import { hostname } from 'node:os'

import { captureException, flush } from '@sentry/node'
import type { Kysely } from 'kysely'

import { type Database, makeDatabase } from '../../db/database'
import { scoreboardPrefix } from '../../scoreboard/scoreboardStore'
import {
  requestDatabaseUrl,
  type ServerConfig,
  serverConfig
} from '../../serverConfig'
import { clearRead, type ReadReport } from '../chatReads'
import { STALE_WAKE_MS, wakeChat } from '../chatWakes'
import { pushSettings, pushTransports } from '../config'
import { PushQueue, pushQueueClient, type QueueEntry } from '../queue'
import {
  afterFailure,
  pauseAfter,
  type PushOutcome,
  type PushRequest
} from '../requests'
import { remindOf } from '../rsvpReminders'
import type { PushReport, PushTransports } from '../send'

/** How many entries one read takes. */
const READ_COUNT = 16

/**
 * How many entries a sender has in hand at once, at most: each settles as
 * it finishes, and the room it leaves is read into, so one slow entry holds
 * up nothing but itself.
 */
const MAX_IN_HAND = 2 * READ_COUNT

/**
 * How often, with entries in hand, the queue is looked at again for new
 * requests and those come due: the read cannot wait on the connection the
 * entries in hand settle through.
 */
const IN_HAND_POLL_MS = 250

/** How long one read waits for an entry. */
const READ_BLOCK_MS = 5_000

/** How long a command may go unanswered: past a read's own wait. */
const COMMAND_TIMEOUT_MS = READ_BLOCK_MS + 5_000

/** How often entries another sender left in hand are looked for. */
const RECLAIM_EVERY_MS = 30_000

/**
 * How long an entry sits unsettled before another sender takes it over. A
 * sender renews its claim on the entries in hand three times in that
 * window, so a slow batch is never taken over, and sent twice, while its
 * sender is still at it.
 */
const RECLAIM_IDLE_MS = 60_000

/**
 * How long a stop waits for the entries in hand: inside the 5 s the
 * supervisor gives a child before it SIGKILLs it.
 */
const STOP_GRACE_MS = 4_000

/** How long the sender waits for Valkey on the way up. */
const CONNECT_WAIT_MS = 2_000

/** How often a run of failed turns is said again in the log, at most. */
const SAY_FAILING_EVERY_MS = 60_000

export type Clock = () => Date

/** What one request needs to be sent. */
export interface SenderDeps {
  db: Kysely<Database>
  transports: PushTransports
  /** Group messages go to iPhones as alerts the app may hide. */
  iosFiltering: boolean
  /**
   * How long after it was queued a chat request waits before it is sent
   * (`push.chatHoldSeconds`), so a member who reads the message in the app
   * meanwhile is not woken for it.
   */
  chatHoldMs: number
  clock: Clock
  log: (line: string) => void
}

/** One request's work: what became of it, and what it sent. */
export interface Handled {
  outcome: PushOutcome
  /** Null when there was nothing to send, or the work threw. */
  report: PushReport | null
}

/** A report's outcome: done, unless failures alone kept it from somebody. */
function handled(report: PushReport | null): Handled {
  if (report == null || report.unreached.length === 0)
    return { outcome: { status: 'done' }, report }
  return {
    outcome: {
      status: 'failed',
      error: `${report.unreached.length} unreached`,
      unreached: report.unreached
    },
    report
  }
}

/**
 * A read's outcome: done, unless a device's clear failed, which is tried
 * again on that device alone, or no device could be read, tried again on
 * them all.
 */
function cleared(report: ReadReport | null): Handled {
  if (
    report == null ||
    (report.retry.length === 0 && report.unreached.length === 0)
  )
    return { outcome: { status: 'done' }, report }
  return {
    outcome: {
      status: 'failed',
      error:
        report.retry.length > 0
          ? `${report.retry.length} device(s) not cleared`
          : `${report.unreached.length} unreached`,
      ...(report.retry.length > 0 ? { devices: report.retry } : {})
    },
    report
  }
}

/**
 * Does what one request asks: wakes a conversation's members' devices for a
 * post (`wakeChat`), marking on `queue` whom it reached; takes a read
 * conversation's notifications down from its reader's other devices
 * (`clearRead`); or reminds of an event start (`remindOf`). Work that
 * throws, or that left somebody unreached, has failed.
 */
export async function handleRequest(
  request: PushRequest,
  deps: SenderDeps,
  queue: Pick<PushQueue, 'markWoken' | 'wokenAt' | 'readPast'>
): Promise<Handled> {
  try {
    if (request.t === 'chat')
      return handled(
        await wakeChat(deps.db, request, {
          transports: deps.transports,
          iosFiltering: deps.iosFiltering,
          log: deps.log,
          now: deps.clock(),
          woke: async (userIds, conversationId, seq) =>
            await queue.markWoken(userIds, conversationId, seq),
          unwoke: async (userIds, conversationId, seq) => {
            await Promise.all(
              userIds.map(
                async userId =>
                  await queue.readPast(userId, conversationId, seq)
              )
            )
          }
        })
      )
    if (request.t === 'read')
      return cleared(
        await clearRead(deps.db, request, {
          transports: deps.transports,
          queue,
          log: deps.log,
          now: deps.clock()
        })
      )
    const reminded = await remindOf(
      deps.db,
      request,
      deps.clock(),
      deps.transports,
      deps.log
    )
    if (reminded.reminded > 0)
      deps.log(
        `push sender: sent ${reminded.reminded} RSVP reminder(s) for ${request.kind} ${request.eventId}`
      )
    return handled(reminded)
  } catch (error) {
    return {
      outcome: { status: 'failed', error: String(error) },
      report: null
    }
  }
}

/**
 * Does an entry's work and settles it: acknowledged and deleted once done,
 * waiting for its next try after a failure, or given up on, on the dead
 * stream, after the last try or when it cannot be read at all. Answers what
 * the work sent.
 */
export async function settleEntry(
  queue: PushQueue,
  entry: QueueEntry,
  deps: SenderDeps
): Promise<PushReport | null> {
  if ('malformed' in entry.read) {
    deps.log(`push sender: gave up on ${entry.id}: ${entry.read.malformed}`)
    await queue.dead(entry.id, entry.raw, entry.read.malformed, deps.clock())
    return null
  }
  const { request } = entry.read
  // A chat request that waited in the queue past `STALE_WAKE_MS` (the
  // sender was down, or crash-looping) is let go, not sent late.
  const queuedAt = Number(entry.id.split('-')[0])
  if (
    request.t === 'chat' &&
    deps.clock().getTime() - queuedAt > STALE_WAKE_MS
  ) {
    deps.log(
      `push sender: let go of ${entry.id}, queued ${new Date(queuedAt).toISOString()}: too old to wake anybody`
    )
    await queue.done(entry.id)
    return null
  }
  // A new post waits out its hold in the waiting set, put back on the
  // stream when it ends; its tries after that are not held again.
  if (request.t === 'chat' && deps.chatHoldMs > 0) {
    const due = request.due ?? queuedAt + deps.chatHoldMs
    if (deps.clock().getTime() < due) {
      await queue.retry(entry.id, { ...request, due }, due)
      return null
    }
  }
  const { outcome, report } = await handleRequest(request, deps, queue)
  if (outcome.status === 'done') {
    await queue.done(entry.id)
    return report
  }
  const next = afterFailure(request, outcome, deps.clock().getTime())
  const what = `${request.t} request ${entry.id} (attempt ${request.attempt})`
  if ('dead' in next) {
    deps.log(`push sender: gave up on ${what}: ${next.dead}`)
    await queue.dead(entry.id, entry.raw, next.dead, deps.clock())
    return report
  }
  deps.log(
    `push sender: ${what} failed, trying again at ${new Date(next.at).toISOString()}: ${outcome.error}`
  )
  await queue.retry(entry.id, next.retry, next.at)
  return report
}

export interface RunPushSenderOptions {
  queue: PushQueue
  deps: SenderDeps
  /** This sender's name in the consumer group: its host and process. */
  consumer?: string
  /** When set, used instead of wiring process signals (tests). */
  signals?: NodeJS.EventEmitter
  /** Called once the loop has ended, to close what it ran on. */
  onStopped?: () => Promise<void>
  /** Ends a read under way at once, on a stop (closes its connection). */
  interrupt?: () => void
  readBlockMs?: number
  reclaimEveryMs?: number
  reclaimIdleMs?: number
  /** How often the entries in hand are claimed afresh: a third of `reclaimIdleMs`. */
  renewEveryMs?: number
  /** How often the queue is looked at with entries in hand (`IN_HAND_POLL_MS`). */
  pollMs?: number
  /** How long to wait after `failures` failed turns in a row (`pauseAfter`). */
  pauseAfter?: (failures: number) => number
}

export interface PushSenderHandle {
  stop: (signal?: NodeJS.Signals) => Promise<void>
}

/**
 * Drains the push queue until stopped: lets go, once it has its group, of
 * the consumers dead senders left behind holding nothing; puts back each
 * request due to be tried again; takes over every 30 s the entries a dead
 * sender left in hand for over 60 s; and reads up to 16 entries at a time,
 * doing each one's work at once and settling it as it finishes, up to 32 in
 * hand, which it claims afresh every 20 s. With nothing in hand a read
 * waits up to 5 s, but no later than the next request waiting is due; with
 * entries in hand it only looks, again as each one settles or every 250 ms,
 * so the requests come due, new ones and takeovers are not kept waiting for
 * the slowest in hand. Valkey or the
 * database away is a pause and another try, never the end of the loop: the
 * pauses lengthen to 30 s while it lasts, and it is said once a minute.
 *
 * On SIGTERM it reads no more, gives the entries in hand 5 s, and stops; any
 * still unsettled stay pending and are taken over later.
 */
export function runPushSender(options: RunPushSenderOptions): PushSenderHandle {
  const { queue, deps } = options
  const consumer = options.consumer ?? `${hostname()}:${process.pid}`
  const readBlockMs = options.readBlockMs ?? READ_BLOCK_MS
  const reclaimEveryMs = options.reclaimEveryMs ?? RECLAIM_EVERY_MS
  const reclaimIdleMs = options.reclaimIdleMs ?? RECLAIM_IDLE_MS
  const renewEveryMs = options.renewEveryMs ?? reclaimIdleMs / 3
  const pauseFor = options.pauseAfter ?? pauseAfter
  const pollMs = options.pollMs ?? IN_HAND_POLL_MS
  let stopping = false
  const waiting: { wake?: () => void; nudge?: () => void } = {}
  let lastReclaim = 0
  let grouped = false
  /** The entries in hand, each settling. */
  const inHand = new Map<string, Promise<void>>()
  /** An entry settled since the last wait for one began. */
  let nudged = false

  /**
   * Waits `ms`, or until a stop; with `nudgeable`, also until an entry in
   * hand settles, at once if one has since the last such wait.
   */
  const pause = async (ms: number, nudgeable = false): Promise<void> => {
    if (nudgeable && nudged) {
      nudged = false
      return
    }
    await new Promise<void>(resolve => {
      const timer = setTimeout(resolve, ms)
      waiting.wake = () => {
        clearTimeout(timer)
        resolve()
      }
      if (nudgeable) waiting.nudge = waiting.wake
    })
    waiting.wake = undefined
    waiting.nudge = undefined
    if (nudgeable) nudged = false
  }

  /** Starts each entry's work, which settles it as it finishes. */
  const take = (entries: QueueEntry[]): void => {
    for (const entry of entries) {
      if (inHand.has(entry.id)) continue
      inHand.set(
        entry.id,
        settleEntry(queue, entry, deps)
          .then(
            () => undefined,
            (error: unknown) => {
              // Left pending: taken over once it has sat long enough.
              deps.log(
                `push sender: settling ${entry.id} failed: ${String(error)}`
              )
            }
          )
          .finally(() => {
            inHand.delete(entry.id)
            nudged = true
            waiting.nudge?.()
          })
      )
    }
  }

  // Claimed afresh while in hand, so no other sender takes over, and does
  // again, work this one is still doing.
  const renewing = setInterval(() => {
    if (inHand.size === 0) return
    queue.renew(consumer, [...inHand.keys()]).catch((error: unknown) => {
      deps.log(
        `push sender: renewing ${inHand.size} claim(s) failed: ${String(error)}`
      )
    })
  }, renewEveryMs)

  const turn = async (): Promise<void> => {
    if (!grouped) {
      await queue.ensureGroup()
      grouped = true
      const gone = await queue.dropIdleConsumers(consumer, reclaimIdleMs)
      if (gone.length > 0)
        deps.log(`push sender: let go of idle consumer(s) ${gone.join(', ')}`)
    }
    const now = deps.clock().getTime()
    await queue.promote(now)
    const room = (): number => MAX_IN_HAND - inHand.size
    if (now - lastReclaim >= reclaimEveryMs && room() > 0) {
      lastReclaim = now
      const taken = await queue.reclaim(
        consumer,
        reclaimIdleMs,
        Math.min(READ_COUNT, room())
      )
      if (taken.length > 0) {
        deps.log(`push sender: took over ${taken.length} request(s)`)
        take(taken)
      }
    }
    if (stopping) return
    // Back in time to put back the next request due, rather than up to a
    // whole wait after it.
    const due = await queue.nextDue()
    const untilDue =
      due == null
        ? readBlockMs
        : Math.max(1, Math.min(readBlockMs, due - deps.clock().getTime()))
    if (inHand.size === 0) {
      const entries = await queue.read(consumer, READ_COUNT, untilDue)
      // Read after a stop began: left pending for whoever comes next.
      if (stopping) return
      take(entries)
      return
    }
    // The entries in hand settle through this connection, which a waiting
    // read would hold: look, and wait for one to settle, or a moment.
    const count = Math.min(READ_COUNT, room())
    if (count > 0) {
      const entries = await queue.read(consumer, count, null)
      if (stopping) return
      take(entries)
      // A full read: there may be more waiting.
      if (entries.length === count && room() > 0) return
    }
    await pause(Math.min(pollMs, untilDue), true)
  }

  let closing: Promise<void> | null = null
  const close = async (): Promise<void> => {
    closing ??= (options.onStopped ?? (async () => undefined))()
    await closing
  }

  /** Turns failed in a row, and when that was last said. */
  let failures = 0
  let saidAt = 0
  const loop = (async () => {
    // eslint-disable-next-line no-unmodified-loop-condition -- stop() sets it while a turn is awaited
    while (!stopping) {
      try {
        await turn()
        if (failures > 1)
          deps.log(`push sender: going again after ${failures} failed turns`)
        failures = 0
      } catch (error) {
        if (stopping) break
        failures++
        const at = Date.now()
        if (failures === 1 || at - saidAt >= SAY_FAILING_EVERY_MS) {
          saidAt = at
          deps.log(
            failures === 1
              ? `push sender: ${String(error)}`
              : `push sender: ${String(error)} (${failures} failed turns in a row)`
          )
        }
        // Valkey lost the stream, flushed or restarted with nothing saved:
        // the group is made again with it.
        if (String(error).includes('NOGROUP')) grouped = false
        await pause(pauseFor(failures))
      }
    }
    await Promise.all(inHand.values())
    clearInterval(renewing)
  })()

  let stopped: Promise<void> | null = null
  const stop = async (signal: NodeJS.Signals = 'SIGTERM'): Promise<void> => {
    stopped ??= (async () => {
      stopping = true
      waiting.wake?.()
      // A read under way is cut short; the entries in hand get the grace,
      // and past it are left pending.
      if (inHand.size === 0) options.interrupt?.()
      let timer: ReturnType<typeof setTimeout> | undefined
      const ended = await Promise.race([
        loop.then(() => true),
        new Promise<boolean>(resolve => {
          timer = setTimeout(() => {
            resolve(false)
          }, STOP_GRACE_MS)
        })
      ])
      clearTimeout(timer)
      clearInterval(renewing)
      if (!ended) {
        deps.log('push sender: left the requests in hand to be taken over')
        options.interrupt?.()
      }
      await close()
      deps.log(`push sender: stopped on ${signal}`)
    })()
    await stopped
  }

  const bus = options.signals ?? process
  const onSignal = (signal: NodeJS.Signals) => (): void => {
    stop(signal)
      .then(() => {
        /* c8 ignore next */
        if (options.signals == null) process.exit(0)
      })
      .catch(async (error: unknown) => {
        deps.log(`push sender: stop failed: ${String(error)}`)
        await reportFailure(error)
        /* c8 ignore next */
        if (options.signals == null) process.exit(1)
      })
  }
  const onTerm = onSignal('SIGTERM')
  const onInt = onSignal('SIGINT')
  bus.on('SIGTERM', onTerm)
  bus.on('SIGINT', onInt)

  return {
    stop: async signal => {
      bus.off('SIGTERM', onTerm)
      bus.off('SIGINT', onInt)
      await stop(signal)
    }
  }
}

/** Reports a failure to Sentry and waits, briefly, for it to leave. */
export async function reportFailure(error: unknown): Promise<void> {
  captureException(error)
  await flush(2000)
}

/**
 * The push sender as the server forks it, or as a service of its own: the
 * one process that builds the push transports, so the APNs, FCM and VAPID
 * keys are read nowhere else.
 */
export async function runMain(
  config: Pick<
    ServerConfig,
    'databaseUrl' | 'databasePoolUrl' | 'redis' | 'push'
  > = serverConfig,
  onStopped?: () => Promise<void>
): Promise<PushSenderHandle> {
  const log = (line: string): void => {
    console.error(line)
  }
  const settings = pushSettings(config)
  const db = makeDatabase(requestDatabaseUrl(config), { role: 'pushSender' })
  const client = pushQueueClient(config, COMMAND_TIMEOUT_MS, log)
  // Waited for a moment, so the first read finds it there; past that the
  // loop pauses and asks again until Valkey is there.
  await Promise.race([
    client.connect().catch(() => undefined),
    new Promise(resolve => setTimeout(resolve, CONNECT_WAIT_MS).unref())
  ])
  const queue = new PushQueue(
    client,
    scoreboardPrefix(config.redis.prefix, config.databaseUrl)
  )
  const transports = pushTransports(settings, {}, log)
  console.log('push sender: started')
  return runPushSender({
    queue,
    deps: {
      db,
      transports,
      iosFiltering: settings.iosFiltering,
      chatHoldMs: settings.chatHoldSeconds * 1000,
      clock: () => new Date(),
      log
    },
    interrupt: () => {
      if (client.isOpen) client.destroy()
    },
    onStopped: async () => {
      if (client.isOpen) client.destroy()
      await db.destroy()
      await onStopped?.()
    }
  })
}
