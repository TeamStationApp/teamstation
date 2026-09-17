import { type Kysely, sql } from 'kysely'

import type { Database } from '../db/database'

/**
 * Joining two rows that are one real team.
 *
 * A scorekeeping service gives every club its own account and each club types
 * its opponents in by hand, so a team exists once as itself and again inside
 * every opponent's account under whatever name they used. `AAA Hawks` and `NP5
 * Hardy` are the same children.
 *
 * The important part is not the duplicate name, it is that **the two copies
 * hold different halves of the same game**. The club that kept score has the
 * plays; the club that filmed it has the video. Merging the teams is what lets
 * one game row have both.
 *
 * Identity is never inferred. Two teams playing at the same minute are usually
 * two different fixtures in the same league, and guessing would silently join
 * unrelated games. The caller names the pair.
 */

export interface MergeTeamsInput {
  /** The duplicate, usually the `external` one. */
  fromTeamId: string
  /** The team it really is. */
  intoTeamId: string
  /** Nothing is written unless this is true. */
  apply?: boolean
}

export interface MergedFixture {
  startAt: string
  /** The game that survives, because it knows the most. */
  keptGameId: string
  keptEvents: number
  /** The game folded into it. */
  retiredGameId: string
  retiredEvents: number
  /** How the two disagreed about who was at home, when they did. */
  orientationDiffers: boolean
  videosMoved: number
  externalIdsMoved: number
}

export interface MergeTeamsReport {
  fromTeamName: string
  intoTeamName: string
  applied: boolean
  /** Rows repointed at the surviving team, by table. */
  repointed: Record<string, number>
  fixtures: MergedFixture[]
  /** Events discarded with a retired game. Non-zero deserves a look. */
  eventsDiscarded: number
}

interface GameRow {
  id: string
  season_id: string | null
  home_team_id: string
  away_team_id: string
  start_at: Date
  events: number
}

/**
 * The same fixture, however the two clubs wrote it down.
 *
 * Same season, same minute, same two teams — **as an unordered pair**, because
 * the two accounts routinely disagree about who was at home. On 2026-05-20 one
 * said Hawks away at Black Widows and the other said Black Widows away at NP5
 * Hardy, which is the same game seen from two dugouts.
 */
function fixtureKey(game: GameRow): string {
  const pair = [game.home_team_id, game.away_team_id].sort().join('|')
  return `${game.season_id ?? ''}|${game.start_at.toISOString()}|${pair}`
}

export async function mergeTeams(
  db: Kysely<Database>,
  input: MergeTeamsInput
): Promise<MergeTeamsReport> {
  const { fromTeamId, intoTeamId, apply = false } = input
  if (fromTeamId === intoTeamId) {
    throw new Error('A team cannot be merged into itself')
  }

  const teams = await db
    .selectFrom('teams')
    .select(['id', 'name', 'merged_into'])
    .where('id', 'in', [fromTeamId, intoTeamId])
    .execute()
  const from = teams.find(team => team.id === fromTeamId)
  const into = teams.find(team => team.id === intoTeamId)
  if (from == null) throw new Error(`No team ${fromTeamId}`)
  if (into == null) throw new Error(`No team ${intoTeamId}`)
  if (into.merged_into != null) {
    throw new Error(
      `${into.name} has itself been merged into ${into.merged_into}; merge into that instead`
    )
  }

  const report: MergeTeamsReport = {
    fromTeamName: from.name,
    intoTeamName: into.name,
    applied: apply,
    repointed: {},
    fixtures: [],
    eventsDiscarded: 0
  }

  // Everything that names a team. The two rollups are left alone on purpose:
  // they are derived, and rebuilding them afterwards is both simpler and the
  // only way to be sure they agree with the games underneath.
  const references: Array<[string, string]> = [
    ['season_teams', 'team_id'],
    ['memberships', 'team_id'],
    ['games', 'home_team_id'],
    ['games', 'away_team_id'],
    ['events', 'batting_team_id'],
    ['event_players', 'team_id']
  ]

  for (const [table, column] of references) {
    const counted = await db
      .selectFrom(table as 'games')
      .select(expression => [expression.fn.countAll<string>().as('n')])
      .where(column as 'home_team_id', '=', fromTeamId)
      .executeTakeFirst()
    const n = Number(counted?.n ?? 0)
    if (n > 0) report.repointed[`${table}.${column}`] = n
  }

  const fixtures = await planFixtures(db, fromTeamId, intoTeamId)
  report.fixtures = fixtures
  report.eventsDiscarded = fixtures.reduce(
    (total, fixture) => total + fixture.retiredEvents,
    0
  )

  if (!apply) return report

  await db.transaction().execute(async trx => {
    for (const [table, column] of references) {
      await trx
        .updateTable(table as 'games')
        .set(Object.fromEntries([[column, intoTeamId]]) as never)
        .where(column as 'home_team_id', '=', fromTeamId)
        .execute()
    }

    // `memberships` and `season_teams` can now hold the same person or team
    // twice, and both have a unique constraint, so the duplicates go rather
    // than being left to fail the next insert. Plain SQL: a delete keyed on a
    // grouped minimum reads far better this way round than through the
    // builder, and it is the same statement either way.
    await sql`
      delete from memberships where id not in (
        select min(id) from memberships group by user_id, team_id
      )
    `.execute(trx)
    // `season_teams` has no id of its own — it is the pair — so the duplicate
    // is removed by keeping the earliest row for each pair instead.
    await sql`
      delete from season_teams a using season_teams b
      where a.season_id = b.season_id
        and a.team_id = b.team_id
        and a.joined_at > b.joined_at
    `.execute(trx)

    for (const fixture of fixtures) {
      // The video is the whole point: it lives on the game that was never
      // scored, and the plays live on the one that was never filmed.
      await trx
        .updateTable('videos')
        .set({ game_id: fixture.keptGameId })
        .where('game_id', '=', fixture.retiredGameId)
        .execute()

      await trx
        .updateTable('external_ids')
        .set({ entity_id: fixture.keptGameId })
        .where('entity_type', '=', 'game')
        .where('entity_id', '=', fixture.retiredGameId)
        .execute()

      // Its own events go with it. They are the thinner record by definition —
      // that is how the survivor was chosen — and keeping both would double
      // every play in the box score.
      await trx
        .deleteFrom('games')
        .where('id', '=', fixture.retiredGameId)
        .execute()
    }

    await trx
      .updateTable('teams')
      .set({ merged_into: intoTeamId })
      .where('id', '=', fromTeamId)
      .execute()
  })

  return report
}

/** Which fixtures exist twice once the two teams are treated as one. */
async function planFixtures(
  db: Kysely<Database>,
  fromTeamId: string,
  intoTeamId: string
): Promise<MergedFixture[]> {
  const rows = await db
    .selectFrom('games')
    .select(expression => [
      'games.id as id',
      'games.season_id as season_id',
      'games.home_team_id as home_team_id',
      'games.away_team_id as away_team_id',
      'games.start_at as start_at',
      expression
        .selectFrom('events')
        .select(inner => inner.fn.countAll<string>().as('n'))
        .whereRef('events.game_id', '=', 'games.id')
        .as('events'),
      expression
        .selectFrom('videos')
        .select(inner => inner.fn.countAll<string>().as('n'))
        .whereRef('videos.game_id', '=', 'games.id')
        .as('videos'),
      'games.away_score as away_score'
    ])
    .where(expression =>
      expression.or([
        expression('home_team_id', 'in', [fromTeamId, intoTeamId]),
        expression('away_team_id', 'in', [fromTeamId, intoTeamId])
      ])
    )
    .execute()

  // Group as the fixture would look *after* the merge.
  const asMerged = rows.map(row => ({
    id: row.id,
    season_id: row.season_id,
    home_team_id:
      row.home_team_id === fromTeamId ? intoTeamId : row.home_team_id,
    away_team_id:
      row.away_team_id === fromTeamId ? intoTeamId : row.away_team_id,
    start_at: new Date(row.start_at),
    events: Number(row.events ?? 0),
    videos: Number(row.videos ?? 0),
    scored: row.away_score != null,
    originalHome: row.home_team_id
  }))

  const groups = new Map<string, typeof asMerged>()
  for (const game of asMerged) {
    const key = fixtureKey(game)
    const list = groups.get(key) ?? []
    list.push(game)
    groups.set(key, list)
  }

  const fixtures: MergedFixture[] = []
  for (const list of groups.values()) {
    if (list.length < 2) continue

    // The richest record wins, and what counts as rich is decided here rather
    // than left to whatever order the rows arrived in.
    //
    // Events first: a game somebody actually scored is the one worth keeping,
    // and the orientation of its plays is the orientation the surviving row
    // must have — every event carries the score from its own game's point of
    // view, so adopting the other row's sides would mean rewriting all of them.
    //
    // Then videos, which decides the case that actually occurs: on 2026-05-16
    // both clubs scored the same game, 64 events each, and only one of them
    // filmed it. Equal records, so keep the one the highlights can be placed
    // on. Then a score, then the id, so the same input always gives the same
    // answer.
    const ordered = [...list].sort((a, b) => {
      if (a.events !== b.events) return b.events - a.events
      if (a.videos !== b.videos) return b.videos - a.videos
      if (a.scored !== b.scored) return a.scored ? -1 : 1
      return a.id.localeCompare(b.id)
    })
    const kept = ordered[0]
    for (const retired of ordered.slice(1)) {
      fixtures.push({
        startAt: kept.start_at.toISOString(),
        keptGameId: kept.id,
        keptEvents: kept.events,
        retiredGameId: retired.id,
        retiredEvents: retired.events,
        orientationDiffers: kept.originalHome !== retired.originalHome,
        videosMoved: await countOf(db, retired.id),
        externalIdsMoved: await countExternalIds(db, retired.id)
      })
    }
  }

  fixtures.sort((a, b) => a.startAt.localeCompare(b.startAt))
  return fixtures
}

async function countOf(db: Kysely<Database>, gameId: string): Promise<number> {
  const row = await db
    .selectFrom('videos')
    .select(expression => [expression.fn.countAll<string>().as('n')])
    .where('game_id', '=', gameId)
    .executeTakeFirst()
  return Number(row?.n ?? 0)
}

async function countExternalIds(
  db: Kysely<Database>,
  gameId: string
): Promise<number> {
  const row = await db
    .selectFrom('external_ids')
    .select(expression => [expression.fn.countAll<string>().as('n')])
    .where('entity_type', '=', 'game')
    .where('entity_id', '=', gameId)
    .executeTakeFirst()
  return Number(row?.n ?? 0)
}
