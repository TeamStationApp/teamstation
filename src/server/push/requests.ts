import {
  asArray,
  asEither,
  asNumber,
  asObject,
  asOptional,
  asString,
  type Cleaner
} from 'cleaners'

import { asLiteral } from '../../common/asLiteral'

/**
 * What the API asks the push sender to send, as one entry of the push queue
 * (`queue.ts`). It names what to send and never what it says: the sender reads
 * the message or the event, and works out who hears of it, when it runs.
 */

/** How many times a request is tried before it is given up on. */
export const MAX_ATTEMPTS = 5

/** How long a request waits before its next try, after each failed one. */
export const RETRY_DELAYS_MS = [5_000, 30_000, 120_000, 600_000] as const

/** A new post in a conversation, to wake its members' devices. */
const asChatRequest = asObject({
  v: asLiteral(1),
  t: asLiteral('chat'),
  c: asString,
  seq: asNumber,
  /** Who posted it: a message that is not theirs at `seq` wakes nobody. */
  sender: asString,
  attempt: asNumber,
  /**
   * On a later try, the only members still to wake: those a failure alone
   * kept the last try from.
   */
  to: asOptional(asArray(asString)),
  /**
   * When the hold after the post ends, in ms since the epoch, once the
   * sender has set it (`sender/main.ts`): it is not sent before then, so a
   * member who reads it in the app meanwhile is not woken for it.
   */
  due: asOptional(asNumber)
})
export type ChatPushRequest = ReturnType<typeof asChatRequest>

/** An event start within the reminder window, to remind who said yes. */
const asReminderRequest = asObject({
  v: asLiteral(1),
  t: asLiteral('reminder'),
  kind: asLiteral('game', 'teamEvent'),
  eventId: asString,
  /** The start it is for: a moved event is a different request. */
  startAt: asString,
  attempt: asNumber
})
export type ReminderPushRequest = ReturnType<typeof asReminderRequest>

/**
 * A person's read cursor moved in a conversation whose wake reached them:
 * their other devices take down its notifications.
 */
const asReadRequest = asObject({
  v: asLiteral(1),
  t: asLiteral('read'),
  /** Who read. */
  u: asString,
  c: asString,
  /** Where their cursor moved to. */
  seq: asNumber,
  /** The session that read, whose own device has cleared already. */
  session: asOptional(asString),
  attempt: asNumber,
  /**
   * On a later try, the only registrations still to clear: those whose send
   * failed on the last.
   */
  devices: asOptional(asArray(asString))
})
export type ReadPushRequest = ReturnType<typeof asReadRequest>

export type PushRequest =
  ChatPushRequest | ReminderPushRequest | ReadPushRequest

/** A request as it is queued; `v` and `attempt` are filled in. */
export type NewPushRequest =
  | Omit<ChatPushRequest, 'v' | 'attempt' | 'to' | 'due'>
  | Omit<ReminderPushRequest, 'v' | 'attempt'>
  | Omit<ReadPushRequest, 'v' | 'attempt' | 'devices'>

export const asPushRequest: Cleaner<PushRequest> = asEither(
  asChatRequest,
  asReminderRequest,
  asReadRequest
)

/** A request's first try. */
export function firstTry(request: NewPushRequest): PushRequest {
  return request.t === 'chat'
    ? { ...request, v: 1, attempt: 1, to: undefined, due: undefined }
    : request.t === 'read'
      ? { ...request, v: 1, attempt: 1, devices: undefined }
      : { ...request, v: 1, attempt: 1 }
}

/**
 * A queue entry's request, or why it is not one: anything the sender cannot
 * read is given up on at once, rather than tried again.
 */
export function requestOf(
  raw: string | undefined
): { request: PushRequest } | { malformed: string } {
  if (raw == null) return { malformed: 'the entry has no request' }
  try {
    const request = asPushRequest(JSON.parse(raw))
    if (!Number.isInteger(request.attempt) || request.attempt < 1)
      return { malformed: `attempt ${request.attempt} is not a try` }
    return { request }
  } catch (error) {
    return { malformed: `the request cannot be read: ${String(error)}` }
  }
}

/** What became of one try, as the sender settles its entry. */
export type PushOutcome =
  | { status: 'done' }
  /**
   * It failed, wholly or for some of the people it was for. `unreached`
   * narrows a chat request's next try to those people, and `devices` a
   * read's to those registrations.
   */
  | {
      status: 'failed'
      error: string
      unreached?: string[]
      devices?: string[]
    }

/**
 * What to do with a failed try: try again after the next delay, with the
 * attempt counted, or, after `MAX_ATTEMPTS`, give it up.
 */
export function afterFailure(
  request: PushRequest,
  outcome: { error: string; unreached?: string[]; devices?: string[] },
  now: number
): { retry: PushRequest; at: number } | { dead: string } {
  if (request.attempt >= MAX_ATTEMPTS)
    return {
      dead: `gave up after ${request.attempt} attempts: ${outcome.error}`
    }
  const delay =
    RETRY_DELAYS_MS[Math.min(request.attempt, RETRY_DELAYS_MS.length) - 1]
  const attempt = request.attempt + 1
  const retry: PushRequest =
    request.t === 'chat' && outcome.unreached != null
      ? { ...request, attempt, to: outcome.unreached }
      : request.t === 'read' && outcome.devices != null
        ? { ...request, attempt, devices: outcome.devices }
        : { ...request, attempt }
  return { retry, at: now + delay }
}

/** How long the sender waits after its first turn in a row to fail. */
export const FIRST_PAUSE_MS = 1_000

/** How long the sender waits between failed turns, at most. */
export const LONGEST_PAUSE_MS = 30_000

/**
 * How long the sender waits after `failures` turns in a row have failed
 * (Valkey or the database away): a second, doubled each time, up to
 * `LONGEST_PAUSE_MS`, so an outage is asked about less and less often.
 */
export function pauseAfter(failures: number): number {
  return Math.min(
    LONGEST_PAUSE_MS,
    FIRST_PAUSE_MS * 2 ** Math.max(0, Math.min(failures, 16) - 1)
  )
}
