import { createHash } from 'node:crypto'

import type { Request } from 'express'
import type { Kysely, Transaction } from 'kysely'

import { IDEMPOTENCY_HEADER } from '../../common/api'
import { type ApiError, badRequest, HttpError } from '../../common/errors'
import type { Database } from './database'

/**
 * `Idempotency-Key` on the three writes a phone queues while it has no
 * signal: a roster player made, a lineup saved, a live play posted.
 *
 * A request that sends none is written as it always was. One that sends a
 * key stores what it was answered, by person and key: the key is claimed in
 * the write's own transaction, so a write that rolled back holds no key, and
 * one that committed always does. The same request sent again is answered
 * from there and writes nothing. The same key on another request is 409
 * `idempotencyKeyReused`.
 *
 * Keys expire (`KEY_RETENTION_DAYS`), on the server's sweep only: a keyed
 * request on the hot path deletes nothing.
 */

/**
 * How long a key is kept: longer than a phone plausibly holds a queued
 * write. A write whose first send landed and whose answer was lost waits on
 * the phone until it is sent again. A 401 keeps the phone's file and its
 * queue, which drains when the same person signs in again, and that can be
 * after their 30-day session ran out, in the gap between two parts of a
 * season. Ninety days covers a season's breaks. The cost is small: a live
 * post's key keeps a status and two digests, a roster create's one entry, a
 * lineup save's two lineups. A write first sent more than ninety days
 * before it is sent again is taken as new: a second player or play. That
 * window is accepted.
 */
export const KEY_RETENTION_DAYS = 90
const RETENTION_MS = KEY_RETENTION_DAYS * 24 * 60 * 60 * 1000

/**
 * Deletes every key claimed longer ago than `KEY_RETENTION_DAYS`, as the
 * server's sweep does. Answers how many went.
 */
export async function purgeExpiredKeys(
  db: Kysely<Database>,
  now: Date = new Date()
): Promise<number> {
  const result = await db
    .deleteFrom('sync_idempotency')
    .where('created_at', '<', new Date(now.getTime() - RETENTION_MS))
    .executeTakeFirst()
  return Number(result.numDeletedRows)
}

/** Longer than any key a client makes, and short enough to index. */
const MAX_KEY_LENGTH = 200

/** One request that named a key. */
export interface IdempotentCall {
  userId: string
  key: string
  method: string
  path: string
  /** Of the method, the path and the body, as sent. */
  hash: string
}

/** An answer: what the route sends. */
export interface Answer {
  status: number
  body: unknown
}

/** What a claimed key holds. */
export interface HeldKey {
  /** What the write made, stored in its transaction. */
  resultId: string | null
  /** The answer, once it was read; null in between. */
  answer: Answer | null
}

/**
 * The key `req` names for `userId`, or none when it names none. A key that
 * is empty, too long, or not visible ASCII is 400.
 */
export function idempotentCallOf(
  req: Request,
  userId: string
): IdempotentCall | undefined {
  const sent = req.get(IDEMPOTENCY_HEADER)
  if (sent == null) return undefined
  const key = sent.trim()
  if (key === '' || key.length > MAX_KEY_LENGTH || !/^[\x21-\x7e]+$/.test(key))
    throw badRequest(
      `Idempotency-Key must be 1 to ${MAX_KEY_LENGTH} visible ASCII characters`
    )
  const path = `${req.baseUrl}${req.path}`
  const hash = createHash('sha256')
    .update(JSON.stringify([req.method, path, req.body ?? null]))
    .digest('hex')
  return { userId, key, method: req.method, path, hash }
}

/**
 * The code a key sent with another request is answered, apart from every
 * refusal of the change itself: a client that sees it has a key to fix, not
 * a write the server turned down.
 */
export const KEY_REUSED_CODE = 'idempotencyKeyReused'

/** 409, as `{ code: 'idempotencyKeyReused', message }`. */
class KeyReused extends HttpError {
  constructor() {
    super(
      'conflict',
      'This Idempotency-Key was already sent with another request'
    )
  }

  override toApiError(): ApiError {
    const body: Record<string, unknown> = {
      code: KEY_REUSED_CODE,
      message: this.message
    }
    return body as unknown as ApiError
  }
}

/**
 * What `call`'s key holds, or nothing when it is unclaimed. A key claimed by
 * a different request is 409 `idempotencyKeyReused`.
 */
export async function heldKey(
  db: Kysely<Database>,
  call: IdempotentCall
): Promise<HeldKey | undefined> {
  const row = await db
    .selectFrom('sync_idempotency')
    .select(['request_hash', 'status', 'body', 'result_id'])
    .where('user_id', '=', call.userId)
    .where('key', '=', call.key)
    .executeTakeFirst()
  if (row == null) return undefined
  if (row.request_hash !== call.hash) throw new KeyReused()
  return {
    resultId: row.result_id,
    answer:
      row.status == null || row.body == null
        ? null
        : { status: row.status, body: row.body }
  }
}

/** What a write stores as it claims its key. */
export interface Claim {
  resultId?: string
  answer?: Answer
  /** The answer's status, for a write whose body is not kept. */
  status?: number
}

/** Claims the key, in the transaction `trx` of the write it answers. */
export type ClaimKey = (
  trx: Transaction<Database>,
  claim: Claim
) => Promise<void>

async function insertClaim(
  db: Kysely<Database>,
  call: IdempotentCall,
  claim: Claim
): Promise<void> {
  await db
    .insertInto('sync_idempotency')
    .values({
      user_id: call.userId,
      key: call.key,
      method: call.method,
      path: call.path,
      request_hash: call.hash,
      status: claim.answer?.status ?? claim.status ?? null,
      body:
        claim.answer == null ? null : JSON.stringify(claim.answer.body ?? null),
      result_id: claim.resultId ?? null
    })
    .execute()
}

/** Stores the answer on a key claimed without one. */
async function saveAnswer(
  db: Kysely<Database>,
  call: IdempotentCall,
  answer: Answer
): Promise<void> {
  await db
    .updateTable('sync_idempotency')
    .set({
      status: answer.status,
      body: JSON.stringify(answer.body ?? null)
    })
    .where('user_id', '=', call.userId)
    .where('key', '=', call.key)
    .where('body', 'is', null)
    .execute()
}

/** The key's primary key refusing a second claim, by a request racing this. */
function isClaimTaken(error: unknown): boolean {
  const { code, constraint } = error as { code?: unknown; constraint?: unknown }
  return code === '23505' && constraint === 'sync_idempotency_pkey'
}

export interface OnceSteps {
  /**
   * Writes, and answers. `claim` is set when the request named a key, and
   * the write calls it in its own transaction once it has written.
   */
  write: (claim: ClaimKey | undefined) => Promise<Answer>
  /**
   * The answer to a key whose write committed and whose answer was never
   * stored, because the process stopped in between: read again from what
   * the write made, without writing.
   */
  rebuild: (held: HeldKey) => Promise<Answer>
  /**
   * False for a write whose answer is not stored at all, because it is
   * large and grows (a live post answers every play of the game): its key
   * keeps only what `rebuild` needs, and each replay is rebuilt.
   */
  keepsAnswer?: boolean
}

/**
 * Answers `call` once: the write when its key is new, the stored answer when
 * it is not. With no key, the write runs as it always did.
 *
 * A write that claims with no answer has it stored after it is read. A
 * write that wrote nothing, and so claimed nothing, has the key claimed with
 * its answer afterwards. Two requests with the same key at once: the second
 * claim is refused as the first commits, its transaction rolls back, and it
 * is answered what the first stored.
 */
export async function answerOnce(
  db: Kysely<Database>,
  call: IdempotentCall | undefined,
  steps: OnceSteps
): Promise<Answer> {
  if (call == null) return await steps.write(undefined)
  const keeps = steps.keepsAnswer !== false
  const replay = async (held: HeldKey): Promise<Answer> => {
    if (held.answer != null) return held.answer
    const answer = await steps.rebuild(held)
    if (keeps) await saveAnswer(db, call, answer)
    return answer
  }
  const held = await heldKey(db, call)
  if (held != null) return await replay(held)

  let claimed: Claim | undefined
  let answer: Answer
  try {
    answer = await steps.write(async (trx, claim) => {
      await insertClaim(trx, call, claim)
      claimed = claim
    })
  } catch (error: unknown) {
    if (!isClaimTaken(error)) throw error
    const raced = await heldKey(db, call)
    if (raced == null) throw error
    return await replay(raced)
  }
  if (claimed == null) {
    try {
      await insertClaim(db, call, keeps ? { answer } : {})
    } catch (error: unknown) {
      if (!isClaimTaken(error)) throw error
      // Another request with this key committed first: answer as it did.
      const raced = await heldKey(db, call)
      if (raced != null) return await replay(raced)
    }
  } else if (keeps && claimed.answer == null) await saveAnswer(db, call, answer)
  return answer
}
