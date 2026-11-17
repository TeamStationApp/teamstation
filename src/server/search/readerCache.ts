import type { Kysely } from 'kysely'

import {
  type FullNameGrants,
  fullNameGrants,
  guardedRows,
  type VisibleScopes,
  visibleScopes
} from '../access'
import type { Actor } from '../auth/sessions'
import type { Database } from '../db/database'
import { type SearchReach, searchReach } from './reach'

/**
 * What a search reads about its reader alone, whatever was typed, kept for
 * one search socket so that a reader typing a word reads it once and not
 * once a keystroke: their reach (`searchReach`, by `forTeam` and the game's
 * season), the rows they guard (`guardedRows`), what they may see
 * (`visibleScopes`), what `mayViewFullNames` reads about them
 * (`fullNameGrants`). The groups they follow are not kept: a Follow or
 * Unfollow goes over REST, and the next search must show it, so each search
 * reads them (one indexed read).
 *
 * Each read is kept at most `READER_CACHE_MS` from when it was started, so a
 * membership or role given or taken away is seen by the next search after
 * that. Every read is kept for one reader: asked for another (or the same
 * person with another admin standing), the cache empties first. A read that
 * fails is not kept.
 */
export const READER_CACHE_MS = 15_000

export interface ReaderCacheOptions {
  /** `READER_CACHE_MS` by default. */
  ttlMs?: number
  /** The clock, in milliseconds; `Date.now` by default. */
  now?: () => number
}

/** One reader's reads, as a search asks for them. */
export interface ReaderReads {
  reach: (forTeam?: string, forSeason?: string | null) => Promise<SearchReach>
  guarded: () => Promise<string[]>
  scopes: () => Promise<VisibleScopes>
  grants: () => Promise<FullNameGrants>
}

export interface ReaderCache {
  /** The reads of this reader, kept or read now. */
  of: (db: Kysely<Database>, actor: Actor) => ReaderReads
  /** Forgets every read. */
  clear: () => void
  /** How many reads it has made, rather than answered from what it kept. */
  reads: () => number
}

interface Entry {
  at: number
  value: Promise<unknown>
}

export function readerCache(options: ReaderCacheOptions = {}): ReaderCache {
  const ttlMs = options.ttlMs ?? READER_CACHE_MS
  const now = options.now ?? Date.now
  const entries = new Map<string, Entry>()
  let owner: string | undefined
  let reads = 0

  const kept = async <T>(key: string, read: () => Promise<T>): Promise<T> => {
    const at = now()
    const entry = entries.get(key)
    if (entry != null && at - entry.at < ttlMs)
      return await (entry.value as Promise<T>)
    reads++
    const value = read()
    entries.set(key, { at, value })
    value.catch(() => {
      if (entries.get(key)?.value === value) entries.delete(key)
    })
    return await value
  }

  return {
    of: (db, actor) => {
      const who = `${actor.userId} ${actor.isAdmin ? 'admin' : 'user'}`
      if (owner !== who) {
        entries.clear()
        owner = who
      }
      return {
        reach: async (forTeam, forSeason) =>
          await kept(
            `reach ${forTeam ?? ''} ${forSeason ?? ''}`,
            async () => await searchReach(db, actor, forTeam, forSeason)
          ),
        guarded: async () =>
          await kept(
            'guarded',
            async () => await guardedRows(db, actor.userId)
          ),
        scopes: async () =>
          await kept(
            'scopes',
            async () => await visibleScopes(db, actor.userId, actor.isAdmin)
          ),
        grants: async () =>
          await kept(
            'grants',
            async () => await fullNameGrants(db, actor.userId)
          )
      }
    },
    clear: () => {
      entries.clear()
      owner = undefined
    },
    reads: () => reads
  }
}

/**
 * Starts every read a search of this reader makes, so that a socket opened
 * before the first keystroke has them by then. A read that fails is not
 * kept, and the search that needs it reads it again.
 */
export function warmReader(reads: ReaderReads): void {
  for (const read of [
    reads.reach(),
    reads.guarded(),
    reads.scopes(),
    reads.grants()
  ])
    read.catch(() => undefined)
}
