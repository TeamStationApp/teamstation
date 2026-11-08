import { type Kysely, sql } from 'kysely'

import type { CurrentPlay, GumboPlay } from '../../common/gumboPlay'
import { makeId } from '../../common/ids'
import { type Database, isConnectionUnavailable } from '../db/database'
import { expandedGameStatLines } from '../stats/expandedStats'
import type { ChargedPlay } from '../stats/gumboStats'
import { type PlateAppearance, rowsOf } from '../stats/plateAppearances'

export type Clock = () => Date

/**
 * How long a live game waits after a build began before it builds again.
 * Requests that arrive in the gap cost one build, of the latest generation. A
 * final game builds at once.
 */
export const BUILD_GAP_MS = 3000

/** The owed game's own status, read by its key only where it is asked for. */
const statusOfGame = sql<string>`(select games.status from games
  where games.id = game_stats_state.game_id)`

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

/**
 * Every positive numeric player id a play names where the stats builder can
 * charge a figure to him: the matchup, the runners, and the play events'
 * players and the men they replaced (a strikeout under 9.15(b) is charged to
 * a batter named only as a pinch hitter's `replacedPlayer`).
 */
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
    const events = Array.isArray(play.playEvents) ? play.playEvents : []
    for (const event of events) {
      if (!isRecord(event)) continue
      take(event.player)
      take(event.replacedPlayer)
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

/**
 * The advisory key a build holds for its game's whole transaction, taken with
 * `hashtext` before it touches any of the game's rows. Whoever else writes a
 * game's stats rows takes it first too, so the two never lock them in
 * opposite orders.
 */
export function gameStatsLock(gameId: string): string {
  return `game_stats:${gameId}`
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
  // `built_at` holds when the game's last build began, since every build
  // stores this `now`.
  const gapStart = new Date(now.getTime() - BUILD_GAP_MS)
  // Object box so catch can read the pick; a `let` assigned only inside the
  // transaction callback is narrowed to `null`/`never` by control-flow analysis.
  const picked = { gameId: null as string | null, gen: 0 }

  try {
    const outcome = await db.transaction().execute(async trx => {
      // Walked in `requested_at` order down the owed index, stopping at the
      // first game that may build. No join: a game's status is looked up
      // only for one still inside its gap, so a seeded history of thousands
      // owed costs what one owed game does.
      let query = trx
        .selectFrom('game_stats_state')
        .select(['game_id', 'requested_generation'])
        .whereRef('requested_generation', '>', 'built_generation')
        .where(eb =>
          eb.or([eb('retry_at', 'is', null), eb('retry_at', '<=', now)])
        )
        .where(eb =>
          eb.or([
            eb('built_at', 'is', null),
            eb('built_at', '<=', gapStart),
            eb(statusOfGame, '=', 'final')
          ])
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
          hashtext(${gameStatsLock(gameId)})
        ) as locked
      `.execute(trx)
      if (!lock.rows[0]?.locked) {
        return { kind: 'skipped' as const, gameId }
      }

      const game = await trx
        .selectFrom('games')
        .select(['home_team_id', 'away_team_id', 'currentPlay'])
        .where('id', '=', gameId)
        .executeTakeFirst()
      if (game == null) {
        throw new Error(`game ${gameId} not found`)
      }

      const eventRows = await trx
        .selectFrom('events')
        .select(['gumbo', 'atBatIndex'])
        .where('gameId', '=', gameId)
        .orderBy('atBatIndex', 'asc')
        .execute()
      // Reopened at-bats retain their event identity and annotations. Their
      // previous completed result is no longer part of the game's statistics.
      const openIndex = (game.currentPlay as CurrentPlay | null)?.about
        ?.atBatIndex
      const plays = eventRows
        .filter(row => row.atBatIndex !== openIndex)
        .map(row => row.gumbo as GumboPlay)

      const named = namedPlayerIds(plays)
      const knownUsers = new Set<number>()
      if (named.length > 0) {
        const users = await trx
          .selectFrom('gumbo_ids')
          .select('gumbo_id')
          .where('gumbo_id', 'in', named)
          .execute()
        for (const user of users) knownUsers.add(user.gumbo_id)
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
        await writePlateAppearances(trx, gameId, [])
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

      const charges: ChargedPlay[] = []
      const result = expandedGameStatLines(plays, teams, knownUsers, play => {
        charges.push(play)
      })
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
            gumbo_id: line.gumboId,
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
            extra: JSON.stringify(line.extra),
            computed_at: now.toISOString()
          })
          .execute()
      }
      await writePlateAppearances(trx, gameId, rowsOf(plays, charges))
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
    // No connection says nothing about the game: it stays owed, with no attempt
    // counted, and whoever drains asks again.
    if (isConnectionUnavailable(error)) throw error
    console.error(`stats builder: game ${picked.gameId} failed`, error)
    const message = error instanceof Error ? error.message : String(error)
    await markFailed(db, picked.gameId, picked.gen, message, clock)
    return { kind: 'failed' }
  }
}

/** A game's plate appearances, in place of the ones it had. */
export async function writePlateAppearances(
  db: Kysely<Database>,
  gameId: string,
  rows: PlateAppearance[]
): Promise<void> {
  await db
    .deleteFrom('plate_appearances')
    .where('game_id', '=', gameId)
    .execute()
  if (rows.length === 0) return
  await db
    .insertInto('plate_appearances')
    .values(
      rows.map(row => ({
        id: makeId('plateAppearance'),
        game_id: gameId,
        is_pa: row.isPa,
        at_bat_index: row.atBatIndex,
        inning: row.inning,
        half_inning: row.halfInning,
        batter_gumbo_id: row.batterGumboId,
        pitcher_gumbo_id: row.pitcherGumboId,
        batting_team_id: row.battingTeamId,
        pitching_team_id: row.pitchingTeamId,
        outs_before: row.outsBefore,
        on_first: row.onFirst,
        on_second: row.onSecond,
        on_third: row.onThird,
        first_pitch: row.firstPitch,
        pitches: row.pitches,
        first_pitch_thrown: row.firstPitchThrown,
        pitches_thrown: row.pitchesThrown,
        ab: row.ab,
        h: row.h,
        singles: row.singles,
        doubles: row.doubles,
        triples: row.triples,
        hr: row.hr,
        bb: row.bb,
        k: row.k,
        hbp: row.hbp,
        ci: row.ci,
        sf: row.sf,
        sh: row.sh,
        rbi: row.rbi,
        outs_made: row.outsMade
      }))
    )
    .execute()
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

/**
 * The earliest future moment a game still owed may build, or null: its
 * `retry_at`, or for a game not yet final the end of the gap after its last
 * build began, whichever is later.
 */
export async function earliestRetryAt(
  db: Kysely<Database>,
  clock: Clock
): Promise<Date | null> {
  const now = clock()
  const gapStart = new Date(now.getTime() - BUILD_GAP_MS)
  // The gap holds only a game built in the last few seconds and not final;
  // its status is looked up for that game alone. A game never built has a
  // null `built_at`, which must read as false here, or the null would make
  // `and` ask every such game's status.
  const inGap = sql<boolean>`(coalesce(game_stats_state.built_at > ${gapStart}, false)
    and ${statusOfGame} <> 'final')`
  const opens = sql<Date | null>`greatest(
    game_stats_state.retry_at,
    case when ${inGap}
      then game_stats_state.built_at + make_interval(secs => ${BUILD_GAP_MS / 1000})
    end
  )`
  const row = await db
    .selectFrom('game_stats_state')
    .select(eb => eb.fn.min(opens).as('next'))
    .whereRef('requested_generation', '>', 'built_generation')
    .where(eb => eb.or([eb('retry_at', '>', now), eb(inGap, '=', true)]))
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
