import type { Insertable } from 'kysely'

import type { GamesTable } from '../server/db/database'
import { schedulingTeams } from '../server/scheduler/setup'
import type { GroupFixture } from './groupFixtures'

/**
 * A season of 400 games whose ids, names and times are fixed, so the answers
 * read from it can be saved once and compared byte for byte by later code.
 */
export const answersSeason = 'sea_seasonAnswers01'
export const ANSWER_GAMES = 400

const team = (n: number): string =>
  `tem_seasonAnswers${String(n).padStart(2, '0')}`
/** The teams whose games make up the season's bulk. */
const regulars = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 15]

/**
 * Twelve active members, one of them flagged; a member flagged as not an
 * exhibition team with no games; a former member with games; two teams only
 * in parents; a flagged external team; a team whose only non-exhibition game
 * is cancelled and one whose only game is; a team with only scheduled
 * exhibitions; a merged team with results; a team with only a game in
 * progress. Games cover exhibitions, ties, cancelled games with scores,
 * scheduled and live games, a final with a missing score, and shared start
 * times.
 */
export async function seasonAnswersFixture(f: GroupFixture): Promise<void> {
  const db = f.h.db
  await db
    .insertInto('seasons')
    .values({
      id: answersSeason,
      league_id: f.leagueA,
      name: 'Answers Regular',
      year: 2027,
      starts_on: '2027-03-01',
      ends_on: '2027-05-31'
    })
    .execute()
  const names: Record<number, string> = {
    1: 'Answers Aces',
    2: 'Answers Bats',
    3: 'Answers Cubs',
    4: 'Answers Cubs',
    5: 'Answers Dogs',
    6: 'Answers Elks',
    7: 'Answers Foxes',
    8: 'Answers Gulls',
    9: 'Answers Hens',
    10: 'Answers Ibis',
    11: 'Answers Jays',
    12: 'Answers Kites',
    13: 'Answers Lynx',
    14: 'Answers Moles',
    15: 'Answers Newts',
    16: 'Answers Owls',
    17: 'Answers Pikes',
    18: 'Answers Quail',
    19: 'Answers Rams',
    20: 'Answers Seals',
    21: 'Answers Terns',
    22: 'Answers Urchins',
    23: 'Answers Voles'
  }
  await db
    .insertInto('teams')
    .values(
      Object.entries(names).map(([n, name]) => ({
        id: team(Number(n)),
        name,
        short_name: Number(n) % 4 === 0 ? name.slice(8, 11) : null,
        kind: [18, 21].includes(Number(n)) ? 'external' : 'full',
        // A season's parented teams share its league.
        league_id: [16, 17].includes(Number(n)) ? f.leagueA : null
      }))
    )
    .execute()
  await db
    .updateTable('teams')
    .set({ merged_into: team(1) })
    .where('id', '=', team(22))
    .execute()
  await db
    .insertInto('season_teams')
    .values([
      ...[1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14].map(n => ({
        season_id: answersSeason,
        team_id: team(n)
      })),
      { season_id: answersSeason, team_id: team(15), active: false }
    ])
    .execute()
  await db
    .insertInto('season_team_parents')
    .values([16, 17].map(n => ({ season_id: answersSeason, team_id: team(n) })))
    .execute()
  await db
    .insertInto('season_team_flags')
    .values([
      { season_id: answersSeason, team_id: team(13), exhibition: true },
      { season_id: answersSeason, team_id: team(14), exhibition: false },
      { season_id: answersSeason, team_id: team(18), exhibition: true }
    ])
    .execute()
  const start = Date.parse('2027-03-01T18:00:00Z')
  const at = (hours: number): Date => new Date(start + hours * 3_600_000)
  const special: Array<
    [
      number,
      number,
      Insertable<GamesTable>['status'],
      boolean,
      number | null,
      number | null
    ]
  > = [
    [17, 18, 'final', true, 4, 2],
    [18, 1, 'final', true, 3, 3],
    [17, 21, 'scheduled', true, null, null],
    [19, 2, 'cancelled', false, 5, 0],
    [19, 3, 'final', true, 1, 6],
    [20, 4, 'cancelled', false, null, null],
    [5, 21, 'scheduled', true, null, null],
    [22, 6, 'final', false, 2, 7],
    [7, 22, 'final', false, 4, 4],
    [23, 8, 'inProgress', false, 1, 0]
  ]
  const games: Array<Insertable<GamesTable>> = special.map(
    ([home, away, status, exhibition, homeScore, awayScore], i) => ({
      id: `gam_seasonAnswers${String(i).padStart(3, '0')}`,
      season_id: answersSeason,
      home_team_id: team(home),
      away_team_id: team(away),
      start_at: at(i * 7),
      status,
      exhibition,
      home_score: homeScore,
      away_score: awayScore,
      cancellation_reason: status === 'cancelled' ? 'weather' : null
    })
  )
  for (let i = games.length; i < ANSWER_GAMES; i++) {
    const home = regulars[i % regulars.length]
    const away =
      regulars[
        (i + 1 + (Math.floor(i / regulars.length) % (regulars.length - 1))) %
          regulars.length
      ]
    const kind = i % 20
    const status =
      kind === 0
        ? 'scheduled'
        : kind === 1
          ? 'cancelled'
          : kind === 2
            ? 'inProgress'
            : 'final'
    games.push({
      // Ids that do not sort with the start times, two games to each time.
      id: `gam_seasonAnswers${String((i * 37) % 1000).padStart(3, '0')}`,
      season_id: answersSeason,
      home_team_id: team(home),
      away_team_id: team(away),
      start_at: at(Math.floor(i / 2)),
      status,
      exhibition: i % 11 === 0,
      home_score: kind === 0 ? null : (i * 7) % 9,
      away_score: kind === 0 || kind === 3 ? null : (i * 5) % 9,
      cancellation_reason: status === 'cancelled' ? 'weather' : null
    })
  }
  await db.insertInto('games').values(games).execute()
}

/**
 * The season's answers as their raw bodies: the teams route as two readers,
 * standings with and without exhibitions, and scheduler setup's teams.
 * `prefix` puts the routes under another mount.
 */
export async function seasonAnswers(
  f: GroupFixture,
  prefix = ''
): Promise<Record<string, string>> {
  const answers: Record<string, string> = {}
  for (const [path, user] of [
    [`/seasons/${answersSeason}/teams`, 101],
    [`/seasons/${answersSeason}/teams`, 105],
    [`/seasons/${answersSeason}/standings`, 101],
    [`/seasons/${answersSeason}/standings?includeExhibitions=true`, 101],
    [`/seasons/${answersSeason}/standings?includeExhibitions=false`, 101]
  ] as const) {
    const response = await f.h.request(
      'GET',
      `${prefix}${path}`,
      undefined,
      user
    )
    if (response.status !== 200)
      throw new Error(`${path} as ${user}: ${response.status}`)
    answers[`GET ${path} as ${user}`] = await response.text()
  }
  answers.schedulingTeams = JSON.stringify(
    await schedulingTeams(f.h.db, answersSeason)
  )
  return answers
}
