import {
  defaultFieldResolver,
  type FragmentDefinitionNode,
  getNamedType,
  getNullableType,
  GraphQLBoolean,
  GraphQLError,
  type GraphQLFieldConfig,
  GraphQLFloat,
  GraphQLID,
  GraphQLInt,
  GraphQLList,
  GraphQLNonNull,
  GraphQLObjectType,
  type GraphQLOutputType,
  GraphQLSchema,
  GraphQLString,
  isListType,
  Kind,
  type SelectionSetNode,
  type ValidationContext,
  type ValidationRule
} from 'graphql'

import { RestError, type RestReader } from './restReader'
import { type StatsContext, statsField } from './statsField'

/**
 * The read-only GraphQL API over teams, games, players, seasons and stat
 * lines. There is a query type and nothing else: no mutation and no
 * subscription, so a write cannot be expressed.
 *
 * Every field is resolved by reading the REST route that already serves it,
 * as the caller (`RestReader`), and taking what that route answered. So a
 * field holds exactly what the route gives this caller: the short name where
 * they may not see the full one, a game's non-member view, a stat line only
 * for a game they may open. A route that refuses becomes an error on the
 * field, which is then null. Account fields, sessions, tokens, settings and
 * the stats builder's status are no type here and cannot be asked for.
 */

export interface GraphqlContext extends StatsContext {
  reader: RestReader
  /** Fields this query has resolved so far; see `MAX_FIELDS`. */
  budget: { used: number }
  /** Aborted at the query's deadline, or when its caller leaves. */
  signal?: AbortSignal
}

/**
 * Fields one query may resolve. Depth and reads do not bound the answer: a
 * read is read once and then free, and `Team.games` and `Game.homeTeam` lead
 * back to each other, so an aliased cycle could build millions of objects
 * from a few dozen reads. A team's season of games with their box scores is
 * some thousands.
 */
export const MAX_FIELDS = 50000

/**
 * What a field gives once the query is over its budget: nothing, of its own
 * type, so the answer stops growing at once and with no error per field.
 * The route then refuses the whole query.
 */
function nothingOf(type: GraphQLOutputType): unknown {
  const bare = getNullableType(type)
  if (isListType(bare)) return []
  if (!(type instanceof GraphQLNonNull)) return null
  if (bare === GraphQLInt || bare === GraphQLFloat) return 0
  if (bare === GraphQLBoolean) return false
  if (bare === GraphQLString || bare === GraphQLID) return ''
  return {}
}

type Json = Record<string, unknown>

async function read<T = Json>(
  context: GraphqlContext,
  path: string,
  query?: Record<string, string | undefined>
): Promise<T> {
  return (await context.reader.get(path, query)) as T
}

/**
 * An id as one path segment. A URL drops a `.` or `..` segment, which would
 * read a different route, so neither is an id.
 */
const id = (value: string): string => {
  if (value === '.' || value === '..')
    throw new RestError(400, `${value} is not an id`)
  return encodeURIComponent(value)
}
const list = <T extends GraphQLOutputType>(
  type: T
): GraphQLList<GraphQLNonNull<T>> => new GraphQLList(new GraphQLNonNull(type))
const required = <T extends GraphQLOutputType>(type: T): GraphQLNonNull<T> =>
  new GraphQLNonNull(type)

/** A field read straight off its parent's JSON. */
const from = <T extends GraphQLOutputType>(
  type: T,
  description?: string
): { type: T; description?: string } => ({ type, description })

// --- Sources: what each type is resolved from ---------------------------

/** A team, by id, with what a listing already said of it. */
interface TeamSource {
  id: string
  listed?: {
    name?: string
    shortName?: string | null
    logoUrl?: string | null
    record?: unknown
  }
}
interface GameSource {
  id: string
  /** The team's schedule row it came from, when it came from one. */
  listed?: Json
}

/**
 * Fields a team's schedule row and the game route give everyone alike, so a
 * game from a schedule answers them without a read of its own. Notes,
 * arrival, ingest, scoring owner and the line score are not among them:
 * those always come from the game route, which withholds them from a
 * non-member.
 */
const LISTED_GAME_FIELDS = new Set([
  'startAt',
  'endAt',
  'timezone',
  'status',
  'exhibition',
  'isGameLive',
  'venue',
  'address',
  'homeScore',
  'awayScore',
  'cancellationReason',
  'homeTeamId',
  'homeTeamName',
  'homeLogoUrl',
  'awayTeamId',
  'awayTeamName',
  'awayLogoUrl'
])

/**
 * One side of a game, named as its schedule row or the game route names it.
 * A logo the row does not carry is left to the team's own route.
 */
async function sideOf(
  game: GameSource,
  side: 'home' | 'away',
  context: GraphqlContext
): Promise<TeamSource> {
  const row =
    game.listed?.[`${side}TeamId`] != null
      ? game.listed
      : await gameDetail(game, context)
  const logo = row[`${side}LogoUrl`] as string | null | undefined
  return {
    id: String(row[`${side}TeamId`]),
    listed: {
      name: row[`${side}TeamName`] as string,
      ...(logo === undefined ? {} : { logoUrl: logo })
    }
  }
}

/** A field of a game, from its schedule row where that carries it. */
async function gameValue(
  game: GameSource,
  name: string,
  context: GraphqlContext
): Promise<unknown> {
  if (
    game.listed != null &&
    LISTED_GAME_FIELDS.has(name) &&
    name in game.listed
  )
    return game.listed[name]
  return (await gameDetail(game, context))[name]
}
interface SeasonSource {
  id: string
  listed?: Json
}
/** A player, by id, with the name a list already gave them. */
interface PlayerSource {
  userId: string
  shortName?: string
}

const teamDetail = async (
  source: TeamSource,
  context: GraphqlContext
): Promise<Json> => await read(context, `/teams/${id(source.id)}`)
const gameDetail = async (
  source: GameSource,
  context: GraphqlContext
): Promise<Json> => await read(context, `/games/${id(source.id)}`)
const seasonDetail = async (
  source: SeasonSource,
  context: GraphqlContext
): Promise<Json> => await read(context, `/seasons/${id(source.id)}`)
const playerDetail = async (
  source: PlayerSource,
  context: GraphqlContext
): Promise<Json> => await read(context, `/players/${id(source.userId)}`)

const group = (detail: Json): Json => (detail.group ?? {}) as Json

// --- Stat lines ---------------------------------------------------------

const RecordType = new GraphQLObjectType({
  name: 'Record',
  description: 'Wins, losses and ties in a season.',
  fields: {
    wins: { type: GraphQLInt, resolve: (r: Json) => r.w },
    losses: { type: GraphQLInt, resolve: (r: Json) => r.l },
    ties: { type: GraphQLInt, resolve: (r: Json) => r.t },
    seasonName: from(GraphQLString)
  }
})

const rate = (name: string): GraphQLFieldConfig<Json, GraphqlContext> => ({
  type: GraphQLFloat,
  resolve: (line: Json) => (line.rates as Json | undefined)?.[name] ?? null
})
const count = { type: GraphQLInt }

const playerOf = (line: Json): PlayerSource => ({
  userId: String(line.userId),
  ...(typeof line.shortName === 'string' ? { shortName: line.shortName } : {})
})

const BattingLineType: GraphQLObjectType = new GraphQLObjectType({
  name: 'BattingLine',
  description:
    'A player’s batting, over the games the route that served it counts, with the rates it worked out.',
  fields: () => ({
    player: { type: required(PlayerType), resolve: playerOf },
    teamId: from(GraphQLID),
    g: count,
    pa: count,
    ab: count,
    h: count,
    singles: count,
    doubles: count,
    triples: count,
    hr: count,
    bb: count,
    k: count,
    r: count,
    rbi: count,
    hbp: count,
    sb: count,
    cs: count,
    sf: count,
    sh: count,
    avg: rate('avg'),
    obp: rate('obp'),
    slg: rate('slg'),
    ops: rate('ops'),
    seasonAvg: from(
      GraphQLFloat,
      'In a box score: the batting average up to and including this game.'
    )
  })
})

const PitchingLineType: GraphQLObjectType = new GraphQLObjectType({
  name: 'PitchingLine',
  description: 'A player’s pitching, with the rates the route worked out.',
  fields: () => ({
    player: { type: required(PlayerType), resolve: playerOf },
    teamId: from(GraphQLID),
    g: count,
    outs: count,
    ip: from(GraphQLString, 'Innings pitched, as 5.2'),
    bf: count,
    h: count,
    hr: count,
    hbp: count,
    r: count,
    er: count,
    bb: count,
    k: count,
    era: rate('era'),
    whip: rate('whip'),
    baa: rate('baa')
  })
})

const StatLineType: GraphQLObjectType = new GraphQLObjectType({
  name: 'StatLine',
  description:
    'One player in one game: batting and pitching together, from the game’s box score.',
  fields: () => ({
    player: { type: required(PlayerType) },
    teamId: from(GraphQLID),
    batting: from(BattingLineType),
    pitching: from(PitchingLineType)
  })
})

const BoxScoreType = new GraphQLObjectType({
  name: 'BoxScore',
  description: 'A game’s player lines. Only members of either side see it.',
  fields: {
    batting: from(required(list(BattingLineType))),
    pitching: from(required(list(PitchingLineType)))
  }
})

const LineScoreSideType = new GraphQLObjectType({
  name: 'LineScoreSide',
  description:
    'One side’s innings. A non-member gets the runs, and null for the other totals.',
  fields: {
    runs: from(new GraphQLList(GraphQLInt)),
    r: count,
    h: count,
    e: count,
    bb: count,
    k: count,
    hr: count,
    hbp: count
  }
})

const LineScoreType = new GraphQLObjectType({
  name: 'LineScore',
  fields: {
    away: from(LineScoreSideType),
    home: from(LineScoreSideType)
  }
})

// --- Players ------------------------------------------------------------

const PlayerStatsType = new GraphQLObjectType({
  name: 'PlayerStats',
  description: 'A player’s totals over the lines the caller may see.',
  fields: () => ({
    games: count,
    batting: from(BattingLineType),
    pitching: from(PitchingLineType)
  })
})

const PlayerTeamType: GraphQLObjectType = new GraphQLObjectType({
  name: 'PlayerTeam',
  description: 'A team and season a player played in.',
  fields: () => ({
    team: {
      type: required(TeamType),
      resolve: (row: Json): TeamSource => ({
        id: String(row.teamId),
        listed: {
          name: row.teamName as string,
          logoUrl: (row.logoUrl as string | null) ?? null
        }
      })
    },
    seasonId: from(GraphQLID),
    seasonName: from(GraphQLString),
    seasonYear: count,
    jersey: from(GraphQLString),
    positions: from(new GraphQLList(GraphQLString)),
    current: from(GraphQLBoolean)
  })
})

const PlayerType: GraphQLObjectType = new GraphQLObjectType({
  name: 'Player',
  description: 'A person who plays, named as the caller may see them.',
  fields: () => ({
    id: {
      type: required(GraphQLID),
      resolve: (player: PlayerSource) => player.userId
    },
    name: {
      type: GraphQLString,
      description:
        "The public name, as every screen draws it: first name and last initial unless the player's team chose another format.",
      resolve: async (player: PlayerSource, _args, context: GraphqlContext) =>
        player.shortName ?? (await playerDetail(player, context)).name
    },
    fullName: {
      type: GraphQLString,
      description:
        'The full name, only for a caller who may already read it; null for anyone else.',
      resolve: async (player: PlayerSource, _args, context: GraphqlContext) => {
        try {
          const name = await read(context, `/players/${id(player.userId)}/name`)
          return name.displayName
        } catch (error) {
          if (
            error instanceof RestError &&
            (error.status === 403 || error.status === 404)
          )
            return null
          throw error
        }
      }
    },
    bats: {
      type: GraphQLString,
      resolve: async (player: PlayerSource, _args, context: GraphqlContext) =>
        (await playerDetail(player, context)).bats
    },
    throws: {
      type: GraphQLString,
      resolve: async (player: PlayerSource, _args, context: GraphqlContext) =>
        (await playerDetail(player, context)).throws
    },
    teams: {
      type: list(PlayerTeamType),
      resolve: async (player: PlayerSource, _args, context: GraphqlContext) =>
        (await playerDetail(player, context)).teams
    },
    stats: {
      type: PlayerStatsType,
      args: {
        seasonId: { type: GraphQLID },
        teamId: { type: GraphQLID },
        year: { type: GraphQLInt }
      },
      resolve: async (
        player: PlayerSource,
        args: { seasonId?: string; teamId?: string; year?: number },
        context: GraphqlContext
      ) =>
        await read(context, `/players/${id(player.userId)}/stats`, {
          seasonId: args.seasonId,
          teamId: args.teamId,
          year: args.year == null ? undefined : String(args.year)
        })
    }
  })
})

const RosterEntryType: GraphQLObjectType = new GraphQLObjectType({
  name: 'RosterEntry',
  description: 'Somebody on a team’s roster, in its section.',
  fields: () => ({
    player: { type: required(PlayerType), resolve: playerOf },
    section: from(
      GraphQLString,
      'admin, staff, player, family, spectator or follower'
    ),
    isPlayer: from(GraphQLBoolean),
    jersey: from(GraphQLString),
    positions: from(new GraphQLList(GraphQLString)),
    staffRoles: from(new GraphQLList(GraphQLString))
  })
})

// --- Games --------------------------------------------------------------

const gameField = (
  name: string,
  type: GraphQLOutputType,
  description?: string
): GraphQLFieldConfig<GameSource, GraphqlContext> => ({
  type,
  description,
  resolve: async (game: GameSource, _args: unknown, context: GraphqlContext) =>
    await gameValue(game, name, context)
})

const GameType: GraphQLObjectType = new GraphQLObjectType({
  name: 'Game',
  description:
    'A game as the game route gives it: in full to a member of either side or its season, and the non-member view to anyone else.',
  fields: () => ({
    id: { type: required(GraphQLID) },
    homeTeam: {
      type: TeamType,
      resolve: async (
        game: GameSource,
        _args: unknown,
        context: GraphqlContext
      ): Promise<TeamSource> => await sideOf(game, 'home', context)
    },
    awayTeam: {
      type: TeamType,
      resolve: async (
        game: GameSource,
        _args: unknown,
        context: GraphqlContext
      ): Promise<TeamSource> => await sideOf(game, 'away', context)
    },
    season: {
      type: SeasonType,
      resolve: async (game: GameSource, _args, context: GraphqlContext) => {
        const seasonId = (await gameDetail(game, context)).seasonId
        return typeof seasonId === 'string' ? { id: seasonId } : null
      }
    },
    startAt: gameField('startAt', GraphQLString),
    endAt: gameField('endAt', GraphQLString),
    timezone: gameField('timezone', GraphQLString),
    status: gameField('status', GraphQLString),
    exhibition: gameField('exhibition', GraphQLBoolean),
    isGameLive: gameField('isGameLive', GraphQLBoolean),
    venue: gameField('venue', GraphQLString),
    address: gameField('address', GraphQLString),
    homeScore: gameField('homeScore', GraphQLInt),
    awayScore: gameField('awayScore', GraphQLInt),
    homeRecord: gameField('homeRecord', GraphQLString),
    awayRecord: gameField('awayRecord', GraphQLString),
    cancellationReason: gameField('cancellationReason', GraphQLString),
    nonMemberView: gameField(
      'nonMemberView',
      GraphQLBoolean,
      'True when the caller gets the non-member view.'
    ),
    notes: gameField('notes', GraphQLString, 'Null in the non-member view.'),
    arrivalTimeDelta: gameField(
      'arrivalTimeDelta',
      GraphQLInt,
      'Minutes before the start to arrive. Null in the non-member view.'
    ),
    ingestStatus: gameField('ingestStatus', GraphQLString),
    ingestMessage: gameField(
      'ingestMessage',
      GraphQLString,
      'Null in the non-member view.'
    ),
    scoringOwner: gameField(
      'scoringOwner',
      GraphQLString,
      'Null in the non-member view.'
    ),
    lineScore: gameField('linescore', LineScoreType),
    boxScore: {
      type: BoxScoreType,
      description: 'Members of either side only; anyone else gets an error.',
      resolve: async (game: GameSource, _args, context: GraphqlContext) =>
        await read(context, `/games/${id(game.id)}/box-score`)
    },
    statLines: {
      type: list(StatLineType),
      description:
        'One line per player, batting and pitching together. Members of either side only.',
      resolve: async (game: GameSource, _args, context: GraphqlContext) => {
        const box = await read<{ batting: Json[]; pitching: Json[] }>(
          context,
          `/games/${id(game.id)}/box-score`
        )
        const lines = new Map<string, Json>()
        const lineOf = (row: Json): Json => {
          const key = String(row.userId)
          const held = lines.get(key) ?? {
            player: playerOf(row),
            teamId: row.teamId,
            batting: null,
            pitching: null
          }
          lines.set(key, held)
          return held
        }
        for (const row of box.batting) lineOf(row).batting = row
        for (const row of box.pitching) lineOf(row).pitching = row
        return [...lines.values()]
      }
    }
  })
})

// --- Teams --------------------------------------------------------------

const TeamType: GraphQLObjectType = new GraphQLObjectType({
  name: 'Team',
  description:
    'A team, with the fields the team routes give the caller. Its games, roster and stats are read from their own routes.',
  fields: () => ({
    id: { type: required(GraphQLID) },
    name: {
      type: GraphQLString,
      resolve: async (team: TeamSource, _args, context: GraphqlContext) =>
        team.listed?.name ?? group(await teamDetail(team, context)).name
    },
    shortName: {
      type: GraphQLString,
      description:
        'Where a team listing gave it (Query.teams, Season.teams); null elsewhere, since the team route does not carry it.',
      resolve: (team: TeamSource) => team.listed?.shortName ?? null
    },
    logoUrl: {
      type: GraphQLString,
      resolve: async (team: TeamSource, _args, context: GraphqlContext) =>
        team.listed?.logoUrl !== undefined
          ? team.listed.logoUrl
          : group(await teamDetail(team, context)).imageUrl
    },
    timezone: {
      type: GraphQLString,
      resolve: async (team: TeamSource, _args, context: GraphqlContext) =>
        group(await teamDetail(team, context)).timezone
    },
    record: {
      type: RecordType,
      description: 'In its newest season, where a team listing gave it.',
      resolve: (team: TeamSource) => team.listed?.record ?? null
    },
    canViewPrivate: {
      type: GraphQLBoolean,
      resolve: async (team: TeamSource, _args, context: GraphqlContext) =>
        (await teamDetail(team, context)).canViewPrivate
    },
    nonMemberView: {
      type: GraphQLBoolean,
      resolve: async (team: TeamSource, _args, context: GraphqlContext) =>
        (await teamDetail(team, context)).nonMemberView
    },
    games: {
      type: list(GameType),
      description:
        'The team’s games, each as the game route gives it: its practices, other events and proposals not yet accepted are left out.',
      resolve: async (team: TeamSource, _args, context: GraphqlContext) =>
        (await read<Json[]>(context, `/teams/${id(team.id)}/games`))
          .filter(
            row =>
              row.eventKind !== 'event' &&
              row.pendingApproval !== true &&
              !String(row.id).startsWith('pending:')
          )
          .map((row): GameSource => ({ id: String(row.id), listed: row }))
    },
    roster: {
      type: list(RosterEntryType),
      resolve: async (team: TeamSource, _args, context: GraphqlContext) =>
        await read<Json[]>(context, `/teams/${id(team.id)}/roster`)
    },
    batting: {
      type: list(BattingLineType),
      args: { seasonId: { type: GraphQLID } },
      resolve: async (
        team: TeamSource,
        args: { seasonId?: string },
        context: GraphqlContext
      ) =>
        await read<Json[]>(context, `/teams/${id(team.id)}/stats`, {
          seasonId: args.seasonId
        })
    },
    pitching: {
      type: list(PitchingLineType),
      args: { seasonId: { type: GraphQLID } },
      resolve: async (
        team: TeamSource,
        args: { seasonId?: string },
        context: GraphqlContext
      ) =>
        await read<Json[]>(context, `/teams/${id(team.id)}/stats`, {
          kind: 'pitching',
          seasonId: args.seasonId
        })
    }
  })
})

const teamOfListing = (row: Json): TeamSource => ({
  id: String(row.id),
  listed: {
    name: row.name as string,
    shortName: (row.shortName as string | null) ?? null,
    logoUrl: (row.logoUrl as string | null) ?? null,
    record: row.record ?? null
  }
})

// --- Seasons ------------------------------------------------------------

const StandingType: GraphQLObjectType = new GraphQLObjectType({
  name: 'Standing',
  fields: () => ({
    team: {
      type: required(TeamType),
      resolve: (row: Json): TeamSource => ({
        id: String(row.teamId),
        listed: {
          name: row.teamName as string,
          logoUrl: (row.logoUrl as string | null) ?? null
        }
      })
    },
    wins: { type: GraphQLInt, resolve: (row: Json) => row.w },
    losses: { type: GraphQLInt, resolve: (row: Json) => row.l },
    ties: { type: GraphQLInt, resolve: (row: Json) => row.t },
    played: count,
    runsFor: count,
    runsAgainst: count,
    runDifferential: count,
    winningPct: from(GraphQLFloat),
    gamesBehind: from(GraphQLFloat),
    streak: from(GraphQLString)
  })
})

const seasonField = (
  name: string,
  type: GraphQLOutputType
): GraphQLFieldConfig<SeasonSource, GraphqlContext> => ({
  type,
  resolve: async (
    season: SeasonSource,
    _args: unknown,
    context: GraphqlContext
  ) => season.listed?.[name] ?? group(await seasonDetail(season, context))[name]
})

const SeasonType: GraphQLObjectType = new GraphQLObjectType({
  name: 'Season',
  fields: () => ({
    id: { type: required(GraphQLID) },
    name: seasonField('name', GraphQLString),
    startsOn: seasonField('startsOn', GraphQLString),
    endsOn: seasonField('endsOn', GraphQLString),
    leagueId: seasonField('leagueId', GraphQLID),
    year: {
      type: GraphQLInt,
      description:
        'Where the season listing gave it (Query.seasons); null elsewhere, since the season route does not carry it.',
      resolve: (season: SeasonSource) => season.listed?.year ?? null
    },
    teams: {
      type: list(TeamType),
      resolve: async (season: SeasonSource, _args, context: GraphqlContext) =>
        (await read<Json[]>(context, `/seasons/${id(season.id)}/teams`)).map(
          teamOfListing
        )
    },
    standings: {
      type: list(StandingType),
      resolve: async (season: SeasonSource, _args, context: GraphqlContext) =>
        await read<Json[]>(context, `/seasons/${id(season.id)}/standings`)
    },
    batting: {
      type: list(BattingLineType),
      resolve: async (season: SeasonSource, _args, context: GraphqlContext) =>
        (await read(context, `/seasons/${id(season.id)}/stats`)).batting
    },
    pitching: {
      type: list(PitchingLineType),
      resolve: async (season: SeasonSource, _args, context: GraphqlContext) =>
        (await read(context, `/seasons/${id(season.id)}/stats`)).pitching
    }
  })
})

// --- The query ----------------------------------------------------------

const QueryType = new GraphQLObjectType({
  name: 'Query',
  fields: {
    stats: statsField({
      player: PlayerType,
      team: TeamType,
      season: SeasonType,
      game: GameType
    }),
    // Root lists may be null, so a refused one leaves its siblings whole.
    teams: {
      type: list(TeamType),
      description:
        'The caller’s teams, as GET /teams lists them; with seasonId, that season’s teams.',
      args: { seasonId: { type: GraphQLID }, kind: { type: GraphQLString } },
      resolve: async (
        _root,
        args: { seasonId?: string; kind?: string },
        context: GraphqlContext
      ) =>
        (
          await read<Json[]>(context, '/teams', {
            season: args.seasonId,
            kind: args.kind
          })
        ).map(teamOfListing)
    },
    team: {
      type: TeamType,
      args: { id: { type: required(GraphQLID) } },
      resolve: async (_root, args: { id: string }, context: GraphqlContext) => {
        // Read now, so a team that is not there is an error here.
        await teamDetail({ id: args.id }, context)
        return { id: args.id }
      }
    },
    game: {
      type: GameType,
      args: { id: { type: required(GraphQLID) } },
      resolve: async (_root, args: { id: string }, context: GraphqlContext) => {
        await gameDetail({ id: args.id }, context)
        return { id: args.id }
      }
    },
    seasons: {
      type: list(SeasonType),
      description: 'The caller’s seasons, as GET /seasons lists them.',
      resolve: async (_root, _args, context: GraphqlContext) =>
        (await read<Json[]>(context, '/seasons')).map((row): SeasonSource => ({
          id: String(row.id),
          listed: row
        }))
    },
    season: {
      type: SeasonType,
      args: { id: { type: required(GraphQLID) } },
      resolve: async (_root, args: { id: string }, context: GraphqlContext) => {
        await seasonDetail({ id: args.id }, context)
        return { id: args.id }
      }
    },
    player: {
      type: PlayerType,
      args: { id: { type: required(GraphQLID) } },
      resolve: async (_root, args: { id: string }, context: GraphqlContext) => {
        const detail = await playerDetail({ userId: args.id }, context)
        return {
          userId: String(detail.userId),
          shortName: detail.name as string
        }
      }
    }
  }
})

/** The schema: a query type, and no mutation or subscription type. */
export const graphqlSchema = new GraphQLSchema({ query: QueryType })

// Every field counts against the query's budget, and none resolves once the
// query has ended.
for (const type of Object.values(graphqlSchema.getTypeMap()))
  if (type instanceof GraphQLObjectType && !type.name.startsWith('__'))
    for (const field of Object.values(type.getFields())) {
      const resolve = field.resolve ?? defaultFieldResolver
      field.resolve = (source, args, context: GraphqlContext, info) => {
        if (context.signal?.aborted === true)
          throw new RestError(
            504,
            'The query ran out of time, or its caller left'
          )
        if (++context.budget.used > MAX_FIELDS) return nothingOf(field.type)
        return resolve(source, args, context, info)
      }
    }

/**
 * The schema in a line a type, for a reader who writes queries by hand (Tess's
 * `graphql_query`): `Query { team(id): Team, … }`, then every other type.
 */
export function graphqlOutline(): string {
  const typeName = (type: GraphQLOutputType): string => getNamedType(type).name
  const types = Object.values(graphqlSchema.getTypeMap()).filter(
    (type): type is GraphQLObjectType =>
      type instanceof GraphQLObjectType && !type.name.startsWith('__')
  )
  return types
    .sort((a, b) =>
      a.name === 'Query'
        ? -1
        : b.name === 'Query'
          ? 1
          : a.name.localeCompare(b.name)
    )
    .map(type => {
      const fields = Object.values(type.getFields()).map(field => {
        const args =
          field.args.length === 0
            ? ''
            : `(${field.args.map(arg => arg.name).join(', ')})`
        const list = isListType(getNullableType(field.type)) ? '[]' : ''
        const named = typeName(field.type)
        const shown = /^(String|Int|Float|Boolean|ID)$/.test(named)
          ? ''
          : `: ${named}${list}`
        return `${field.name}${args}${shown}`
      })
      return `${type.name} { ${fields.join(', ')} }`
    })
    .join('. ')
}

/** How deep a query may nest its selections. */
export const MAX_DEPTH = 10

/** Refuses a query whose selections nest deeper than `MAX_DEPTH`. */
export const depthLimit: ValidationRule = (context: ValidationContext) => {
  const fragments = new Map<string, FragmentDefinitionNode>()
  for (const definition of context.getDocument().definitions)
    if (definition.kind === Kind.FRAGMENT_DEFINITION)
      fragments.set(definition.name.value, definition)
  // Each fragment's depth is worked out once, however often it is spread:
  // walking it again at every spread would let a chain of fragments that
  // each spread the next twice cost twice as much a link. One spread inside
  // itself counts nothing more; `NoFragmentCyclesRule` refuses the query.
  const known = new Map<string, number>()
  const walking = new Set<string>()
  const fragmentDepth = (name: string): number => {
    const held = known.get(name)
    if (held != null) return held
    const fragment = fragments.get(name)
    if (fragment == null || walking.has(name)) return 0
    walking.add(name)
    const depth = depthOf(fragment.selectionSet)
    walking.delete(name)
    known.set(name, depth)
    return depth
  }
  const depthOf = (set: SelectionSetNode): number => {
    let deepest = 0
    for (const selection of set.selections) {
      if (selection.kind === Kind.FIELD) {
        const below =
          selection.selectionSet == null ? 0 : depthOf(selection.selectionSet)
        deepest = Math.max(deepest, 1 + below)
      } else if (selection.kind === Kind.INLINE_FRAGMENT) {
        deepest = Math.max(deepest, depthOf(selection.selectionSet))
      } else {
        deepest = Math.max(deepest, fragmentDepth(selection.name.value))
      }
    }
    return deepest
  }
  return {
    OperationDefinition(operation) {
      if (depthOf(operation.selectionSet) > MAX_DEPTH)
        context.reportError(
          new GraphQLError(
            `This query nests deeper than ${MAX_DEPTH} levels. Ask for less`,
            { nodes: [operation] }
          )
        )
    }
  }
}

/**
 * How many fields a query may select, every fragment counted where it is
 * spread and every alias on its own. It bounds what the field budget cannot
 * see: introspection, which reads nothing and is answered at once from the
 * schema, so an aliased `__schema` could otherwise grow its answer without
 * end.
 */
export const MAX_SELECTIONS = 2000

/** Refuses a query that selects more than `MAX_SELECTIONS` fields. */
export const sizeLimit: ValidationRule = (context: ValidationContext) => {
  const fragments = new Map<string, FragmentDefinitionNode>()
  for (const definition of context.getDocument().definitions)
    if (definition.kind === Kind.FRAGMENT_DEFINITION)
      fragments.set(definition.name.value, definition)
  // Each fragment's size once, as `depthLimit` does its depth.
  const known = new Map<string, number>()
  const walking = new Set<string>()
  const fragmentSize = (name: string): number => {
    const held = known.get(name)
    if (held != null) return held
    const fragment = fragments.get(name)
    if (fragment == null || walking.has(name)) return 0
    walking.add(name)
    const size = sizeOf(fragment.selectionSet)
    walking.delete(name)
    known.set(name, size)
    return size
  }
  const sizeOf = (set: SelectionSetNode): number => {
    let size = 0
    for (const selection of set.selections) {
      if (selection.kind === Kind.FIELD)
        size +=
          1 +
          (selection.selectionSet == null ? 0 : sizeOf(selection.selectionSet))
      else if (selection.kind === Kind.INLINE_FRAGMENT)
        size += sizeOf(selection.selectionSet)
      else size += fragmentSize(selection.name.value)
      // Past the limit there is nothing more to learn.
      if (size > MAX_SELECTIONS) return size
    }
    return size
  }
  return {
    OperationDefinition(operation) {
      if (sizeOf(operation.selectionSet) > MAX_SELECTIONS)
        context.reportError(
          new GraphQLError(
            `This query selects more than ${MAX_SELECTIONS} fields. Ask for less`,
            { nodes: [operation] }
          )
        )
    }
  }
}
