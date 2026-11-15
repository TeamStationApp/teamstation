import { type Kysely, type Selectable, sql } from 'kysely'

import type { SidePlan } from '../../common/api'
import {
  asGamePlan,
  type GamePlan,
  planColumn,
  type PlanColumnCell,
  planHasPositions,
  planPlayerKey
} from '../../common/gamePlan'
import type { PlanSameDay } from '../../common/planWarnings'
import type { PlayingTimeRules } from '../../common/playingTimeRules'
import { atomic } from '../db/atomic'
import type { Database, GamePlansTable, GamesTable } from '../db/database'
import { atBatInProgress } from '../events/atBatInProgress'
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
 * What a game's plans are opened by during play: its status, its start
 * time, and the inning in play, from the at-bat it stores (`atBatInProgress`,
 * the pregame being the 1st). The scoring document posts that at-bat with
 * its inning even when no batter is up (`current(null)`), so a live game
 * always has one; a final game has none.
 */
export interface PlanGameState {
  status: Selectable<GamesTable>['status']
  startAt: Date
  inning: number | null
}

export async function planGameState(
  db: Kysely<Database>,
  gameId: string
): Promise<PlanGameState> {
  const row = await db
    .selectFrom('games')
    .select([
      'status',
      'start_at',
      sql<string | null>`(${atBatInProgress()})->'about'->>'inning'`.as(
        'inning'
      )
    ])
    .where('id', '=', gameId)
    .executeTakeFirstOrThrow()
  const inning = row.inning == null ? null : Number(row.inning)
  return {
    status: row.status,
    startAt: row.start_at,
    inning: inning != null && Number.isInteger(inning) ? inning : null
  }
}

/**
 * The inning whose column a scorer may read now: the one in play, once the
 * game's start time has passed and while it is neither final nor cancelled.
 * Null otherwise, with why.
 */
export function openInning(
  state: PlanGameState,
  now: Date
):
  | { inning: number }
  | { refused: 'planNotStarted' | 'planGameOver' | 'planInningNotCurrent' } {
  if (state.startAt.getTime() > now.getTime())
    return { refused: 'planNotStarted' }
  if (state.status === 'final' || state.status === 'cancelled')
    return { refused: 'planGameOver' }
  if (state.inning == null) return { refused: 'planInningNotCurrent' }
  return { inning: state.inning }
}

/**
 * A team's column for one inning of its stored plan: every row, with that
 * inning's cell, by jersey (`planColumn`). Empty with no plan, a plan with
 * no position, or no such inning.
 */
export async function loadPlanInning(
  db: Kysely<Database>,
  gameId: string,
  teamId: string,
  inning: number
): Promise<PlanColumnCell[]> {
  const stored = await db
    .selectFrom('game_plans')
    .select(['enabled', 'innings', 'rows'])
    .where('game_id', '=', gameId)
    .where('team_id', '=', teamId)
    .executeTakeFirst()
  return stored == null ? [] : planColumn(planOf(stored), inning)
}

/** Whether two plans put any player in a different cell in `inning`. */
function inningChanged(
  before: GamePlan | null,
  after: GamePlan,
  inning: number
): boolean {
  const cellsOf = (plan: GamePlan | null): Map<string, string> =>
    new Map(
      plan == null
        ? []
        : planColumn(plan, inning).map(({ player, cell }) => [
            planPlayerKey(player),
            cell
          ])
    )
  const old = cellsOf(before)
  const now = cellsOf(after)
  for (const key of new Set([...old.keys(), ...now.keys()]))
    if ((old.get(key) ?? '') !== (now.get(key) ?? '')) return true
  return false
}

/**
 * Stores a team's plan in a game in place of any it had, as `userId` saved
 * it. It is stored on when any cell holds a position (`planHasPositions`),
 * whatever `enabled` says. An all-blank plan is stored, off, like any
 * other: there is no delete.
 *
 * The save is announced, when it commits, only when it changes the inning in
 * play of a game past its start time and not over (`openInning`): a scoring
 * screen then reads that inning's column again. A change to a later inning
 * is read when that inning starts, and announces nothing.
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
    // Saves of a game's plans go one at a time: each compares against the
    // plan the one before it committed, so none is announced against a row
    // already replaced.
    await trx
      .selectFrom('games')
      .select('id')
      .where('id', '=', game.id)
      .forUpdate()
      .executeTakeFirst()
    // One connection: the reads go in turn.
    const stored = await trx
      .selectFrom('game_plans')
      .select(['enabled', 'innings', 'rows'])
      .where('game_id', '=', game.id)
      .where('team_id', '=', teamId)
      .executeTakeFirst()
    const state = await planGameState(trx, game.id)
    await trx
      .insertInto('game_plans')
      .values({ game_id: game.id, team_id: teamId, ...values })
      .onConflict(oc => oc.columns(['game_id', 'team_id']).doUpdateSet(values))
      .execute()
    const open = openInning(state, new Date())
    if (
      'inning' in open &&
      inningChanged(stored == null ? null : planOf(stored), plan, open.inning)
    )
      await notifyGameChange(trx, {
        game: game.id,
        kind: 'plans',
        teamId,
        inning: open.inning
      })
  })
}
