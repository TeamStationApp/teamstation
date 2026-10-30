import { type Expression, type Kysely, sql, type SqlBool } from 'kysely'

import { inningsPitched } from '../../common/statExtras'
import { visibleGamesWhere, type VisibleScopes } from '../access'
import { survivorsOf } from '../admin/people'
import type { Database } from '../db/database'
import { publicNames } from '../groups/playerNamePrivacy'
import { battingRates, DEFAULT_ERA_INNINGS, pitchingRates } from '../stats'

/**
 * Stats split by anything a plate appearance records, worked out in one SQL
 * query over `plate_appearances`: by player, team, opponent, season or game,
 * home or away, the outs and the runners each began with, and how its first
 * pitch went, from the batter's side or the pitcher's.
 *
 * A line counts only games the caller may open, by the same rule as the
 * stats routes (`visibleGamesWhere`): a site administrator's covers every
 * game, and a person's own figures, or a guardian's child's, cover every
 * game they played (`allGames`), as on the player stats page. Players are
 * their merge survivors, named by their short name.
 */

export type SplitPerspective = 'batting' | 'pitching'
export type SplitGroup =
  | 'player'
  | 'team'
  | 'opponent'
  | 'season'
  | 'game'
  | 'side'
  | 'outs'
  | 'runners'
  | 'firstPitch'
/** Who was on base: nobody, first alone, a runner in scoring position short of loaded, or loaded. */
export type RunnersState = 'empty' | 'first' | 'scoringPosition' | 'loaded'

export interface SplitFilter {
  /** The player's user ids, every merged row of each. */
  userIds?: string[]
  /** The batting side's team, or the pitching side's when pitching. */
  teamId?: string
  opponentId?: string
  seasonId?: string
  /** Games starting at or after this time, and before `to`. */
  from?: Date
  to?: Date
  side?: 'home' | 'away'
  /** Outs when the plate appearance began, any of these. */
  outs?: number[]
  /** `any` is anybody on; `scoringPosition` anybody on second or third. */
  runners?: 'empty' | 'any' | 'scoringPosition' | 'loaded'
  firstPitch?: 'ball' | 'strike' | 'inPlay' | 'other'
}

export interface SplitKey {
  userId?: string | null
  shortName?: string | null
  teamId?: string | null
  teamName?: string | null
  opponentId?: string | null
  opponentName?: string | null
  seasonId?: string | null
  seasonName?: string | null
  gameId?: string | null
  side?: 'home' | 'away' | null
  outs?: number | null
  runners?: RunnersState | null
  firstPitch?: 'ball' | 'strike' | 'inPlay' | 'other' | null
}

export interface SplitCounts {
  games: number
  pa: number
  ab: number
  h: number
  singles: number
  doubles: number
  triples: number
  hr: number
  bb: number
  k: number
  hbp: number
  ci: number
  sf: number
  sh: number
  rbi: number
  outsMade: number
  pitches: number
  /** Plate appearances with their pitches recorded. */
  pitchedPa: number
  /** Plate appearances whose first pitch was recorded, and how it went. */
  firstPitchKnown: number
  firstPitchBalls: number
  firstPitchStrikes: number
  firstPitchInPlay: number
}

export interface SplitRates {
  avg: number | null
  obp: number | null
  slg: number | null
  ops: number | null
  /** Of every plate appearance. */
  kRate: number | null
  bbRate: number | null
  /** Innings pitched, as 5.2, from the outs made. */
  ip: string
  whip: number | null
  /** Of plate appearances whose first pitch was recorded; strikes include balls put in play. */
  firstPitchStrikeRate: number | null
  firstPitchBallRate: number | null
  pitchesPerPa: number | null
}

export type SplitRow = SplitKey & SplitCounts & SplitRates

export type SplitOrder = keyof SplitCounts | keyof SplitRates

export interface SplitQuery {
  perspective: SplitPerspective
  filter?: SplitFilter
  groupBy?: SplitGroup[]
  /** Highest first unless `ascending`; plate appearances when not given. */
  orderBy?: SplitOrder
  ascending?: boolean
  limit: number
  /** Every game of the filtered player's, not only those the caller may open. */
  allGames?: boolean
}

const COUNTS = [
  'ab',
  'h',
  'singles',
  'doubles',
  'triples',
  'hr',
  'bb',
  'k',
  'hbp',
  'ci',
  'sf',
  'sh',
  'rbi'
] as const

const round3 = (value: number): number => Math.round(value * 1000) / 1000
const ratio = (part: number, whole: number): number | null =>
  whole > 0 ? round3(part / whole) : null

/**
 * The rates a line's counts give: the batting and pitching rates by the
 * stats routes' own functions, and the rates only splits have.
 */
export function splitRates(c: SplitCounts): SplitRates {
  const batting = battingRates({
    roe: null,
    fc: null,
    pik: null,
    firstPa: null,
    userId: '',
    teamId: null,
    g: c.games,
    pa: c.pa,
    ab: c.ab,
    h: c.h,
    singles: c.singles,
    doubles: c.doubles,
    triples: c.triples,
    hr: c.hr,
    bb: c.bb,
    k: c.k,
    r: 0,
    rbi: c.rbi,
    hbp: c.hbp,
    sb: 0,
    cs: 0,
    sf: c.sf,
    sh: c.sh
  })
  const pitching = pitchingRates({
    gs: null,
    pitches: null,
    kl: null,
    pitchAb: null,
    wp: null,
    lob: null,
    bk: null,
    pik: null,
    cs: null,
    sb: null,
    userId: '',
    teamId: null,
    g: c.games,
    outs: c.outsMade,
    bf: c.pa,
    h: c.h,
    hr: c.hr,
    hbp: c.hbp,
    r: 0,
    er: 0,
    bb: c.bb,
    k: c.k,
    eraInnings: DEFAULT_ERA_INNINGS
  })
  return {
    avg: batting.avg ?? null,
    obp: batting.obp ?? null,
    slg: batting.slg ?? null,
    ops: batting.ops ?? null,
    kRate: ratio(c.k, c.pa),
    bbRate: ratio(c.bb, c.pa),
    ip: inningsPitched(c.outsMade),
    whip: pitching.whip ?? null,
    firstPitchStrikeRate: ratio(
      c.firstPitchStrikes + c.firstPitchInPlay,
      c.firstPitchKnown
    ),
    firstPitchBallRate: ratio(c.firstPitchBalls, c.firstPitchKnown),
    pitchesPerPa: ratio(c.pitches, c.pitchedPa)
  }
}

/** How long one split's query may run in Postgres, inside a query's 25 s. */
export const STATEMENT_TIMEOUT_MS = 20000

/** Lines a split may have before it is refused: group by less, or filter. */
export const MAX_FETCHED = 20000

export class TooManyLines extends Error {
  constructor() {
    super(
      `This split has more than ${MAX_FETCHED} lines. Filter it, or group by less`
    )
  }
}

/** The lines `query` asks for, in its order, at most its limit. */
export async function statSplits(
  db: Kysely<Database>,
  scopes: VisibleScopes,
  query: SplitQuery
): Promise<SplitRow[]> {
  const filter = query.filter ?? {}
  const groups = new Set(query.groupBy ?? [])
  const pitching = query.perspective === 'pitching'
  if (filter.userIds?.length === 0) return []

  const person = pitching
    ? sql.ref('plate_appearances.pitcher_gumbo_id')
    : sql.ref('plate_appearances.batter_gumbo_id')
  const team = pitching
    ? sql.ref('plate_appearances.pitching_team_id')
    : sql.ref('plate_appearances.batting_team_id')
  const opponent = pitching
    ? sql.ref('plate_appearances.batting_team_id')
    : sql.ref('plate_appearances.pitching_team_id')
  const side = sql<'home' | 'away' | null>`case
    when ${team} = games.home_team_id then 'home'
    when ${team} = games.away_team_id then 'away'
    end`
  // The batter's first pitch and pitches, or the pitcher's: the ones he
  // threw.
  const firstPitchColumn = pitching
    ? sql.ref('plate_appearances.first_pitch_thrown')
    : sql.ref('plate_appearances.first_pitch')
  const pitchesColumn = pitching
    ? sql.ref('plate_appearances.pitches_thrown')
    : sql.ref('plate_appearances.pitches')
  const runners = sql<RunnersState | null>`case
    when plate_appearances.on_first is null then null
    when plate_appearances.on_first and plate_appearances.on_second and plate_appearances.on_third then 'loaded'
    when plate_appearances.on_second or plate_appearances.on_third then 'scoringPosition'
    when plate_appearances.on_first then 'first'
    else 'empty' end`

  let q = db
    .selectFrom('plate_appearances')
    .innerJoin('games', 'games.id', 'plate_appearances.game_id')
    .leftJoin('gumbo_ids', join =>
      join.on(sql<SqlBool>`gumbo_ids.gumbo_id = ${person}`)
    )
    .select([
      sql<number>`count(distinct plate_appearances.game_id)::int`.as('games'),
      sql<number>`count(*) filter (where plate_appearances.is_pa)::int`.as(
        'pa'
      ),
      ...COUNTS.map(name =>
        sql<number>`coalesce(sum(plate_appearances.${sql.ref(name)}), 0)::int`.as(
          name
        )
      ),
      sql<number>`coalesce(sum(plate_appearances.outs_made), 0)::int`.as(
        'outsMade'
      ),
      sql<number>`coalesce(sum(${pitchesColumn}), 0)::int`.as('pitches'),
      // The batter's view on either side: a pitcher's plate appearances are
      // those charged to him, a reliever's pitches to another's are not.
      sql<number>`count(*) filter (where plate_appearances.is_pa and plate_appearances.pitches > 0)::int`.as(
        'pitchedPa'
      ),
      sql<number>`count(${firstPitchColumn})::int`.as('firstPitchKnown'),
      sql<number>`count(*) filter (where ${firstPitchColumn} = 'ball')::int`.as(
        'firstPitchBalls'
      ),
      sql<number>`count(*) filter (where ${firstPitchColumn} = 'strike')::int`.as(
        'firstPitchStrikes'
      ),
      sql<number>`count(*) filter (where ${firstPitchColumn} = 'inPlay')::int`.as(
        'firstPitchInPlay'
      )
    ])

  const grouped: Array<Expression<unknown>> = []
  if (groups.has('player')) {
    q = q.select(sql<string | null>`gumbo_ids.user_id`.as('userId'))
    grouped.push(sql`gumbo_ids.user_id`)
  }
  if (groups.has('team')) {
    q = q.select(team.as('teamId'))
    grouped.push(team)
  }
  if (groups.has('opponent')) {
    q = q.select(opponent.as('opponentId'))
    grouped.push(opponent)
  }
  if (groups.has('season')) {
    q = q.select('games.season_id as seasonId')
    grouped.push(sql`games.season_id`)
  }
  if (groups.has('game')) {
    q = q.select('plate_appearances.game_id as gameId')
    grouped.push(sql`plate_appearances.game_id`)
  }
  if (groups.has('side')) {
    q = q.select(side.as('side'))
    grouped.push(side)
  }
  if (groups.has('outs')) {
    q = q.select('plate_appearances.outs_before as outs')
    grouped.push(sql`plate_appearances.outs_before`)
  }
  if (groups.has('runners')) {
    q = q.select(runners.as('runners'))
    grouped.push(runners)
  }
  if (groups.has('firstPitch')) {
    q = q.select(firstPitchColumn.as('firstPitch'))
    grouped.push(firstPitchColumn)
  }

  const allowed =
    query.allGames === true ? undefined : visibleGamesWhere(scopes)
  if (allowed != null) q = q.where(allowed)
  // A batter's line is his plate appearances, and a run he batted in on
  // another's (a pinch hitter's on a strikeout); rows of outs alone and of
  // pitches are the pitchers'.
  if (!pitching)
    q = q.where(
      sql<SqlBool>`(plate_appearances.is_pa or plate_appearances.batter_gumbo_id is not null)`
    )
  if (filter.userIds != null)
    q = q.where('gumbo_ids.user_id', 'in', filter.userIds)
  if (filter.teamId != null)
    q = q.where(sql<SqlBool>`${team} = ${filter.teamId}`)
  if (filter.opponentId != null)
    q = q.where(sql<SqlBool>`${opponent} = ${filter.opponentId}`)
  if (filter.seasonId != null)
    q = q.where('games.season_id', '=', filter.seasonId)
  if (filter.from != null) q = q.where('games.start_at', '>=', filter.from)
  if (filter.to != null) q = q.where('games.start_at', '<', filter.to)
  if (filter.side === 'home')
    q = q.where(sql<SqlBool>`${team} = games.home_team_id`)
  if (filter.side === 'away')
    q = q.where(sql<SqlBool>`${team} = games.away_team_id`)
  if (filter.outs != null)
    q =
      filter.outs.length === 0
        ? q.where(sql<SqlBool>`false`)
        : q.where('plate_appearances.outs_before', 'in', filter.outs)
  if (filter.runners === 'empty')
    q = q.where(
      sql<SqlBool>`not (plate_appearances.on_first or plate_appearances.on_second or plate_appearances.on_third)`
    )
  if (filter.runners === 'any')
    q = q.where(
      sql<SqlBool>`(plate_appearances.on_first or plate_appearances.on_second or plate_appearances.on_third)`
    )
  if (filter.runners === 'scoringPosition')
    q = q.where(
      sql<SqlBool>`(plate_appearances.on_second or plate_appearances.on_third)`
    )
  if (filter.runners === 'loaded')
    q = q.where(
      sql<SqlBool>`(plate_appearances.on_first and plate_appearances.on_second and plate_appearances.on_third)`
    )
  if (filter.firstPitch != null)
    q = q.where(sql<SqlBool>`${firstPitchColumn} = ${filter.firstPitch}`)
  // A line for nobody TeamStation knows is no one's: grouped by player, it
  // is left out rather than shown as a blank name.
  if (groups.has('player')) q = q.where('gumbo_ids.user_id', 'is not', null)
  if (grouped.length > 0) q = q.groupBy(grouped)

  const order = query.orderBy ?? 'pa'
  const sign = query.ascending === true ? 1 : -1
  // With no person to fold, a count can be ordered and cut in SQL, ties by
  // what the line is split by. Otherwise every line is read, up to a limit.
  const pushed =
    !groups.has('player') && (COUNT_NAMES as string[]).includes(order)
  if (pushed) {
    q = q.orderBy(sql.ref(order), sign < 0 ? 'desc' : 'asc')
    for (const expression of grouped) q = q.orderBy(expression)
    q = q.limit(query.limit)
  } else q = q.limit(MAX_FETCHED + 1)
  // Postgres gives up on the aggregate at the query's own deadline.
  const fetched = (
    await db.transaction().execute(async trx => {
      await sql`set local statement_timeout = ${sql.lit(STATEMENT_TIMEOUT_MS)}`.execute(
        trx
      )
      return await trx.executeQuery(q.compile())
    })
  ).rows as unknown as Array<SplitKey & SplitCounts>
  if (fetched.length > MAX_FETCHED) throw new TooManyLines()
  // An aggregate over nothing is one row of zeros, of no game: that is no
  // line. A line of outs alone, a reliever's pickoff, or of a pinch
  // hitter's run batted in, is still one.
  const rows = fetched.filter(row => row.games > 0)
  const folded = groups.has('player') ? await foldMerged(db, rows) : rows
  const rated = folded.map(row => ({ ...row, ...splitRates(row) }))
  // A stable order: by the figure, then by what the line is split by, so the
  // same query cuts the same lines.
  const keyOf = (row: SplitKey): string =>
    JSON.stringify(
      [
        row.userId,
        row.teamId,
        row.opponentId,
        row.seasonId,
        row.gameId,
        row.side,
        row.outs,
        row.runners,
        row.firstPitch
      ].map(value => value ?? '')
    )
  rated.sort((a, b) => {
    const x = a[order]
    const y = b[order]
    if (x !== y) {
      if (x == null) return 1
      if (y == null) return -1
      if (typeof x === 'number' && typeof y === 'number') return sign * (x - y)
      return sign * String(x).localeCompare(String(y))
    }
    return keyOf(a).localeCompare(keyOf(b))
  })
  // Only the lines returned are named.
  return await named(db, rated.slice(0, query.limit), filter)
}

/**
 * Rows of people since merged into one, added together under the survivor:
 * a person is one line, as on the stats routes.
 */
async function foldMerged(
  db: Kysely<Database>,
  rows: Array<SplitKey & SplitCounts>
): Promise<Array<SplitKey & SplitCounts>> {
  const survivors = await survivorsOf(
    db,
    rows.flatMap(row => (row.userId == null ? [] : [row.userId]))
  )
  const lines = new Map<string, SplitKey & SplitCounts>()
  for (const row of rows) {
    const userId =
      row.userId == null ? null : (survivors.get(row.userId) ?? row.userId)
    const keyed = { ...row, userId }
    const { games: _g, pa: _p, ...rest } = keyed
    const key = JSON.stringify(
      Object.fromEntries(
        Object.entries(rest).filter(([name]) => !isCount(name))
      )
    )
    const held = lines.get(key)
    if (held == null) {
      lines.set(key, keyed)
      continue
    }
    for (const name of COUNT_NAMES)
      (held as unknown as Record<string, number>)[name] += keyed[name]
  }
  return [...lines.values()]
}

const COUNT_NAMES: Array<keyof SplitCounts> = [
  'games',
  'pa',
  ...COUNTS,
  'outsMade',
  'pitches',
  'pitchedPa',
  'firstPitchKnown',
  'firstPitchBalls',
  'firstPitchStrikes',
  'firstPitchInPlay'
]
const isCount = (name: string): boolean =>
  (COUNT_NAMES as string[]).includes(name)

/** Each line's names: the player's short name, and the teams' and season's. */
async function named(
  db: Kysely<Database>,
  rows: Array<SplitKey & SplitCounts & SplitRates>,
  filter: SplitFilter
): Promise<SplitRow[]> {
  const userIds = [
    ...new Set(rows.flatMap(row => (row.userId == null ? [] : [row.userId])))
  ]
  const people =
    userIds.length === 0
      ? []
      : await db
          .selectFrom('users')
          .select([
            'id',
            'first_name as firstName',
            'last_name as lastName',
            'display_name as displayName'
          ])
          .where('id', 'in', userIds)
          .execute()
  const short = await publicNames(
    db,
    rows.flatMap(row => {
      const person = people.find(one => one.id === row.userId)
      return person == null
        ? []
        : [{ person, teamId: row.teamId ?? filter.teamId }]
    })
  )
  const teamIds = [
    ...new Set(
      rows.flatMap(row =>
        [row.teamId, row.opponentId].filter((id): id is string => id != null)
      )
    )
  ]
  const teams = new Map(
    teamIds.length === 0
      ? []
      : (
          await db
            .selectFrom('teams')
            .select(['id', 'name'])
            .where('id', 'in', teamIds)
            .execute()
        ).map(team => [team.id, team.name])
  )
  const seasonIds = [
    ...new Set(
      rows.flatMap(row => (row.seasonId == null ? [] : [row.seasonId]))
    )
  ]
  const seasons = new Map(
    seasonIds.length === 0
      ? []
      : (
          await db
            .selectFrom('seasons')
            .select(['id', 'name'])
            .where('id', 'in', seasonIds)
            .execute()
        ).map(season => [season.id, season.name])
  )
  return rows.map(row => ({
    ...row,
    ...(row.userId === undefined
      ? {}
      : {
          shortName: row.userId == null ? null : (short.get(row.userId) ?? null)
        }),
    ...(row.teamId === undefined
      ? {}
      : {
          teamName: row.teamId == null ? null : (teams.get(row.teamId) ?? null)
        }),
    ...(row.opponentId === undefined
      ? {}
      : {
          opponentName:
            row.opponentId == null ? null : (teams.get(row.opponentId) ?? null)
        }),
    ...(row.seasonId === undefined
      ? {}
      : {
          seasonName:
            row.seasonId == null ? null : (seasons.get(row.seasonId) ?? null)
        })
  }))
}
