import type { Kysely } from 'kysely'

import { conflict } from '../../common/errors'
import { DEFAULT_PLAYER_NAME_PRIVACY } from '../../common/playerNamePrivacy'
import type { StoredGame } from '../../common/scoring/session'
import { withNames } from '../../common/scoring/storedNames'
import { openAdds } from '../access'
import { UnresolvedAccount } from '../admin/people'
import type { Database } from '../db/database'
import {
  booksOver,
  gamePlayers,
  type GameScope,
  type NameBook,
  type NameHalves,
  nameHalves,
  scopeOf,
  withWithdrawn
} from '../users/nameBook'
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
  /**
   * The names go to a speech model as well as the public: narration. Each
   * format is taken down to its spoken form (`spokenFormat`).
   */
  spoken?: boolean
}

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
  const held = (
    await Promise.all([...teams].map(async team => await openAdds(db, team)))
  ).flatMap(open => [...open])
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

/**
 * A game as its reader is answered, the book it was named from, and the
 * scope of ids as stored the book was made over (`scopeOf`): merged
 * accounts read as their survivors (as `resolveScoringGame`), every play
 * and the at-bat in progress named from `users` (`withNames`) by short
 * names over the game's players, and first and last names only for the
 * players of `options.halves`. The documents given are left as they are.
 */
export async function namedScoringGame<T extends StoredGame>(
  db: Kysely<Database>,
  stored: T,
  options: ScoringReadOptions = {}
): Promise<{ game: T; names: NameBook; scope: GameScope }> {
  const resolved = await resolveGumboIds(db, scoringIdsIn(stored)).catch(
    (error: unknown) => {
      if (error instanceof UnresolvedAccount)
        throw conflict(
          'The scoring history refers to an account that cannot be resolved'
        )
      throw error
    }
  )
  const projected = [...resolved].every(([id, survivor]) => id === survivor)
    ? stored
    : projectScoringGame(stored, id => {
        const survivor = resolved.get(id)
        if (survivor == null) throw new Error('Missing scoring identity')
        return survivor
      })
  const players =
    options.gameId == null
      ? []
      : ((await gamePlayers(db, [options.gameId])).get(options.gameId) ?? [])
  // General scoring reads also feed public scoreboards. Disambiguate against
  // everyone in the game without adding private name parts to the projection.
  // Ids as stored and their survivors' read as the same accounts.
  const book = (
    await booksOver(db, new Map([[0, scopeOf(projected, players)]]), {
      spoken: options.spoken
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
            playersOf(projected, teams),
            teams
          )
        )
  const name = <D extends GumboDocument>(document: D): D => {
    if (document == null) return document
    const named = withNames(document, names.nameOf)
    const record = (named as { teamStation?: unknown }).teamStation
    if (record == null) return named
    return { ...named, teamStation: withHalves(record, teams, halves, names) }
  }
  return {
    game: {
      ...projected,
      plays: projected.plays.map(name),
      currentPlay: name(projected.currentPlay)
    },
    names,
    scope: scopeOf(stored, players)
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
