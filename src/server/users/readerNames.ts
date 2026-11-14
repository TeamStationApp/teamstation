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
 * The people of `userIds` this reader reads in full: `mayViewFullNames` (whoever
 * may change the name, and whoever manages the people of a level whose people
 * list holds them), and nobody when the read goes to a model (`isSpoken`) or
 * there is no reader. One `mayViewFullNames` call for the whole list, or none
 * when the caller has asked already: `known` is then whom of them it found the
 * reader may read in full (its own `mayViewFullName`), taken as the answer.
 * Reading in full never grants changing: that stays `mayEditNames`.
 */
export async function fullNamesFor(
  db: Kysely<Database>,
  reader: Reader | undefined,
  userIds: Iterable<string>,
  options: { known?: Iterable<string> } = {}
): Promise<Set<string>> {
  const wanted = [...new Set(userIds)]
  if (reader == null || isSpoken() || wanted.length === 0) return new Set()
  if (options.known != null) {
    const known = new Set(options.known)
    return new Set(wanted.filter(id => known.has(id)))
  }
  // Name formats are read by migrations, which must not load the server that
  // `access.ts` brings with it: only a read for a reader loads it.
  const { mayViewFullNames } = await import('../access')
  return await mayViewFullNames(db, reader.userId, wanted, {
    isAdmin: reader.isAdmin
  })
}

/**
 * Which of these readers read `userId` in full: `fullNamesFor` of that one
 * person for each reader, in a fixed number of queries however many readers
 * there are (`mayViewFullNameOf`), and none when the read goes to a model.
 */
export async function readersInFull(
  db: Kysely<Database>,
  readers: readonly Reader[],
  userId: string
): Promise<Set<string>> {
  if (isSpoken() || readers.length === 0) return new Set()
  const { mayViewFullNameOf } = await import('../access')
  return await mayViewFullNameOf(db, userId, readers)
}
