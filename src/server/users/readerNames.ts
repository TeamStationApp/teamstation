import { AsyncLocalStorage } from 'node:async_hooks'

import type { Kysely } from 'kysely'

import { type Actor, isMachine } from '../auth/sessions'
import type { Database } from '../db/database'

/**
 * Whether this request's names go to a model. Tess reaches the API the way the
 * app does, and what it answers her, a change she made included, is put in
 * front of an LLM, so a public format that shows a surname must not reach her.
 * This is held for the request, so every name it formats is clamped in one
 * place (`teamFormats`).
 */
const spoken = new AsyncLocalStorage<boolean>()

/** Runs `read` as a read whose names go to a model. */
export function runSpoken<T>(read: () => T): T {
  return spoken.run(true, read)
}

/**
 * Runs `write` for the public: what a request stores or sends to somebody
 * else, the live board and mail, whoever made the request.
 */
export function outsideSpoken<T>(write: () => T): T {
  return spoken.exit(write)
}

export function isSpoken(): boolean {
  return spoken.getStore() === true
}

/** Whoever a response names people to. */
export interface Reader {
  userId: string
  isAdmin: boolean
}

/**
 * The reader a request names people to: the person signed in, or nobody for
 * no actor or a machine (`isMachine`), so a service account's token never
 * reads a full name. A user's API key reads what its person reads.
 */
export function readerOf(actor: Actor | undefined): Reader | undefined {
  if (actor == null || isMachine(actor)) return undefined
  return { userId: actor.userId, isAdmin: actor.isAdmin }
}

/**
 * The people of `userIds` this reader reads in full: `mayEditNames`, and
 * nobody when the read goes to a model (`isSpoken`) or there is no reader.
 * One `mayEditNames` call for the whole list.
 */
export async function fullNamesFor(
  db: Kysely<Database>,
  reader: Reader | undefined,
  userIds: Iterable<string>
): Promise<Set<string>> {
  const wanted = [...new Set(userIds)]
  if (reader == null || isSpoken() || wanted.length === 0) return new Set()
  // Name formats are read by migrations, which must not load the server that
  // `access.ts` brings with it: only a read for a reader loads it.
  const { mayEditNames } = await import('../access')
  return await mayEditNames(db, reader.userId, wanted, {
    isAdmin: reader.isAdmin
  })
}
