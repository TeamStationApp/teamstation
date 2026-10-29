import {
  type FragmentDefinitionNode,
  GraphQLBoolean,
  GraphQLEnumType,
  GraphQLError,
  type GraphQLFieldConfig,
  GraphQLFloat,
  GraphQLID,
  GraphQLInputObjectType,
  GraphQLInt,
  GraphQLList,
  GraphQLNonNull,
  GraphQLObjectType,
  type GraphQLOutputType,
  GraphQLString,
  Kind,
  type SelectionSetNode,
  type ValidationContext,
  type ValidationRule
} from 'graphql'
import type { Kysely } from 'kysely'

import { guardsPerson, visibleScopes } from '../access'
import { onePerson } from '../admin/people'
import { type Actor, keyAllows } from '../auth/sessions'
import type { Database } from '../db/database'
import {
  type SplitFilter,
  type SplitGroup,
  type SplitRow,
  statSplits,
  TooManyLines
} from '../stats/splits'
import { RestError } from './restReader'

/**
 * `Query.stats`: batting or pitching split any way a plate appearance can be,
 * read straight from the database in one query (`statSplits`). Only games
 * the caller may open count, as on the stats routes; an API key needs game
 * events read.
 */

/** What `Query.stats` needs beyond the REST reader: the database and who asks. */
export interface StatsContext {
  db: Kysely<Database>
  actor?: Actor
  /** Aborted at the query's deadline, or when its caller leaves. */
  signal?: AbortSignal
}

/** The most lines one `stats` field returns. */
export const MAX_STATS_LINES = 1000

/**
 * How many `stats` one query may ask for. Each is an aggregate over every
 * plate appearance the caller may see, so aliasing it is refused past this.
 */
export const MAX_STATS_FIELDS = 3

/** Refuses a query that asks for `stats` more than `MAX_STATS_FIELDS` times. */
export const statsLimit: ValidationRule = (context: ValidationContext) => {
  const fragments = new Map<string, FragmentDefinitionNode>()
  for (const definition of context.getDocument().definitions)
    if (definition.kind === Kind.FRAGMENT_DEFINITION)
      fragments.set(definition.name.value, definition)
  // `stats` is a field of the query itself: count it at the top, through
  // fragments and inline fragments, each spread counted again. Each
  // fragment's count is worked out once, as `depthLimit` does its depth, so
  // a chain of fragments spread twice each costs its length.
  const known = new Map<string, number>()
  const walking = new Set<string>()
  const fragmentCount = (name: string): number => {
    const held = known.get(name)
    if (held != null) return held
    const fragment = fragments.get(name)
    if (fragment == null || walking.has(name)) return 0
    walking.add(name)
    const count = countIn(fragment.selectionSet)
    walking.delete(name)
    known.set(name, count)
    return count
  }
  const countIn = (set: SelectionSetNode): number =>
    set.selections.reduce((total, selection) => {
      if (selection.kind === Kind.FIELD)
        return total + (selection.name.value === 'stats' ? 1 : 0)
      if (selection.kind === Kind.INLINE_FRAGMENT)
        return total + countIn(selection.selectionSet)
      return total + fragmentCount(selection.name.value)
    }, 0)
  return {
    OperationDefinition(operation) {
      if (countIn(operation.selectionSet) > MAX_STATS_FIELDS)
        context.reportError(
          new GraphQLError(
            `A query may ask for stats at most ${MAX_STATS_FIELDS} times`,
            { nodes: [operation] }
          )
        )
    }
  }
}

const Perspective = new GraphQLEnumType({
  name: 'StatsPerspective',
  values: { BATTING: { value: 'batting' }, PITCHING: { value: 'pitching' } }
})

const Group = new GraphQLEnumType({
  name: 'StatsGroup',
  description: 'What a line is split by; several make a line per combination.',
  values: {
    PLAYER: { value: 'player' },
    TEAM: { value: 'team' },
    OPPONENT: { value: 'opponent' },
    SEASON: { value: 'season' },
    GAME: { value: 'game' },
    SIDE: { value: 'side', description: 'Home or away' },
    OUTS: {
      value: 'outs',
      description: 'Outs when the plate appearance began'
    },
    RUNNERS: {
      value: 'runners',
      description:
        'Who was on base when it began: empty, first (first alone), scoringPosition (second or third, not loaded), loaded'
    },
    FIRST_PITCH: {
      value: 'firstPitch',
      description: 'How its first pitch went: ball, strike, inPlay or other'
    }
  }
})

const Side = new GraphQLEnumType({
  name: 'StatsSide',
  values: { HOME: { value: 'home' }, AWAY: { value: 'away' } }
})

const Runners = new GraphQLEnumType({
  name: 'StatsRunners',
  values: {
    EMPTY: { value: 'empty' },
    ANY: { value: 'any', description: 'Anybody on base' },
    SCORING_POSITION: {
      value: 'scoringPosition',
      description: 'Anybody on second or third'
    },
    LOADED: { value: 'loaded' }
  }
})

const FirstPitch = new GraphQLEnumType({
  name: 'StatsFirstPitch',
  values: {
    BALL: { value: 'ball' },
    STRIKE: { value: 'strike', description: 'Called, swinging or foul' },
    IN_PLAY: { value: 'inPlay' },
    OTHER: { value: 'other', description: 'A pitch that was none of those' }
  }
})

const Filter = new GraphQLInputObjectType({
  name: 'StatsFilter',
  fields: {
    playerId: { type: GraphQLID },
    teamId: {
      type: GraphQLID,
      description:
        'The batting side when batting, the pitching side when pitching'
    },
    opponentId: { type: GraphQLID },
    seasonId: { type: GraphQLID },
    from: {
      type: GraphQLString,
      description:
        'Games starting at or after this time: ISO 8601 with its offset, as 2026-05-01T00:00:00-07:00 for the start of May in Pacific time'
    },
    to: {
      type: GraphQLString,
      description: 'Games starting before this time, written as `from` is'
    },
    side: { type: Side },
    outs: {
      type: new GraphQLList(new GraphQLNonNull(GraphQLInt)),
      description:
        'Outs when the plate appearance began (0, 1 or 2), any of these; a plate appearance whose outs are not known matches none'
    },
    runners: { type: Runners },
    firstPitch: { type: FirstPitch }
  }
})

/** Every count and rate a line has, for `orderBy`. */
const ORDERABLE = [
  'games',
  'pa',
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
  'rbi',
  'outsMade',
  'pitches',
  'pitchedPa',
  'firstPitchKnown',
  'firstPitchBalls',
  'firstPitchStrikes',
  'firstPitchInPlay',
  'avg',
  'obp',
  'slg',
  'ops',
  'kRate',
  'bbRate',
  'whip',
  'firstPitchStrikeRate',
  'firstPitchBallRate',
  'pitchesPerPa'
] as const

const Order = new GraphQLEnumType({
  name: 'StatsOrder',
  values: Object.fromEntries(
    ORDERABLE.map(name => [
      name.replace(/([A-Z])/g, '_$1').toUpperCase(),
      { value: name }
    ])
  )
})

const count = { type: GraphQLInt }
const rate = { type: GraphQLFloat }

interface Types {
  player: GraphQLOutputType
  team: GraphQLOutputType
  season: GraphQLOutputType
  game: GraphQLOutputType
}

function splitType(types: Types): GraphQLObjectType {
  return new GraphQLObjectType({
    name: 'StatsLine',
    description:
      'One line of a split: what it is split by (null where it is not), its counts and its rates.',
    fields: {
      player: {
        type: types.player,
        resolve: (row: SplitRow) =>
          row.userId == null
            ? null
            : { userId: row.userId, shortName: row.shortName ?? undefined }
      },
      team: {
        type: types.team,
        resolve: (row: SplitRow) =>
          row.teamId == null
            ? null
            : { id: row.teamId, listed: { name: row.teamName ?? undefined } }
      },
      opponent: {
        type: types.team,
        resolve: (row: SplitRow) =>
          row.opponentId == null
            ? null
            : {
                id: row.opponentId,
                listed: { name: row.opponentName ?? undefined }
              }
      },
      season: {
        type: types.season,
        resolve: (row: SplitRow) =>
          row.seasonId == null
            ? null
            : { id: row.seasonId, listed: { name: row.seasonName } }
      },
      game: {
        type: types.game,
        resolve: (row: SplitRow) =>
          row.gameId == null ? null : { id: row.gameId }
      },
      side: { type: GraphQLString },
      outs: { type: GraphQLInt, description: 'Outs when it began' },
      runners: { type: GraphQLString },
      firstPitch: { type: GraphQLString },
      games: count,
      pa: {
        ...count,
        description: 'Plate appearances; batters faced when pitching'
      },
      ab: count,
      h: count,
      singles: count,
      doubles: count,
      triples: count,
      hr: count,
      bb: count,
      k: count,
      hbp: count,
      ci: count,
      sf: count,
      sh: count,
      rbi: count,
      outsMade: {
        ...count,
        description: 'Outs made during these plate appearances'
      },
      ip: {
        type: GraphQLString,
        description: 'Innings pitched, from the outs made'
      },
      pitches: {
        ...count,
        description:
          'Pitches seen by the batter, or thrown by the pitcher, outs on the bases ending an inning included'
      },
      pitchedPa: {
        ...count,
        description: 'Plate appearances with their pitches recorded'
      },
      firstPitchKnown: {
        ...count,
        description: 'Plate appearances whose first pitch was recorded'
      },
      firstPitchBalls: count,
      firstPitchStrikes: count,
      firstPitchInPlay: count,
      avg: rate,
      obp: rate,
      slg: rate,
      ops: rate,
      kRate: { ...rate, description: 'Strikeouts per plate appearance' },
      bbRate: { ...rate, description: 'Walks per plate appearance' },
      whip: rate,
      firstPitchStrikeRate: {
        ...rate,
        description:
          'Of first pitches recorded: strikes, balls in play among them'
      },
      firstPitchBallRate: rate,
      pitchesPerPa: {
        ...rate,
        description: 'Pitches per plate appearance with its pitches recorded'
      }
    }
  })
}

interface Args {
  perspective: 'batting' | 'pitching'
  filter?: {
    playerId?: string | null
    teamId?: string | null
    opponentId?: string | null
    seasonId?: string | null
    from?: string | null
    to?: string | null
    side?: 'home' | 'away' | null
    outs?: number[] | null
    runners?: SplitFilter['runners'] | null
    firstPitch?: SplitFilter['firstPitch'] | null
  } | null
  groupBy?: SplitGroup[] | null
  orderBy?: (typeof ORDERABLE)[number] | null
  descending: boolean
  limit: number
}

/** A time with its offset: a date alone would be UTC midnight, not local. */
const ISO_TIME =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:\d{2})$/

const asDate = (value: string, name: string): Date => {
  const date = new Date(value)
  if (!ISO_TIME.test(value) || Number.isNaN(date.getTime()))
    throw new RestError(
      400,
      `${name} must be an ISO 8601 time with its offset, as 2026-05-01T00:00:00-07:00`
    )
  return date
}

/** The `stats` field of `Query`, over the schema's own types. */
export function statsField(
  types: Types
): GraphQLFieldConfig<unknown, StatsContext, Args> {
  return {
    type: new GraphQLList(new GraphQLNonNull(splitType(types))),
    description:
      'Batting or pitching, split by player, team, opponent, season, game, home or away, the outs and runners each plate appearance began with, and its first pitch; filtered by any of them and by dates. Only games you may open count.',
    args: {
      perspective: {
        type: new GraphQLNonNull(Perspective),
        defaultValue: 'batting'
      },
      filter: { type: Filter },
      groupBy: { type: new GraphQLList(new GraphQLNonNull(Group)) },
      orderBy: {
        type: Order,
        description:
          'Plate appearances when not given; ties in the order of what the line is split by'
      },
      descending: {
        type: new GraphQLNonNull(GraphQLBoolean),
        defaultValue: true
      },
      limit: {
        type: new GraphQLNonNull(GraphQLInt),
        defaultValue: 100,
        description: `At most ${MAX_STATS_LINES}; lines are cut in their order`
      }
    },
    resolve: async (_root, args, context) => {
      const { db, actor } = context
      if (actor == null) throw new RestError(401, 'Sign in to continue')
      if (context.signal?.aborted === true)
        throw new RestError(
          504,
          'The query ran out of time, or its caller left'
        )
      if (!keyAllows(actor, 'gameEvents:read'))
        throw new RestError(403, 'This API key cannot do that')
      if (args.limit < 1 || args.limit > MAX_STATS_LINES)
        throw new RestError(400, `limit is 1 to ${MAX_STATS_LINES}`)
      const raw = args.filter ?? {}
      const filter: SplitFilter = {}
      const scopes = await visibleScopes(db, actor.userId, actor.isAdmin)
      // A person's own figures, or a guardian's child's, count every game
      // they played, as on the player stats page.
      let allGames = false
      if (raw.playerId != null) {
        const person = await onePerson(db, raw.playerId)
        filter.userIds = person.userIds
        allGames =
          person.userIds.includes(actor.userId) ||
          (await guardsPerson(db, scopes, actor.userId, person))
      }
      if (raw.teamId != null) filter.teamId = raw.teamId
      if (raw.opponentId != null) filter.opponentId = raw.opponentId
      if (raw.seasonId != null) filter.seasonId = raw.seasonId
      if (raw.from != null) filter.from = asDate(raw.from, 'from')
      if (raw.to != null) filter.to = asDate(raw.to, 'to')
      if (raw.side != null) filter.side = raw.side
      if (raw.outs != null) {
        if (raw.outs.some(outs => outs < 0 || outs > 2))
          throw new RestError(400, 'outs must be 0, 1 or 2')
        filter.outs = raw.outs
      }
      if (raw.runners != null) filter.runners = raw.runners
      if (raw.firstPitch != null) filter.firstPitch = raw.firstPitch
      try {
        return await statSplits(db, scopes, {
          perspective: args.perspective,
          filter,
          groupBy: args.groupBy ?? [],
          orderBy: args.orderBy ?? undefined,
          ascending: !args.descending,
          limit: args.limit,
          allGames
        })
      } catch (error) {
        if (error instanceof TooManyLines)
          throw new RestError(400, error.message)
        throw error
      }
    }
  }
}
