import {
  asArray,
  asBoolean,
  asEither,
  asNull,
  asNumber,
  asObject,
  asString,
  asTuple
} from 'cleaners'
import { type Kysely, sql } from 'kysely'

import { asBats, asThrows, type RosterEntry } from '../../common/api'
import { asWalkUpSong, type WalkUpSong } from '../../common/walkUpSong'
import { onceAMinute, type ValkeyCache } from '../cache/valkeyCache'
import { anyOf } from '../db/anyOf'
import type { Database } from '../db/database'
import { teamWalkUpSongs } from '../routes/walkUpSongs'

/**
 * The `users` columns a team's core reads: those the member query selects and
 * the one it filters by. Migration 109's `users` trigger compares the same
 * columns, so a change to any of them moves the version of every team the
 * person is a member of, including one whose membership of the person is
 * still being written. The membership's trigger takes the person's `users`
 * row `for key share` and the update's trigger takes it `for update`, so
 * whichever comes second waits for the first to commit, and the update's
 * trigger, reading `memberships` only after that wait, sees the membership
 * and bumps its team. Being row locks, they take no lock table slot per
 * person.
 */
export const ROSTER_USER_COLUMNS = [
  'display_name',
  'first_name',
  'last_name',
  'bats',
  'throws',
  'avatar_path',
  'merged_into'
] as const

/** How long an entry lives with nobody writing the team's rows. */
const CORE_TTL_MS = 60 * 60 * 1000

/** The largest entry stored; a bigger team reads directly every time. */
export const CORE_MAX_BYTES = 512 * 1024

/** One member of a team as the core holds them, before any viewer. */
export interface CoreMember {
  userId: string
  displayName: string
  firstName: string | null
  lastName: string | null
  bats: RosterEntry['bats']
  throws: RosterEntry['throws']
  avatarPath: string | null
  jersey: string | null
  positions: string[]
  isPlayer: boolean
  role: string
}

/**
 * The part of a team's roster that depends on the team's own rows alone, the
 * same for every viewer: its members, in name order, their walk-up songs on
 * this team and their gumbo ids. Never a name format, a URL, a hold or
 * anything else a viewer, a request or the time decides.
 */
export interface RosterCore {
  members: CoreMember[]
  songs: Array<[string, WalkUpSong]>
  gumboIds: Array<[string, number]>
}

/**
 * The shape of a stored `RosterCore`, in every entry's key. A hit is checked
 * for its shape only, not for what it means, so bump this whenever
 * `RosterCore` or `CoreMember` changes, or what `readCore` selects or how it
 * orders: entries in the old shape are then never read, by this release or,
 * during a rolling deploy, by the one before, and lapse after `CORE_TTL_MS`.
 */
export const CORE_FORMAT = 1

/**
 * Where team rosters' cores are kept: Valkey, and a way for a read inside a
 * transaction that missed to have a team's entry stored from outside it
 * (`rosterCacheOn`).
 */
export interface RosterCache extends ValkeyCache {
  /**
   * Reads the team's core outside any transaction, as a read with no
   * transaction does, storing it if that read may. While one is running for
   * the team, answers that one instead of starting another; while Valkey is
   * not answering, reads nothing.
   */
  refresh?: (teamId: string) => Promise<void>
}

/**
 * `cache`, with `refresh` reading through it on `outside`, which is never a
 * transaction: one refresh per team at a time.
 *
 * A refresh that fails, its read of the rows or of the version among them,
 * still rejects, but no request waits for it, so it is also said through
 * `log` with the team and the error's message, once a minute at most. That
 * limit is the refreshes' own, apart from the cache's for its commands, so
 * neither kind of failure keeps the other out of the log.
 */
export function rosterCacheOn(
  cache: ValkeyCache,
  outside: Kysely<Database>,
  options: { log?: (message: string) => void; now?: () => number } = {}
): RosterCache {
  const running = new Map<string, Promise<void>>()
  const say = onceAMinute(options.log ?? (() => undefined), options.now)
  return {
    get: async key => await cache.get(key),
    set: async (key, value, ttlMs) => {
      await cache.set(key, value, ttlMs)
    },
    close: async () => {
      await cache.close()
    },
    report: problem => {
      cache.report?.(problem)
    },
    answering: () => cache.answering?.() ?? true,
    refresh: async teamId => {
      if (cache.answering?.() === false) return
      const ongoing = running.get(teamId)
      if (ongoing != null) {
        await ongoing
        return
      }
      const refreshing = teamRosterCore(outside, teamId, cache)
        .then(
          () => undefined,
          (error: unknown) => {
            say(
              `roster refresh of team ${teamId}: ${
                error instanceof Error ? error.message : String(error)
              }`
            )
            throw error
          }
        )
        .finally(() => {
          running.delete(teamId)
        })
      running.set(teamId, refreshing)
      await refreshing
    }
  }
}

const asCoreMember = asObject({
  userId: asString,
  displayName: asString,
  firstName: asEither(asString, asNull),
  lastName: asEither(asString, asNull),
  bats: asBats,
  throws: asThrows,
  avatarPath: asEither(asString, asNull),
  jersey: asEither(asString, asNull),
  positions: asArray(asString),
  isPlayer: asBoolean,
  role: asString
})

const asRosterCore = asObject({
  members: asArray(asCoreMember),
  songs: asArray(asTuple(asString, asWalkUpSong)),
  gumboIds: asArray(asTuple(asString, asNumber))
})

/** A stored entry as a core, or why it is not one. */
function heldCore(held: string): RosterCore | Error {
  try {
    return asRosterCore(JSON.parse(held))
  } catch (error) {
    return error instanceof Error ? error : new Error(String(error))
  }
}

/**
 * A team's core, through `cache` when one is given.
 *
 * Without one it reads the rows. A caller inside a write transaction passes
 * none, so no entry is ever built from rows that may not commit.
 *
 * With one, the database's epoch and the team's version, its newest
 * `team_roster_bumps` row, are read first, in one statement, then the entry
 * under both and `CORE_FORMAT`. A miss reads the rows and stores them for an
 * hour, unless they are over `CORE_MAX_BYTES`. An entry that does not parse
 * or is not in the core's shape is a miss too, said through `cache.report`
 * (once a minute at most), and the miss's store replaces it, or inside a
 * transaction the refresh the miss starts. Each statement runs on `db` by
 * itself, so no connection is held across a Valkey round trip; reading the
 * version before the rows is all the order needs. A write that commits
 * between the two reads has added a newer version than the key's, so an
 * entry may hold newer rows under an older version, but never older rows
 * under a newer one. A later reader outside a transaction reads the newer
 * version and never asks for that entry. A reader inside a snapshot taken
 * before the newer bump committed does ask for it, and gets a roster with
 * rows its snapshot does not hold: newer than the transaction's other reads,
 * never older. A team with no bump row (recreated, and with no membership
 * since) reads directly and stores nothing.
 *
 * Bumps are not taken in commit order: a writer that took a lower version can
 * commit after one that took a higher. So the same statement tries the team's
 * `rosterBumpKey`, which every bump holds shared until it commits. While one
 * is held, a miss reads the rows and stores nothing, since a lower version may
 * yet commit under the newest one read. A hit is always good: an entry is
 * stored only with no bump open, so every version up to its own had
 * committed.
 *
 * Inside a transaction (a read-only GET's snapshot) a bump that committed
 * after the snapshot began is neither seen nor held any longer, so the
 * snapshot's rows may be older than its version's, and are never stored. A
 * miss there answers its own request from the rows it read, and then, without
 * waiting, asks `cache.refresh` to read the team again outside any
 * transaction, the order above, and store that. A burst of misses on one team
 * starts one refresh. With no `refresh`, nothing is stored from a
 * transaction.
 */
export async function teamRosterCore(
  db: Kysely<Database>,
  teamId: string,
  cache?: RosterCache
): Promise<RosterCore> {
  if (cache == null) return await readCore(db, teamId)
  const key = rosterBumpKey(teamId)
  const { rows } = await sql<{
    epoch: string | null
    version: string | null
    settled: boolean
  }>`
    select
      (select epoch from roster_cache_epoch) as epoch,
      (select bumps.version::text from team_roster_bumps bumps
        where bumps.team_id = ${teamId}
        order by bumps.version desc limit 1) as version,
      case when pg_try_advisory_lock(hashtextextended(${key}, 0))
        then pg_advisory_unlock(hashtextextended(${key}, 0))
        else false end as settled
  `.execute(db)
  const { epoch, version, settled } = rows[0]
  if (epoch == null || version == null) return await readCore(db, teamId)
  const entry = `roster:${CORE_FORMAT}:${epoch}:${teamId}:${version}`
  const held = await cache.get(entry)
  if (held != null) {
    const hit = heldCore(held)
    if (!(hit instanceof Error)) return hit
    cache.report?.(
      new Error(`roster entry ${entry} is unreadable: ${hit.message}`)
    )
  }
  const core = await readCore(db, teamId)
  if (!settled) return core
  const json = JSON.stringify(core)
  if (Buffer.byteLength(json) > CORE_MAX_BYTES) return core
  if (!db.isTransaction) await cache.set(entry, json, CORE_TTL_MS)
  // Not awaited: the snapshot holds a connection, and this takes another.
  // A failure is said by `rosterCacheOn`, and never fails this read.
  else cache.refresh?.(teamId).catch(() => undefined)
  return core
}

/**
 * The advisory key `ts_bump_team_rosters` (migration 109) holds shared on
 * each team it bumps, until the bump commits.
 */
export function rosterBumpKey(teamId: string): string {
  return `rosterBump:${teamId}`
}

/** How old a bump must be before `pruneRosterBumps` may take it away. */
export const BUMP_KEEP_MS = 10 * 60 * 1000

/**
 * Deletes each bump row stamped (`bumped_at`, the clock when it was written)
 * more than `BUMP_KEEP_MS` ago that is not its team's newest, and answers how
 * many went.
 *
 * Readers read only a team's newest row, and a row goes only when this
 * statement sees a newer one, so pruning never changes a version any reader
 * reads; a snapshot that began before the delete keeps seeing the row it
 * read. No store depends on the older rows either: an entry is stored only by
 * a read outside a transaction, which reads the version before the rows and
 * finds the team's `rosterBumpKey` free, and a bump holds that key from
 * before it takes its version until it commits. A bump that commits late,
 * under a version lower than the newest, is therefore held while any read
 * could store an entry that misses it, and once it has committed every read
 * sees its rows, whether its own row is still there or not.
 */
export async function pruneRosterBumps(db: Kysely<Database>): Promise<number> {
  const { numAffectedRows } = await sql`
    delete from team_roster_bumps old
    where old.bumped_at < clock_timestamp()
        - make_interval(secs => ${BUMP_KEEP_MS / 1000})
      and exists (
        select from team_roster_bumps newer
        where newer.team_id = old.team_id and newer.version > old.version
      )
  `.execute(db)
  return Number(numAffectedRows ?? 0)
}

/** How often the background jobs prune old bump rows. */
export const BUMP_PRUNE_INTERVAL_MS = 5 * 60 * 1000

/**
 * Prunes old bump rows on the way up and then every `intervalMs`, as one of
 * the background jobs, so only one node does it. Answers what stops it.
 */
export function startRosterBumpPrune(
  db: Kysely<Database>,
  log: (message: string) => void,
  intervalMs = BUMP_PRUNE_INTERVAL_MS
): () => void {
  const prune = (): void => {
    pruneRosterBumps(db)
      .then(gone => {
        if (gone > 0) log(`pruned ${gone} roster version bump(s)`)
      })
      .catch((error: unknown) => {
        log(`pruning roster version bumps: ${String(error)}`)
      })
  }
  prune()
  const timer = setInterval(prune, intervalMs)
  ;(timer as { unref?: () => void }).unref?.()
  return () => {
    clearInterval(timer)
  }
}

/** The core, from the rows. */
async function readCore(
  db: Kysely<Database>,
  teamId: string
): Promise<RosterCore> {
  const rows = await db
    .selectFrom('memberships')
    .innerJoin('users', 'users.id', 'memberships.user_id')
    .select(ROSTER_USER_COLUMNS.map(column => `users.${column}` as const))
    .select([
      'memberships.user_id as userId',
      'memberships.jersey as jersey',
      'memberships.positions as positions',
      'memberships.is_player as isPlayer',
      'memberships.role as role'
    ])
    .where('memberships.team_id', '=', teamId)
    .where('users.merged_into', 'is', null)
    .orderBy('users.display_name')
    .execute()
  const members = rows.map((row): CoreMember => ({
    userId: row.userId,
    displayName: row.display_name,
    firstName: row.first_name,
    lastName: row.last_name,
    bats: row.bats,
    throws: row.throws,
    avatarPath: row.avatar_path,
    jersey: row.jersey,
    positions: row.positions,
    isPlayer: row.isPlayer,
    role: row.role
  }))
  const songs = await teamWalkUpSongs(db, teamId)
  return {
    members,
    songs: [...songs],
    gumboIds: [
      ...(await gumboIdsOf(
        db,
        members.map(row => row.userId)
      ))
    ]
  }
}

/** The gumbo id of each of these people that has one. */
export async function gumboIdsOf(
  db: Kysely<Database>,
  userIds: string[]
): Promise<Map<string, number>> {
  if (userIds.length === 0) return new Map()
  const rows = await db
    .selectFrom('gumbo_ids')
    .select(['user_id', 'gumbo_id'])
    // One array parameter: a roster can outnumber a statement's 65535.
    .where('user_id', '=', anyOf(userIds))
    .execute()
  return new Map(rows.map(row => [row.user_id, row.gumbo_id]))
}
