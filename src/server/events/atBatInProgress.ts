import { type RawBuilder, sql } from 'kysely'

/**
 * The at-bat in progress as a reader of a game wants it. After the first
 * pitch it is the game's `currentPlay`. Before it, no Gumbo is stored: the
 * lineups live in the team-keyed `pregame` record, and readers get it on a
 * play that names only its place in the game, the top of the 1st, as the
 * replay reads it. A game with a stored play has begun, and its pregame is
 * no at-bat.
 */
export const PREGAME_ABOUT = {
  atBatIndex: 0,
  inning: 1,
  halfInning: 'top',
  isTopInning: true,
  isComplete: false,
  hasOut: false,
  hasReview: false
} as const

/** `atBatInProgress` for a games row: select it `as('currentPlay')`. */
export function atBatInProgress(table = 'games'): RawBuilder<unknown> {
  return sql`coalesce(${sql.ref(`${table}.currentPlay`)},
    case when ${sql.ref(`${table}.pregame`)} is not null
      and not exists (select 1 from events e where e."gameId" = ${sql.ref(`${table}.id`)})
    then jsonb_build_object('about', ${JSON.stringify(PREGAME_ABOUT)}::jsonb,
      'teamStation', ${sql.ref(`${table}.pregame`)}) end)`
}

/** The same, from a row already read with its plays. */
export function atBatOf(
  game: { currentPlay: unknown; pregame: unknown },
  hasPlays: boolean
): unknown {
  if (game.currentPlay != null) return game.currentPlay
  if (game.pregame == null || hasPlays) return null
  return { about: { ...PREGAME_ABOUT }, teamStation: game.pregame }
}
