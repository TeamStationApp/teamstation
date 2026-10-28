import { createHash } from 'node:crypto'

import { type Kysely, type RawBuilder, sql } from 'kysely'

import { shortNames } from '../../common/names'
import type { NameOf } from '../../common/scoring/storedNames'
import type { Database } from '../db/database'
import { atBatOf } from '../events/atBatInProgress'
import { scoringIdsIn } from '../scoring/projection'
import { survivorsOf } from './survivors'

/**
 * Names read from `users`, a response at a time. A **name book** answers the
 * name of each gumbo id it was built for: one query of `gumbo_ids` joined to
 * `users` for every id of a response, merged accounts followed to their
 * survivor, and short names computed over a **scope**, the people one
 * surface shows together, so two players in the same game never read the
 * same. A book never carries first or last names: general reads feed public
 * scoreboards. `nameHalves` answers them, for whoever may correct them.
 */

/** A scope's names, and what they were made from. */
export interface NameBook {
  /** The short name of the player with this gumbo id, or undefined. */
  nameOf: NameOf
  /**
   * A digest of every account the book can name: each account and its
   * display, first and last names, whichever of its ids the scope holds. It
   * moves on any rename, deletion or merge of somebody the book can name, and
   * a scope of ids as stored reads the same as one of their survivors' ids.
   */
  digest: string
}

type Db = Kysely<Database>

/** An account as a name book reads it. */
interface Person {
  userId: string
  displayName: string
  firstName: string | null
  lastName: string | null
}

/** Each gumbo id's account as it reads now: its survivor's, when merged. */
async function peopleOf(
  db: Db,
  gumboIds: Iterable<number>
): Promise<Map<number, Person>> {
  const wanted = [...new Set(gumboIds)]
  if (wanted.length === 0) return new Map()
  const rows = await db
    .selectFrom('gumbo_ids')
    .innerJoin('users', 'users.id', 'gumbo_ids.user_id')
    .select([
      'gumbo_ids.gumbo_id as gumboId',
      'users.id as userId',
      'users.merged_into as mergedInto',
      'users.display_name as displayName',
      'users.first_name as firstName',
      'users.last_name as lastName'
    ])
    .where('gumbo_ids.gumbo_id', 'in', wanted)
    .execute()
  const people = new Map<number, Person>()
  const merged = rows.filter(row => row.mergedInto != null)
  const survivors =
    merged.length === 0
      ? new Map<string, string>()
      : await survivorsOf(
          db,
          merged.map(row => row.userId)
        )
  const survivorRows =
    survivors.size === 0
      ? []
      : await db
          .selectFrom('users')
          .select([
            'id as userId',
            'display_name as displayName',
            'first_name as firstName',
            'last_name as lastName'
          ])
          .where('id', 'in', [...new Set(survivors.values())])
          .execute()
  const byUser = new Map(survivorRows.map(row => [row.userId, row]))
  for (const row of rows) {
    const survivor =
      row.mergedInto == null
        ? undefined
        : byUser.get(survivors.get(row.userId)!)
    const person = survivor ?? row
    people.set(Number(row.gumboId), {
      userId: person.userId,
      displayName: person.displayName,
      firstName: person.firstName,
      lastName: person.lastName
    })
  }
  return people
}

/** A book over one scope of `people`. */
function bookOf(
  people: ReadonlyMap<number, Person>,
  scope: Iterable<number>
): NameBook {
  const ids = [...new Set(scope)]
    .filter(id => people.has(id))
    .sort((a, b) => a - b)
  const labels = shortNames(
    ids.map(id => {
      const person = people.get(id)!
      return {
        id: person.userId,
        displayName: person.displayName,
        firstName: person.firstName,
        lastName: person.lastName
      }
    })
  )
  const inScope = new Set(ids)
  const accounts = new Map(
    ids.map(id => {
      const person = people.get(id)!
      return [person.userId, person] as const
    })
  )
  return {
    nameOf: id =>
      inScope.has(id) ? labels.get(people.get(id)!.userId) : undefined,
    digest: createHash('md5')
      .update(
        JSON.stringify(
          [...accounts.values()]
            .sort((a, b) =>
              a.userId < b.userId ? -1 : a.userId > b.userId ? 1 : 0
            )
            .map(person => [
              person.userId,
              person.displayName,
              person.firstName,
              person.lastName
            ])
        )
      )
      .digest('hex')
  }
}

/**
 * A book for each scope, read in one query for all of them: what a response
 * that shows several games, each named over its own players, reads.
 */
export async function booksOver<K>(
  db: Db,
  scopes: ReadonlyMap<K, Iterable<number>>
): Promise<Map<K, NameBook>> {
  const lists = new Map([...scopes].map(([key, ids]) => [key, [...ids]]))
  const people = await peopleOf(db, [...lists.values()].flat())
  return new Map(
    [...lists].map(([key, ids]) => [key, bookOf(people, ids)] as const)
  )
}

/** `rows` in lists by `key`, each in its order. */
function groupedBy<T>(
  rows: readonly T[],
  key: (row: T) => string
): Map<string, T[]> {
  const groups = new Map<string, T[]>()
  for (const row of rows) {
    const group = groups.get(key(row))
    if (group == null) groups.set(key(row), [row])
    else group.push(row)
  }
  return groups
}

/** Each game's `event_players` ids, every game read at once. */
export async function gamePlayers(
  db: Db,
  gameIds: readonly string[]
): Promise<Map<string, number[]>> {
  if (gameIds.length === 0) return new Map()
  const players = await db
    .selectFrom('event_players')
    .innerJoin('events', 'events.id', 'event_players.event_id')
    .select(['events.gameId as gameId', 'event_players.gumbo_id as gumboId'])
    .where('events.gameId', 'in', gameIds)
    .execute()
  return new Map(
    [...groupedBy(players, row => row.gameId)].map(([gameId, rows]) => [
      gameId,
      rows.map(row => Number(row.gumboId))
    ])
  )
}

/**
 * A game's scope: everyone its stored plays and its at-bat in progress name
 * — the setups' players and each `addPlayer` action's guest, read from the
 * upgraded record, every reference, sentence, credit and assist — with the
 * game's `event_players`. Every surface that names a game names it over
 * this, so a player reads the same in its plays, highlights and lineups.
 */
export function scopeOf(
  stored: { plays: readonly unknown[]; currentPlay: unknown },
  players: readonly number[]
): number[] {
  return [...scoringIdsIn(stored), ...players]
}

/**
 * Each game's scope (`scopeOf`), its documents read. Before the first
 * pitch the at-bat is the game's pregame lineups (`atBatOf`). Every game is
 * read at once.
 */
async function gameScopes(
  db: Db,
  gameIds: readonly string[]
): Promise<Map<string, number[]>> {
  const games = await db
    .selectFrom('games')
    .select(['id', 'currentPlay', 'pregame'])
    .where('id', 'in', gameIds)
    .execute()
  const plays = await db
    .selectFrom('events')
    .select(['gameId', 'gumbo'])
    .where('gameId', 'in', gameIds)
    .execute()
  const players = await gamePlayers(db, gameIds)
  // Grouped by game once: a page of many games reads each row once.
  const playsOf = groupedBy(plays, row => row.gameId)
  const scopes = new Map<string, number[]>()
  for (const game of games) {
    const stored = (playsOf.get(game.id) ?? []).map(row => row.gumbo)
    scopes.set(
      game.id,
      scopeOf(
        { plays: stored, currentPlay: atBatOf(game, stored.length > 0) },
        players.get(game.id) ?? []
      )
    )
  }
  return scopes
}

/**
 * What a games row's scope is read from, as one short text the database
 * works out without reading a document: the row version (`xmin`) of the
 * game, which holds its at-bat in progress and pregame, and of each of its
 * plays and `event_players` rows. Any write of any of them moves it. Select
 * it beside whatever else a check reads of the game.
 */
export function scopeStampOf(table = 'games'): RawBuilder<string> {
  const id = sql.ref(`${table}.id`)
  return sql<string>`${sql.ref(`${table}.xmin`)}::text || ':' || coalesce((select md5(string_agg(events.id || '@' || events.xmin::text, ',' order by events.id)) from events where events."gameId" = ${id}), '') || ':' || coalesce((select md5(string_agg(event_players.id || '@' || event_players.xmin::text, ',' order by event_players.id)) from event_players inner join events on events.id = event_players.event_id where events."gameId" = ${id}), '')`
}

/** How many games' scopes are kept. */
const SCOPES_KEPT = 200

/** The scopes read, by game, under their stamps, least recently asked first. */
const keptScopes = new Map<string, { stamp: string; ids: number[] }>()

/** Keeps a game's scope as it was read under `stamp` (`scopeStampOf`). */
export function keepScope(
  gameId: string,
  stamp: string,
  ids: readonly number[]
): void {
  keptScopes.delete(gameId)
  keptScopes.set(gameId, { stamp, ids: [...ids] })
  while (keptScopes.size > SCOPES_KEPT)
    keptScopes.delete(keptScopes.keys().next().value!)
}

/**
 * The game's scope kept under `stamp`, or undefined once a write has moved
 * it (or none was kept): what a check reads instead of the game's plays.
 */
export function keptScope(gameId: string, stamp: string): number[] | undefined {
  const kept = keptScopes.get(gameId)
  if (kept?.stamp !== stamp) return undefined
  keptScopes.delete(gameId)
  keptScopes.set(gameId, kept)
  return kept.ids
}

/**
 * A game's scope under `stamp`, its stamp as just read: the kept one, or
 * read from its documents and kept. The stamp is read first, so a write
 * between the two reads only makes the next check read the scope again.
 */
export async function scopeUnder(
  db: Db,
  gameId: string,
  stamp: string
): Promise<number[]> {
  const kept = keptScope(gameId, stamp)
  if (kept != null) return kept
  const ids = (await gameScopes(db, [gameId])).get(gameId) ?? []
  keepScope(gameId, stamp, ids)
  return ids
}

/**
 * Each game's book: its players (`scopeOf`), every game of a response read
 * at once, and its names in one query. The games' stamps are read first: a
 * game whose scope is kept under its stamp reads no document, and the
 * others' documents are read together, and their scopes kept.
 */
export async function gameNames(
  db: Db,
  gameIds: Iterable<string>
): Promise<Map<string, NameBook>> {
  const wanted = [...new Set(gameIds)]
  if (wanted.length === 0) return new Map()
  const stamps = await db
    .selectFrom('games')
    .select(['games.id as id', scopeStampOf('games').as('stamp')])
    .where('games.id', 'in', wanted)
    .execute()
  const scopes = new Map<string, number[]>()
  const unkept = stamps.filter(row => {
    const kept = keptScope(row.id, row.stamp)
    if (kept != null) scopes.set(row.id, kept)
    return kept == null
  })
  if (unkept.length > 0) {
    const read = await gameScopes(
      db,
      unkept.map(row => row.id)
    )
    for (const row of unkept) {
      const ids = read.get(row.id) ?? []
      keepScope(row.id, row.stamp, ids)
      scopes.set(row.id, ids)
    }
  }
  return await booksOver(db, scopes)
}

/** The digest of the book over `scope` (`NameBook.digest`). */
export async function scopeDigest(
  db: Db,
  scope: readonly number[]
): Promise<string> {
  return (await booksOver(db, new Map([[0, scope]]))).get(0)!.digest
}

/**
 * The digest of one game's book (`gameNames`), or '' for no such game: the
 * check every narration read makes, so it reads no play. The game's scope
 * is kept under its stamp (`scopeStampOf`) and read again only once a write
 * moves it; the accounts are read every time, so a rename, deletion or
 * merge moves the digest at once.
 */
export async function gameNamesDigest(db: Db, gameId: string): Promise<string> {
  const row = await db
    .selectFrom('games')
    .select(scopeStampOf('games').as('stamp'))
    .where('games.id', '=', gameId)
    .executeTakeFirst()
  if (row == null) return ''
  return await scopeDigest(db, await scopeUnder(db, gameId, row.stamp))
}

/**
 * A team's names: short names over the team's members, as its roster
 * shows them, with `gumboIds` (anyone else the answer names) among them.
 */
export async function teamNames(
  db: Db,
  teamId: string,
  gumboIds: Iterable<number> = []
): Promise<NameOf> {
  const members = await db
    .selectFrom('memberships')
    .innerJoin('gumbo_ids', 'gumbo_ids.user_id', 'memberships.user_id')
    .select('gumbo_ids.gumbo_id as gumboId')
    .where('memberships.team_id', '=', teamId)
    .execute()
  const scope = [...members.map(row => Number(row.gumboId)), ...gumboIds]
  return (await booksOver(db, new Map([[teamId, scope]]))).get(teamId)!.nameOf
}

/** A person's name in two halves, as a correction is typed. */
export interface NameHalves {
  firstName: string
  lastName: string
}

/**
 * Each gumbo id's first and last names, for a caller who may correct them:
 * never on a general read. An account with no halves splits its display
 * name at the first space.
 */
export async function nameHalves(
  db: Db,
  gumboIds: Iterable<number>
): Promise<Map<number, NameHalves>> {
  const people = await peopleOf(db, gumboIds)
  return new Map(
    [...people].map(([id, person]) => {
      const first = (person.firstName ?? '').trim()
      const last = (person.lastName ?? '').trim()
      if (first !== '' || last !== '')
        return [id, { firstName: first, lastName: last }] as const
      const [given = '', ...rest] = person.displayName.trim().split(/\s+/)
      return [id, { firstName: given, lastName: rest.join(' ') }] as const
    })
  )
}

/**
 * Each user's `display_name`, merged accounts read as their survivor: the
 * name a notification gives its sender or actor.
 */
export async function userNames(
  db: Db,
  userIds: Iterable<string>
): Promise<Map<string, string>> {
  const wanted = [...new Set(userIds)]
  if (wanted.length === 0) return new Map()
  const survivors = await survivorsOf(db, wanted)
  const rows = await db
    .selectFrom('users')
    .select(['id', 'display_name'])
    .where('id', 'in', [...new Set(survivors.values())])
    .execute()
  const names = new Map(rows.map(row => [row.id, row.display_name]))
  return new Map(
    wanted.map(id => [id, names.get(survivors.get(id)!) ?? ''] as const)
  )
}
