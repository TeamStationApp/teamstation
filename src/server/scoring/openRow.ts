import type { Kysely } from 'kysely'

import { conflict } from '../../common/errors'
import { formatName } from '../../common/names'
import { DEFAULT_PLAYER_NAME_PRIVACY } from '../../common/playerNamePrivacy'
import type { StoredGame } from '../../common/scoring/session'
import { withNames } from '../../common/scoring/storedNames'
import { openAddsOf } from '../access'
import { UnresolvedAccount } from '../admin/people'
import type { Database } from '../db/database'
import {
  booksOver,
  type GamePlayerRow,
  gamePlayers,
  type GameScope,
  type NameBook,
  type NameHalves,
  nameHalves,
  scopeOf,
  withWithdrawn
} from '../users/nameBook'
import { fullNamesFor, type Reader } from '../users/readerNames'
import { survivorsOf } from '../users/survivors'
import { resolveGumboIds } from './gumboIds'
import { projectScoringGame, scoringIdsIn } from './projection'

export {
  projectScoringGame,
  ScoringProjectionConflict,
  scoringIdsIn
} from './projection'

/** How a game is named for its reader. */
export interface ScoringReadOptions {
  /**
   * The teams whose players' first and last names the reader is given, from
   * their accounts: the teams whose lineups he may save (`lineupTeams`),
   * whose game-only players' names he may correct and whose lineups his
   * tools export and match by name. Nobody else's halves are answered.
   */
  halves?: readonly string[]
  /**
   * The game's id: its `event_players` join the scope its players are
   * named over (`scopeOf`), as every surface of the game names them.
   */
  gameId?: string
  /** The game's `event_players`, by a caller that has read them already. */
  players?: readonly GamePlayerRow[]
  /**
   * The names go to a speech model as well as the public: narration. Each
   * format is taken down to its spoken form (`spokenFormat`).
   */
  spoken?: boolean
  /**
   * Whom the documents are named for: everyone this reader may read in full
   * is (`booksOver`). None for the game record every viewer holds.
   */
  reader?: Reader
  /**
   * Whom the answer's `readerNames` map is for: the documents stay named as
   * `reader` says, and it lists apart the players this reader reads in full.
   * Never the same thing as `reader`, which writes full names into the
   * documents themselves.
   */
  listFullNamesFor?: Reader
}

/** Gumbo id → full name, for the players a reader reads in full. */
export type ReaderNames = Record<number, string>

type GumboDocument = StoredGame['plays'][number] | StoredGame['currentPlay']

function object(value: unknown): value is Record<string, unknown> {
  return value != null && typeof value === 'object' && !Array.isArray(value)
}

/**
 * A named record's setups with no first or last name on any player, but a
 * player of one of `teams`, who has them from his account. A player in
 * anything but the built-in format says so, because the label is final: a
 * client draws it as sent and never shortens it again.
 */
function withHalves(
  record: unknown,
  teams: ReadonlySet<string>,
  halves: ReadonlyMap<number, NameHalves>,
  book: NameBook
): unknown {
  if (!object(record)) return record
  const players = (raw: unknown): unknown => {
    if (!object(raw)) return raw
    const out: Record<string, unknown> = {}
    for (const [key, player] of Object.entries(raw)) {
      if (!object(player)) {
        out[key] = player
        continue
      }
      const { firstName: _first, lastName: _last, ...rest } = player
      const parts =
        typeof player.teamId === 'string' &&
        teams.has(player.teamId) &&
        typeof player.id === 'number'
          ? halves.get(player.id)
          : undefined
      const format =
        typeof player.id === 'number' ? book.formatOf(player.id) : undefined
      out[key] = {
        ...rest,
        ...parts,
        ...(format == null || format === DEFAULT_PLAYER_NAME_PRIVACY
          ? {}
          : { nameFormat: format })
      }
    }
    return out
  }
  const setup = (raw: unknown): unknown =>
    object(raw) && 'players' in raw
      ? { ...raw, players: players(raw.players) }
      : raw
  return {
    ...record,
    ...('setupBefore' in record
      ? { setupBefore: setup(record.setupBefore) }
      : {}),
    ...(Array.isArray(record.actions)
      ? {
          actions: record.actions.map(action =>
            object(action) && 'setup' in action
              ? { ...action, setup: setup(action.setup) }
              : action
          )
        }
      : {})
  }
}

/**
 * `ids` without the game's pool players, the players withdrawn from it, and
 * those a side's team holds only by an open add: people who already exist,
 * whose whole names an add never gave the game, and who are nobody's here to
 * correct (`renameGuestPlayer`).
 */
async function withoutBorrowed(
  db: Kysely<Database>,
  gameId: string | undefined,
  ids: number[],
  teams: ReadonlySet<string>
): Promise<number[]> {
  if (ids.length === 0) return ids
  const held = [...(await openAddsOf(db, [...teams])).values()].flatMap(
    open => [...open]
  )
  const [pool, withdrawn] =
    gameId == null
      ? [[], []]
      : await Promise.all([
          db
            .selectFrom('game_guest_details')
            .select('user_id')
            .where('game_id', '=', gameId)
            .where('pool', '=', true)
            .execute(),
          db
            .selectFrom('game_withdrawn_players')
            .select('user_id')
            .where('game_id', '=', gameId)
            .execute()
        ])
  const users = [...held, ...[...pool, ...withdrawn].map(row => row.user_id)]
  if (users.length === 0) return ids
  const survivors = await survivorsOf(db, users)
  const borrowed = await db
    .selectFrom('gumbo_ids')
    .select('gumbo_id')
    .where('user_id', 'in', [...users, ...survivors.values()])
    .execute()
  const gone = new Set(borrowed.map(row => Number(row.gumbo_id)))
  return ids.filter(id => !gone.has(id))
}

/** The players of `teams` a game's setups hold. */
function playersOf(stored: StoredGame, teams: ReadonlySet<string>): number[] {
  const ids = new Set<number>()
  const collect = (setup: unknown): void => {
    if (!object(setup) || !object(setup.players)) return
    for (const player of Object.values(setup.players))
      if (
        object(player) &&
        typeof player.id === 'number' &&
        typeof player.teamId === 'string' &&
        teams.has(player.teamId)
      )
        ids.add(player.id)
  }
  for (const document of [...stored.plays, stored.currentPlay]) {
    const record = (document as { teamStation?: unknown } | null)?.teamStation
    if (!object(record)) continue
    collect(record.setupBefore)
    if (Array.isArray(record.actions))
      for (const action of record.actions)
        if (object(action)) collect(action.setup)
  }
  return [...ids]
}

/** The survivor of each scoring id a game holds. */
async function resolvedIdsOf(
  db: Kysely<Database>,
  stored: StoredGame
): Promise<ReadonlyMap<number, number>> {
  return await resolveGumboIds(db, scoringIdsIn(stored)).catch(
    (error: unknown) => {
      if (error instanceof UnresolvedAccount)
        throw conflict(
          'The scoring history refers to an account that cannot be resolved'
        )
      throw error
    }
  )
}

function allThemselves(resolved: ReadonlyMap<number, number>): boolean {
  return [...resolved].every(([id, survivor]) => id === survivor)
}

/**
 * Whether a game names an account since merged into another, so that reading
 * it resolves any id. With none, its named read holds the same people as its
 * stored form, only with their names filled in.
 */
export async function namesMergedAccounts(
  db: Kysely<Database>,
  stored: StoredGame
): Promise<boolean> {
  return !allThemselves(await resolvedIdsOf(db, stored))
}

/** How a game's documents are named: built once, over the whole game. */
interface GameNamer<T extends StoredGame> {
  /** The game with merged accounts read as their survivors, still unnamed. */
  projected: T
  names: NameBook
  scope: GameScope
  /** For `options.listFullNamesFor`, whom it reads in full; absent for nobody. */
  readerNames?: ReaderNames
  /**
   * A document as the reader is answered it, and the way to name it as the
   * public is, worked out only when asked for.
   */
  name: <D extends GumboDocument>(document: D) => { reader: D; public: () => D }
}

/**
 * Everything the naming of `stored` reads, read once: merged accounts
 * resolved, and the book over the whole game's scope. The halves of
 * `options.halves` are read only for the players of the documents `picked`
 * keeps, which is every one unless it says otherwise.
 */
async function gameNamer<T extends StoredGame>(
  db: Kysely<Database>,
  stored: T,
  options: ScoringReadOptions,
  picked: (projected: T) => StoredGame = projected => projected
): Promise<GameNamer<T>> {
  const resolved = await resolvedIdsOf(db, stored)
  const projected = allThemselves(resolved)
    ? stored
    : projectScoringGame(stored, id => {
        const survivor = resolved.get(id)
        if (survivor == null) throw new Error('Missing scoring identity')
        return survivor
      })
  const players =
    options.players ??
    (options.gameId == null
      ? []
      : ((await gamePlayers(db, [options.gameId])).get(options.gameId) ?? []))
  // General scoring reads also feed public scoreboards. Disambiguate against
  // everyone in the game without adding private name parts to the projection.
  // Ids as stored and their survivors' read as the same accounts.
  const scope = scopeOf(projected, players)
  const book = (
    await booksOver(db, new Map([[0, scope]]), {
      spoken: options.spoken,
      reader: options.reader
    })
  ).get(0)!
  // A rejected add's plays stay; every surface reads them as the placeholder.
  const names =
    options.gameId == null
      ? book
      : await withWithdrawn(db, options.gameId, book)
  const teams = new Set(options.halves ?? [])
  const halves =
    teams.size === 0
      ? new Map<number, NameHalves>()
      : await nameHalves(
          db,
          await withoutBorrowed(
            db,
            options.gameId,
            playersOf(picked(projected), teams),
            teams
          )
        )
  const nobody = new Set<string>()
  const none = new Map<number, NameHalves>()
  const name = <D extends GumboDocument>(
    document: D
  ): { reader: D; public: () => D } => {
    if (document == null) return { reader: document, public: () => document }
    const named = withNames(document, names.nameOf)
    const record = (named as { teamStation?: unknown }).teamStation
    if (record == null) return { reader: named, public: () => named }
    const reader = {
      ...named,
      teamStation: withHalves(record, teams, halves, names)
    }
    return {
      reader,
      public: () =>
        teams.size === 0
          ? reader
          : { ...named, teamStation: withHalves(record, nobody, none, names) }
    }
  }
  return {
    projected,
    names,
    scope: scopeOf(stored, players),
    readerNames: await readerNamesOf(db, scope, names, options),
    name
  }
}

/**
 * The players of `scope` that `options.listFullNamesFor` reads in full and `book`
 * does not, by their full names, read from the accounts `book` already
 * loaded (one `fullNamesFor` call); nothing for no such reader, a spoken
 * read, or a withdrawn player, whom `book` names by the placeholder.
 */
async function readerNamesOf(
  db: Kysely<Database>,
  scope: GameScope,
  book: NameBook,
  options: ScoringReadOptions
): Promise<ReaderNames | undefined> {
  // `fullNamesFor` answers nobody for a read that goes to a model.
  if (options.listFullNamesFor == null || options.spoken === true)
    return undefined
  const shortened = [...new Set(scope.ids)].flatMap(id => {
    const shown = book.formatOf(id)
    const person = book.personOf(id)
    return shown == null || shown === 'full' || person == null
      ? []
      : [{ id, person }]
  })
  const full = await fullNamesFor(
    db,
    options.listFullNamesFor,
    shortened.map(({ person }) => person.userId)
  )
  const names: ReaderNames = {}
  for (const { id, person } of shortened)
    if (full.has(person.userId))
      names[id] = formatName(
        {
          id: person.userId,
          displayName: person.displayName,
          firstName: person.firstName,
          lastName: person.lastName
        },
        'full'
      )
  return Object.keys(names).length === 0 ? undefined : names
}

/**
 * A game as its reader is answered, the book it was named from, and the
 * scope of ids as stored the book was made over (`scopeOf`): merged
 * accounts read as their survivors (as `resolveScoringGame`), every play
 * and the at-bat in progress named from `users` (`withNames`) by short
 * names over the game's players, and first and last names only for the
 * players of `options.halves`, and the players `options.listFullNamesFor` reads
 * in full besides (`readerNames`). The documents given are left as they are.
 */
export async function namedScoringGame<T extends StoredGame>(
  db: Kysely<Database>,
  stored: T,
  options: ScoringReadOptions = {}
): Promise<{
  game: T
  names: NameBook
  scope: GameScope
  readerNames?: ReaderNames
}> {
  const { projected, names, scope, readerNames, name } = await gameNamer(
    db,
    stored,
    options
  )
  return {
    game: {
      ...projected,
      plays: projected.plays.map(play => name(play).reader),
      currentPlay: name(projected.currentPlay).reader
    },
    names,
    scope,
    ...(readerNames == null ? {} : { readerNames })
  }
}

/** Some of a game's plays and its at-bat in progress, named. */
export interface NamedPlays {
  /** The plays asked for that the game holds, in index order. */
  plays: StoredGame['plays']
  currentPlay: StoredGame['currentPlay']
}

/** What `resolveScoringPlays` names, and the book it named them from. */
export interface ResolvedPlays extends NamedPlays {
  public: NamedPlays
  /**
   * The digest of the book over the whole game (`NameBook.digest`), which
   * names every play: it moves whenever any play's public name would.
   */
  namesDigest: string
  /** For `options.listFullNamesFor`, whom it reads in full (`namedScoringGame`). */
  readerNames?: ReaderNames
}

/**
 * The plays of `stored` at the indexes `only` names (every one when it names
 * none), and the at-bat in progress, named exactly as `resolveScoringGame`
 * names them in the whole game: the book is made over the whole game's scope,
 * from the documents given, and only these documents are named from it. Each
 * comes as its reader is answered, with the halves of `options.halves`, and in
 * `public` as everybody is answered, with none: one naming serves both.
 * `public` holds those of them `publicOnly` names, when it names any, so a
 * reader answered every play can be given the public form of a few. The
 * book's digest comes with them, for whoever holds them to compare.
 */
export async function resolveScoringPlays(
  db: Kysely<Database>,
  stored: StoredGame,
  options: ScoringReadOptions & {
    only?: Iterable<number>
    publicOnly?: Iterable<number>
  }
): Promise<ResolvedPlays> {
  const only = options.only == null ? undefined : new Set(options.only)
  const shown =
    options.publicOnly == null ? undefined : new Set(options.publicOnly)
  const kept = (game: StoredGame): StoredGame =>
    only == null
      ? game
      : {
          ...game,
          plays: game.plays.filter(play => only.has(play.about.atBatIndex))
        }
  const { projected, names, readerNames, name } = await gameNamer(
    db,
    stored,
    options,
    kept
  )
  const plays = kept(projected).plays.map(play => ({ play, ...name(play) }))
  const current = name(projected.currentPlay)
  return {
    plays: plays.map(play => play.reader),
    currentPlay: current.reader,
    public: {
      plays: plays
        .filter(({ play }) => shown == null || shown.has(play.about.atBatIndex))
        .map(play => play.public()),
      currentPlay: current.public()
    },
    namesDigest: names.digest,
    ...(readerNames == null ? {} : { readerNames })
  }
}

/**
 * The one named read of a game: merged accounts resolved and every play
 * and the at-bat in progress named from `users` (`namedScoringGame`).
 * Callers keep the raw documents for digests and writes.
 */
export async function resolveScoringGame<T extends StoredGame>(
  db: Kysely<Database>,
  stored: T,
  options: ScoringReadOptions = {}
): Promise<T> {
  return (await namedScoringGame(db, stored, options)).game
}
