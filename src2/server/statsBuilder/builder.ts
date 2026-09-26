import { type Kysely, sql } from 'kysely'

import type { GumboPlay } from '../../common/gumboPlay'
import { makeId } from '../../common/ids'
import type { Database } from '../db/database'
import { gameStatLines } from '../stats/gumboStats'

export type Clock = () => Date

/**
 * Optional callback between reading the game and writing the result.
 * Tests use it for "post during build" and "user deleted mid-build".
 */
export type AfterReadHook = (args: {
  db: Kysely<Database>
  gameId: string
  gen: number
}) => Promise<void>

function isRecord(value: unknown): value is Record<string, unknown> {
  return value != null && typeof value === 'object' && !Array.isArray(value)
}

/** Every positive numeric player id a play names. */
export function namedPlayerIds(plays: unknown[]): number[] {
  const ids = new Set<number>()
  const take = (player: unknown): void => {
    if (!isRecord(player)) return
    const id = player.id
    if (typeof id === 'number' && Number.isSafeInteger(id) && id > 0) {
      ids.add(id)
    }
  }
  for (const play of plays) {
    if (!isRecord(play)) continue
    const matchup = isRecord(play.matchup) ? play.matchup : {}
    take(matchup.batter)
    take(matchup.pitcher)
    const runners = Array.isArray(play.runners) ? play.runners : []
    for (const entry of runners) {
      if (!isRecord(entry)) continue
      const details = isRecord(entry.details) ? entry.details : {}
      take(details.runner)
      take(details.responsiblePitcher)
      take(details.pitcher)
    }
  }
  return [...ids]
}

/**
 * Drain every owed game. `clock()` supplies every stored timestamp and every
 * retry comparison. Those writes do not call Postgres `now()`. `isStopped`
 * ends the drain after the game in hand so a shutdown does not wait out the
 * whole queue.
 */
export async function drain(
  db: Kysely<Database>,
  clock: Clock,
  afterRead?: AfterReadHook | null,
  isStopped: () => boolean = () => false
): Promise<void> {
  const skipped = new Set<string>()
  for (;;) {
    if (isStopped()) return
    const result = await buildNext(db, clock, skipped, afterRead)
    if (result === 'empty') return
    if (result.kind === 'skipped') {
      skipped.add(result.gameId)
      continue
    }
    if (isStopped()) return
  }
}

type BuildResult =
  | 'empty'
  | { kind: 'skipped'; gameId: string }
  | { kind: 'done' }
  | { kind: 'failed' }

/** Build one owed game (or skip/fail). Exported for the mid-build poke test. */
export async function buildNext(
  db: Kysely<Database>,
  clock: Clock,
  skipped: ReadonlySet<string> = new Set(),
  afterRead?: AfterReadHook | null
): Promise<BuildResult> {
  const now = clock()
  // Object box so catch can read the pick; a `let` assigned only inside the
  // transaction callback is narrowed to `null`/`never` by control-flow analysis.
  const picked = { gameId: null as string | null, gen: 0 }

  try {
    const outcome = await db.transaction().execute(async trx => {
      let query = trx
        .selectFrom('game_stats_state')
        .select(['game_id', 'requested_generation'])
        .whereRef('requested_generation', '>', 'built_generation')
        .where(eb =>
          eb.or([eb('retry_at', 'is', null), eb('retry_at', '<=', now)])
        )
        .orderBy('requested_at', 'asc')
        .orderBy('game_id', 'asc')
        .limit(1)

      if (skipped.size > 0) {
        query = query.where('game_id', 'not in', [...skipped])
      }

      const owed = await query.executeTakeFirst()
      if (owed == null) return 'empty' as const

      const gameId = owed.game_id
      const gen = Number(owed.requested_generation)
      picked.gameId = gameId
      picked.gen = gen

      const lock = await sql<{ locked: boolean }>`
        select pg_try_advisory_xact_lock(
          hashtext(${'game_stats:' + gameId})
        ) as locked
      `.execute(trx)
      if (!lock.rows[0]?.locked) {
        return { kind: 'skipped' as const, gameId }
      }

      const game = await trx
        .selectFrom('games')
        .select(['home_team_id', 'away_team_id'])
        .where('id', '=', gameId)
        .executeTakeFirst()
      if (game == null) {
        throw new Error(`game ${gameId} not found`)
      }

      const eventRows = await trx
        .selectFrom('events')
        .select(['gumbo'])
        .where('gameId', '=', gameId)
        .orderBy('atBatIndex', 'asc')
        .execute()
      const plays = eventRows.map(row => row.gumbo as GumboPlay)

      const named = namedPlayerIds(plays)
      const knownUsers = new Set<number>()
      if (named.length > 0) {
        const users = await trx
          .selectFrom('users')
          .select('id')
          .where('id', 'in', named)
          .execute()
        for (const user of users) knownUsers.add(Number(user.id))
      }

      if (afterRead != null) {
        await afterRead({ db: trx, gameId, gen })
      }

      const teams = {
        homeTeamId: game.home_team_id,
        awayTeamId: game.away_team_id
      }
      const started = Date.now()

      if (plays.length === 0) {
        await trx
          .deleteFrom('game_player_stats')
          .where('game_id', '=', gameId)
          .execute()
        await updateState(trx, gameId, gen, {
          status: 'built',
          detail: null,
          builtAt: now
        })
        console.log(
          `stats builder: game ${gameId} gen ${gen} built 0 rows in ${Date.now() - started} ms`
        )
        return { kind: 'done' as const }
      }

      const result = gameStatLines(plays, teams, knownUsers)
      if (result.kind === 'incomplete') {
        await updateState(trx, gameId, gen, {
          status: 'incomplete',
          detail: result.detail,
          builtAt: now
        })
        console.log(
          `stats builder: game ${gameId} gen ${gen} incomplete: ${result.detail}`
        )
        return { kind: 'done' as const }
      }

      await trx
        .deleteFrom('game_player_stats')
        .where('game_id', '=', gameId)
        .execute()
      for (const line of result.lines) {
        await trx
          .insertInto('game_player_stats')
          .values({
            id: makeId('gamePlayerStats'),
            game_id: gameId,
            user_id: line.userId,
            team_id: line.teamId,
            pa: line.pa,
            ab: line.ab,
            h: line.h,
            singles: line.singles,
            doubles: line.doubles,
            triples: line.triples,
            hr: line.hr,
            bb: line.bb,
            k: line.k,
            r: line.r,
            rbi: line.rbi,
            hbp: line.hbp,
            ci: line.ci,
            sf: line.sf,
            sh: line.sh,
            sb: line.sb,
            cs: line.cs,
            pitch_bf: line.pitch_bf,
            pitch_outs: line.pitch_outs,
            pitch_h: line.pitch_h,
            pitch_hr: line.pitch_hr,
            pitch_bb: line.pitch_bb,
            pitch_hbp: line.pitch_hbp,
            pitch_k: line.pitch_k,
            pitch_r: line.pitch_r,
            pitch_er: line.pitch_er,
            computed_at: now.toISOString()
          })
          .execute()
      }
      await updateState(trx, gameId, gen, {
        status: 'built',
        detail: null,
        builtAt: now
      })
      console.log(
        `stats builder: game ${gameId} gen ${gen} built ${result.lines.length} rows in ${Date.now() - started} ms`
      )
      return { kind: 'done' as const }
    })
    return outcome
  } catch (error) {
    if (picked.gameId == null) throw error
    console.error(`stats builder: game ${picked.gameId} failed`, error)
    const message = error instanceof Error ? error.message : String(error)
    await markFailed(db, picked.gameId, picked.gen, message, clock)
    return { kind: 'failed' }
  }
}

async function updateState(
  db: Kysely<Database>,
  gameId: string,
  gen: number,
  next: {
    status: 'built' | 'incomplete'
    detail: string | null
    builtAt: Date
  }
): Promise<void> {
  // One statement, so a poke that commits during the update cannot be
  // overwritten with built. Still advance built_generation for the gen we
  // processed, and leave status pending when more work is owed.
  await sql`
    update game_stats_state
    set built_generation = ${gen},
        status = case
          when requested_generation = ${gen} then ${next.status}
          else 'pending'
        end,
        detail = case
          when requested_generation = ${gen} then ${next.detail}
          else null
        end,
        built_at = ${next.builtAt}
    where game_id = ${gameId}
      and built_generation < ${gen}
  `.execute(db)
}

async function markFailed(
  db: Kysely<Database>,
  gameId: string,
  gen: number,
  message: string,
  clock: Clock
): Promise<void> {
  const now = clock()
  const row = await db
    .selectFrom('game_stats_state')
    .select(['attempts', 'requested_generation'])
    .where('game_id', '=', gameId)
    .executeTakeFirst()
  // A concurrent poke raised requested_generation; leave that pending row alone.
  if (row == null || Number(row.requested_generation) !== gen) return
  const attempts = Number(row.attempts ?? 0) + 1
  const delayMinutes = Math.min(2 ** (attempts - 1), 60)
  const retryAt = new Date(now.getTime() + delayMinutes * 60_000)
  await db
    .updateTable('game_stats_state')
    .set({
      status: 'failed',
      detail: message,
      attempts,
      retry_at: retryAt
    })
    .where('game_id', '=', gameId)
    .where('requested_generation', '=', gen)
    .execute()
  console.error(
    `stats builder: game ${gameId} failed (${attempts}): ${message}`
  )
}

/** Earliest future `retry_at` among games still owed, or null. */
export async function earliestRetryAt(
  db: Kysely<Database>,
  clock: Clock
): Promise<Date | null> {
  const now = clock()
  const row = await db
    .selectFrom('game_stats_state')
    .select(eb => eb.fn.min('retry_at').as('next'))
    .whereRef('requested_generation', '>', 'built_generation')
    .where('retry_at', 'is not', null)
    .where('retry_at', '>', now)
    .executeTakeFirst()
  if (row?.next == null) return null
  return new Date(row.next)
}

/** How many games are still owed (pending a build or a retry). */
export async function owedCount(db: Kysely<Database>): Promise<number> {
  const row = await db
    .selectFrom('game_stats_state')
    .select(eb => eb.fn.countAll<string>().as('n'))
    .whereRef('requested_generation', '>', 'built_generation')
    .executeTakeFirst()
  return Number(row?.n ?? 0)
}
