import { type Kysely, type RawBuilder, sql } from 'kysely'

import { retargetRecord } from '../../common/scoring/teamRecord'
import type { Database } from '../db/database'
import {
  holdingEventChildren,
  rebuildEventChildren
} from '../events/eventChildren'

/** How many games' plays are read and written at a time. */
const GAMES_PER_BATCH = 25

/** How a rewrite of a play reaches that play's children. */
export interface RetargetOptions {
  /**
   * For a caller moving a whole team: each play moves to the new batting team
   * with its record, and the children of all of them are rebuilt in a set
   * rather than by the trigger, one play at a time.
   */
  rebuildChildren?: boolean
}

/** Whether a record, already read once, is version 3 and names the team. */
export function recordNamesTeam(
  teamId: string,
  record: RawBuilder<unknown>
): RawBuilder<boolean> {
  return sql<boolean>`coalesce(${record}->>'version' = '3'
    and strpos((${record})::text, ${teamId}) > 0, false)`
}

/**
 * Keeps these games readable after one of their teams was replaced by
 * another: every place a record, or a list kept by team, names the old team
 * by its id names the new one. A record stored before records named teams
 * names sides, and needs nothing.
 */
export async function retargetGameTeams(
  trx: Kysely<Database>,
  gameIds: readonly string[],
  fromTeamId: string,
  toTeamId: string,
  options: RetargetOptions = {}
): Promise<void> {
  if (gameIds.length === 0 || fromTeamId === toTeamId) return
  // A merge can move many games: only the records are read, each changes once.
  for (let at = 0; at < gameIds.length; at += GAMES_PER_BATCH)
    await retargetPlays(
      trx,
      gameIds.slice(at, at + GAMES_PER_BATCH),
      fromTeamId,
      toTeamId,
      options
    )
  const games = await trx
    .selectFrom('games')
    .select(['id', 'currentPlay', 'pregame'])
    .where('id', 'in', [...gameIds])
    .where(
      sql<boolean>`strpos(coalesce("currentPlay"->'teamStation', 'null')::text
        || coalesce(pregame, 'null')::text, ${fromTeamId}) > 0`
    )
    .execute()
  // Written only where a record changed; null keeps what the game holds.
  const changes = games.flatMap(game => {
    const current = game.currentPlay as Record<string, unknown> | null
    const record =
      current == null
        ? undefined
        : retargetRecord(current.teamStation, fromTeamId, toTeamId)
    const pregame = retargetRecord(game.pregame, fromTeamId, toTeamId)
    const currentPlay =
      current == null || same(record, current.teamStation)
        ? null
        : JSON.stringify({ ...current, teamStation: record })
    const nextPregame = same(pregame, game.pregame)
      ? null
      : JSON.stringify(pregame)
    return currentPlay == null && nextPregame == null
      ? []
      : [{ id: game.id, currentPlay, pregame: nextPregame }]
  })
  if (changes.length > 0)
    await sql`
      update games g set
        "currentPlay" = coalesce(v.current_play::jsonb, g."currentPlay"),
        pregame = coalesce(v.pregame::jsonb, g.pregame)
      from unnest(
        ${changes.map(change => change.id)}::text[],
        ${changes.map(change => change.currentPlay)}::text[],
        ${changes.map(change => change.pregame)}::text[]
      ) as v(id, current_play, pregame)
      where g.id = v.id
    `.execute(trx)
  // A game's guests and players left off are kept under its teams' ids.
  for (const column of ['guests', 'unrostered'] as const)
    await sql`update games set ${sql.ref(column)} =
        (${sql.ref(column)} - ${fromTeamId}::text) ||
        jsonb_build_object(${toTeamId}::text, ${sql.ref(column)}->${fromTeamId}::text)
      where id in (${sql.join([...gameIds])}) and ${sql.ref(column)} ? ${fromTeamId}::text`.execute(
      trx
    )
}

/** Rewrites the records of a batch of games that name the old team. */
async function retargetPlays(
  trx: Kysely<Database>,
  gameIds: readonly string[],
  fromTeamId: string,
  toTeamId: string,
  { rebuildChildren = false }: RetargetOptions
): Promise<void> {
  const record = sql.ref('one.record')
  const { rows: plays } = await sql<{ id: string; record: unknown }>`
    select e.id, one.record from events e
    cross join lateral (select e.gumbo->'teamStation' offset 0) as one(record)
    where e."gameId" = any(${[...gameIds]}::text[])
      and ${recordNamesTeam(fromTeamId, record)}
  `.execute(trx)
  if (plays.length === 0) return
  const ids = plays.map(play => play.id)
  const rewritten = JSON.stringify(
    plays.map(play => ({
      id: play.id,
      record: retargetRecord(play.record, fromTeamId, toTeamId)
    }))
  )
  const write = sql`
    update events e set
      gumbo = e.gumbo || jsonb_build_object('teamStation', v.record)
      ${
        rebuildChildren
          ? sql`, "battingTeamId" = case when e."battingTeamId" = ${fromTeamId}
              then ${toTeamId} else e."battingTeamId" end`
          : sql``
      }
    from jsonb_to_recordset(${rewritten}::jsonb) as v(id text, record jsonb)
    where e.id = v.id
  `
  if (!rebuildChildren) {
    await write.execute(trx)
    return
  }
  await holdingEventChildren(trx, async () => await write.execute(trx))
  await rebuildEventChildren(trx, ids)
}

function same(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b)
}
