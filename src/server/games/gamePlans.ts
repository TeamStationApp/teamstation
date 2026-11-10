import { type Kysely, type Selectable, sql } from 'kysely'

import type { SidePlan } from '../../common/api'
import {
  asGamePlan,
  type GamePlan,
  planHasPositions,
  planPlayerKey
} from '../../common/gamePlan'
import type { PlanSameDay } from '../../common/planWarnings'
import type { PlayingTimeRules } from '../../common/playingTimeRules'
import { atomic } from '../db/atomic'
import type { Database, GamePlansTable, GamesTable } from '../db/database'
import {
  managingSeasonRules,
  storedPlayingTimeRules
} from '../groups/publicSummary'
import { notifyGameChange } from '../socket/gameChanges'

/** The fields of a game its plans are read and judged by. */
export type PlanGame = Pick<
  Selectable<GamesTable>,
  'id' | 'season_id' | 'start_at' | 'timezone'
>

type StoredPlan = Pick<
  Selectable<GamePlansTable>,
  'enabled' | 'innings' | 'rows'
>

/**
 * A stored row as the plan it holds, cleaned as a save is: on when it holds
 * a position, and a `-` from before the bench was blank read as blank.
 */
const planOf = (row: StoredPlan): GamePlan =>
  asGamePlan({ enabled: row.enabled, innings: row.innings, rows: row.rows })

/**
 * The Playing Time Rules a team's plan in this game is judged by: the team's
 * own set; else the set of the game's own season, so a team in a spring and
 * a fall season judges each game by its season's; else the set of the
 * managing season the team follows on its settings screen; else none.
 */
async function rulesFor(
  db: Kysely<Database>,
  game: PlanGame,
  teamId: string
): Promise<PlayingTimeRules | null> {
  // The team's and the season's together; the managing season's only when
  // neither has a set.
  const [team, season] = await Promise.all([
    db
      .selectFrom('teams')
      .select('playing_time_rules')
      .where('id', '=', teamId)
      .executeTakeFirstOrThrow(),
    game.season_id == null
      ? undefined
      : db
          .selectFrom('seasons')
          .select('playing_time_rules')
          .where('id', '=', game.season_id)
          .executeTakeFirst()
  ])
  return (
    storedPlayingTimeRules(team.playing_time_rules) ??
    storedPlayingTimeRules(season?.playing_time_rules) ??
    (await managingSeasonRules(db, teamId))?.rules ??
    null
  )
}

/**
 * The innings a plan's game reached, from its line score, as `reached`:
 * null when the game has no innings scored.
 */
const reachedInnings = sql<number | null>`nullif(case
  when jsonb_typeof(games.linescore->'innings') = 'array'
  then jsonb_array_length(games.linescore->'innings') end, 0)`.as('reached')

/**
 * A plan cut to the innings its game reached, when the game's line score
 * says (a game shortened by a mercy rule, time or weather plays fewer than
 * were planned); as planned when the game has no innings scored.
 */
const playedPlan = (plan: GamePlan, reached: number | null): GamePlan =>
  reached == null || reached >= plan.innings
    ? plan
    : {
        ...plan,
        innings: reached,
        rows: plan.rows.map(row => ({
          ...row,
          cells: row.cells.slice(0, reached)
        }))
      }

/**
 * The team's plans in its other games on this game's calendar date, read in
 * this game's time zone, whatever their season, cancelled games aside, each
 * cut to the innings its game reached (`playedPlan`). A game starts before
 * this one when its `start_at` is earlier, or, at the same `start_at`, when
 * its id sorts first. Of the games before it: each player's catcher innings
 * across them; of the games after it: whether he pitches in any. Only
 * players who do are named.
 */
async function sameDayFor(
  db: Kysely<Database>,
  game: PlanGame,
  teamId: string
): Promise<PlanSameDay> {
  const sameDay: PlanSameDay = {
    before: { catcherInnings: {} },
    laterPitched: {}
  }
  const others = await db
    .selectFrom('game_plans')
    .innerJoin('games', 'games.id', 'game_plans.game_id')
    .select([
      'games.id',
      'games.start_at',
      'game_plans.enabled',
      'game_plans.innings',
      'game_plans.rows',
      reachedInnings
    ])
    .where('game_plans.team_id', '=', teamId)
    .where('game_plans.game_id', '!=', game.id)
    .where('games.status', '!=', 'cancelled')
    .where(
      sql<boolean>`(games.start_at at time zone ${game.timezone})::date
        = (${game.start_at}::timestamptz at time zone ${game.timezone})::date`
    )
    .execute()
  const start = game.start_at.getTime()
  for (const stored of others) {
    const at = stored.start_at.getTime()
    // At one start time, the id first by code unit starts first.
    const before = at < start || (at === start && stored.id < game.id)
    const { catcherInnings } = sameDay.before
    for (const row of playedPlan(planOf(stored), stored.reached).rows) {
      const key = planPlayerKey(row.player)
      if (!before) {
        if (row.cells.includes('P')) sameDay.laterPitched[key] = true
        continue
      }
      const caught = row.cells.filter(cell => cell === 'C').length
      if (caught > 0) catcherInnings[key] = (catcherInnings[key] ?? 0) + caught
    }
  }
  return sameDay
}

/**
 * One team's side of a game's plans: its stored plan, or null before one is
 * saved, with the rules and same-day load its warnings are judged by.
 */
export async function loadSidePlan(
  db: Kysely<Database>,
  game: PlanGame,
  teamId: string
): Promise<SidePlan> {
  // Each read is its own, so they go out together.
  const [stored, rules, sameDay] = await Promise.all([
    db
      .selectFrom('game_plans')
      .select(['enabled', 'innings', 'rows'])
      .where('game_id', '=', game.id)
      .where('team_id', '=', teamId)
      .executeTakeFirst(),
    rulesFor(db, game, teamId),
    sameDayFor(db, game, teamId)
  ])
  return {
    teamId,
    plan: stored == null ? null : planOf(stored),
    rules,
    sameDay
  }
}

/**
 * Stores a team's plan in a game in place of any it had, as `userId` saved
 * it, and announces it to the game's viewers when the save commits. It is
 * stored on when any cell holds a position (`planHasPositions`), whatever
 * `enabled` says. An all-blank plan is stored, off, like any other: there is
 * no delete.
 */
export async function saveGamePlan(
  db: Kysely<Database>,
  game: PlanGame,
  teamId: string,
  plan: GamePlan,
  userId: string
): Promise<void> {
  const values = {
    enabled: planHasPositions(plan),
    innings: plan.innings,
    // jsonb from text: an array would be sent as a Postgres array.
    rows: JSON.stringify(plan.rows),
    updated_at: new Date(),
    updated_by: userId
  }
  await atomic(db, async trx => {
    await trx
      .insertInto('game_plans')
      .values({ game_id: game.id, team_id: teamId, ...values })
      .onConflict(oc => oc.columns(['game_id', 'team_id']).doUpdateSet(values))
      .execute()
    await notifyGameChange(trx, { game: game.id, kind: 'plans', teamId })
  })
}
