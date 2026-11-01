import type { Kysely, Selectable } from 'kysely'

import { conflict } from '../../common/errors'
import { storedGuests } from '../../common/guests'
import type { CurrentPlay, GumboPlay } from '../../common/gumboPlay'
import { replayPlays, storedRecordOf } from '../../common/scoring/gumbo'
import { appearedBySide } from '../../common/scoring/rosterAvailability'
import { awaitingResult } from '../../common/scoring/rules'
import { teamsOfRow } from '../../common/teamLists'
import type { Database, GamesTable } from '../db/database'
import { readPlays } from '../events/postPlays'
import { resolveScoringGame } from '../scoring/openRow'
import { contextOf } from '../scoring/replayContext'
import { isRealPlaySql } from './scoringActivity'

type Trx = Kysely<Database>

/**
 * Whether the game, its row held, can take a guest now: neither over nor
 * between a pitch and its result. A guest made by hand and a pool player
 * accepted later are held to the same.
 */
export async function guestGameOpen(
  trx: Trx,
  game: Selectable<GamesTable>
): Promise<void> {
  if (game.status === 'final' || game.status === 'cancelled')
    throw conflict('This game cannot accept players')
  const replay = await replayedGame(trx, game)
  if (replay != null) {
    if (replay.problems.length > 0 || awaitingResult(replay.state))
      throw conflict('Finish the current play before creating a player')
  } else if (
    game.currentPlay != null &&
    storedRecordOf(game.currentPlay) == null
  ) {
    throw conflict('The stored game cannot be read')
  }
}

/**
 * How one of these accounts is in the game already, if it is: as a player
 * of either team, or a guest of either side. One person plays one side once.
 */
export async function inGameAs(
  trx: Trx,
  game: Selectable<GamesTable>,
  userIds: string[]
): Promise<'player' | 'guest' | null> {
  const onRoster = await trx
    .selectFrom('memberships')
    .select('id')
    .where('team_id', 'in', [game.home_team_id, game.away_team_id])
    .where('user_id', 'in', userIds)
    .where('is_player', '=', true)
    .executeTakeFirst()
  if (onRoster != null) return 'player'
  const gumbos = await trx
    .selectFrom('gumbo_ids')
    .select('gumbo_id')
    .where('user_id', 'in', userIds)
    .execute()
  const guests = storedGuests(game.guests, teamsOfRow(game))
  return gumbos.some(
    row =>
      guests.away.includes(row.gumbo_id) || guests.home.includes(row.gumbo_id)
  )
    ? 'guest'
    : null
}

/**
 * A game's plays replayed, or nothing when it has no record to read. With
 * problems, the state is only as far as the replay got.
 */
export async function replayedGame(
  trx: Trx,
  game: Pick<
    Selectable<GamesTable>,
    'id' | 'currentPlay' | 'home_team_id' | 'away_team_id'
  >
): Promise<ReturnType<typeof replayPlays> | null> {
  const stored = await resolveScoringGame(
    trx,
    {
      plays: (await readPlays(trx, game.id)).map(row => row.gumbo as GumboPlay),
      currentPlay: game.currentPlay as CurrentPlay | null
    },
    { gameId: game.id }
  )
  const context = await contextOf(trx, game.id, game, stored)
  return context == null ? null : replayPlays(stored, context)
}

/**
 * Whether they have appeared in this game for the team this one plays: in a
 * stored play of its own (`isRealPlaySql`), which a game scored elsewhere has
 * nothing else to say it with, or as the app reads the game (`appearedBySide`).
 */
export async function playedForOther(
  trx: Trx,
  game: Pick<
    Selectable<GamesTable>,
    'id' | 'currentPlay' | 'home_team_id' | 'away_team_id'
  >,
  userIds: string[],
  teamId: string
): Promise<boolean> {
  const stored = await trx
    .selectFrom('event_players')
    .innerJoin('events', 'events.id', 'event_players.event_id')
    .innerJoin('gumbo_ids', 'gumbo_ids.gumbo_id', 'event_players.gumbo_id')
    .select('event_players.id')
    .where('events.gameId', '=', game.id)
    .where('gumbo_ids.user_id', 'in', userIds)
    .where('event_players.team_id', '!=', teamId)
    .where(isRealPlaySql)
    .executeTakeFirst()
  if (stored != null) return true
  const replay = await replayedGame(trx, game)
  if (replay == null) return false
  const gumbos = await trx
    .selectFrom('gumbo_ids')
    .select('gumbo_id')
    .where('user_id', 'in', userIds)
    .execute()
  const other = game.home_team_id === teamId ? 'away' : 'home'
  const appeared = appearedBySide(replay.state)[other]
  return gumbos.some(row => appeared.has(row.gumbo_id))
}

/** Refuses a guest who is in the game already. */
export async function guestAlreadyInGame(
  trx: Trx,
  game: Selectable<GamesTable>,
  userIds: string[]
): Promise<void> {
  const held = await inGameAs(trx, game, userIds)
  if (held === 'player')
    throw conflict('This player is already on a team in this game')
  if (held === 'guest') throw conflict('This player is already in this game')
}
