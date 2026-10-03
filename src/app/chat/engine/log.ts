import type { ChatLogRow } from '../../../common/api'
import {
  GENESIS_HASH,
  verifiedPrefix
} from '../../../common/chatCrypto/logHash'
import { b64, type ChatLogHead, unb64 } from '../keyRecord'
import type { EngineContext } from './context'

/**
 * The membership log, checked from its first row.
 *
 * Each chat's rows are fetched after the last one this device verified and
 * checked link by link (`chatCrypto/logHash.ts`); the last verified hash,
 * the members the verified rows leave (a `join` with no later `leave`) and
 * the identity resets they record are kept in the key record. If a row
 * fails, the chat is marked unverified for good on this device ("Membership
 * record could not be verified"): it stops granting keys and making epochs
 * there, while reading and posting under the current epoch go on.
 */

/** The longest page `GET …/log` answers. */
export const LOG_PAGE = 1000

/** Where a chat's log stands before any of it is read. */
export function genesisHead(): ChatLogHead {
  return {
    seq: 0,
    hash: b64(GENESIS_HASH),
    members: [],
    resets: [],
    broken: false
  }
}

/** The most identity resets a head remembers. */
const MAX_RESETS = 50

/**
 * `head` advanced over `rows` (the rows after it, in order): every row that
 * verifies, and `broken` at the first that does not.
 */
export function foldLog(
  conversationId: string,
  head: ChatLogHead,
  rows: ChatLogRow[]
): ChatLogHead {
  if (head.broken || rows.length === 0) return head
  const checked = rows.map(row => ({
    ...row,
    conversationId,
    prevHash: unb64(row.prevHash),
    hash: unb64(row.hash)
  }))
  const good = verifiedPrefix(unb64(head.hash), checked)
  const members = new Set(head.members)
  const resets = [...head.resets]
  for (const row of rows.slice(0, good)) {
    if (row.event === 'join') members.add(row.userId)
    if (row.event === 'leave') members.delete(row.userId)
    if (row.event === 'identityReset') {
      resets.push({ userId: row.userId, seq: row.seq, at: row.at })
    }
  }
  const last = good > 0 ? rows[good - 1] : undefined
  return {
    seq: last?.seq ?? head.seq,
    hash: last?.hash ?? head.hash,
    members: [...members].sort((a, b) => a - b),
    resets: resets.slice(-MAX_RESETS),
    broken: good < rows.length
  }
}

/** The chat's head as this device last verified it. */
export function headOf(
  ctx: EngineContext,
  conversationId: string
): ChatLogHead {
  return ctx.keys.record.logs[conversationId] ?? genesisHead()
}

/**
 * Reads and verifies the rows after the last verified one, and keeps the
 * new head. Answers it.
 */
export async function syncLog(
  ctx: EngineContext,
  conversationId: string
): Promise<ChatLogHead> {
  let head = headOf(ctx, conversationId)
  while (!head.broken) {
    const rows = await ctx.client.chatLog(conversationId, head.seq)
    const next = foldLog(conversationId, head, rows)
    if (next !== head) {
      await ctx.keys.update(record => ({
        ...record,
        logs: { ...record.logs, [conversationId]: next }
      }))
    }
    head = next
    if (rows.length < LOG_PAGE) break
  }
  return head
}
