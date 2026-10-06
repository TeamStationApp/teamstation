import { equalBytes, utf8 } from './bytes'
import { call } from './core'
import { num } from './coreCall'

/**
 * The hash chain over a conversation's membership log.
 *
 * Each `chat_membership_log` row's `hash` is
 * `SHA-256(prev_hash ‖ lp(conversationId) ‖ u64(seq) ‖ lp(event) ‖
 * u64(userId) ‖ u64(actorUserId or 0) ‖ lp(reason) ‖ u64(at in ms))`, and the
 * first row's `prev_hash` is 32 zero bytes. A row with no reason hashes
 * `lp("")`. The server writes it and every client checks it from the first
 * row, so a rewritten, dropped or reordered row shows. The chat crypto core
 * computes it.
 */

export type LogEvent = 'join' | 'leave' | 'identityReset' | 'closed'

export interface LogRow {
  conversationId: string
  seq: number
  event: LogEvent
  userId: number
  actorUserId: number | null
  reason: string | null
  /** When it happened, as a date or milliseconds since the epoch. */
  at: Date | number
}

/** The first row's `prev_hash`. */
export const GENESIS_HASH: Uint8Array = new Uint8Array(32)

export function logRowHash(prevHash: Uint8Array, row: LogRow): Uint8Array {
  if (prevHash.length !== 32) throw new TypeError('prev_hash is not 32 bytes')
  const at = typeof row.at === 'number' ? row.at : row.at.getTime()
  return call('logRowHash', [
    prevHash,
    utf8(row.conversationId),
    num(row.seq),
    utf8(row.event),
    num(row.userId),
    num(row.actorUserId ?? 0),
    utf8(row.reason ?? ''),
    num(at)
  ])[0]
}

/**
 * Checks rows that follow `prevHash` (the genesis hash, or the last one
 * already verified), each with the `prevHash` and `hash` it was stored with.
 * Answers how many verify before the first that does not, so all of them is
 * an unbroken chain.
 */
export function verifiedPrefix(
  prevHash: Uint8Array,
  rows: Array<LogRow & { prevHash: Uint8Array; hash: Uint8Array }>
): number {
  let previous = prevHash
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i]
    if (!equalBytes(row.prevHash, previous)) return i
    const hash = logRowHash(previous, row)
    if (!equalBytes(hash, row.hash)) return i
    previous = hash
  }
  return rows.length
}
