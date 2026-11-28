import {
  asArray,
  asBoolean,
  asEither,
  asMap,
  asNumber,
  asObject,
  asOptional,
  asString,
  type Cleaner
} from 'cleaners'

import { asLiteral } from './asLiteral'
import { asSideTeamId } from './openSides'
import { answeredUmpireSort, type UmpireSortKey } from './umpireSort'
/**
 * An umpire schedule sort a server answers: its keys, first first. Read
 * leniently, so a key a newer server added (a league may save it as its
 * default) drops out rather than failing the schedule or the settings, and a
 * sort of only such keys reads as absent, the default.
 */
export const asUmpireSort = (raw: unknown): UmpireSortKey[] | undefined => {
  if (!Array.isArray(raw)) throw new TypeError('Expected an umpire sort')
  return answeredUmpireSort(raw)
}
/** A saved default sort: absent stays absent, null stays null (none saved). */
const asOptionalUmpireSort = (
  raw: unknown
): UmpireSortKey[] | null | undefined =>
  raw === undefined ? undefined : raw === null ? null : asUmpireSort(raw)
export const asUmpireSettings = asObject({
  management: asBoolean,
  credits: asBoolean,
  sort: asOptionalUmpireSort
})
/** `GET`/`PUT /leagues/:leagueId/umpire-notifications`' answer. */
export const asUmpireNotificationSettings = asObject({
  missingSlots: asBoolean,
  daysBefore: asNumber,
  signUps: asBoolean,
  withdrawals: asBoolean
})
export const asUmpireLevel = asObject({
  id: asString,
  name: asString,
  position: asNumber,
  inUse: asBoolean
})
export const asUmpireTypes = asObject({ types: asArray(asUmpireLevel) })
export const asUmpirePosition = asObject({
  slot: asString,
  typeId: asString,
  typeName: asString,
  ordinal: asNumber,
  required: asBoolean
})
export const asUmpireTypeCount = asObject({
  typeId: asString,
  required: asNumber,
  optional: asNumber
})
export const asUmpireLevels = asObject({ levels: asArray(asUmpireLevel) })
export const asUmpireSeasons = asObject({
  seasons: asArray(
    asObject({
      id: asString,
      name: asString,
      logoUrl: asEither(asString, asLiteral(null)),
      leagueId: asOptional(asString, ''),
      leaguePictureUrl: asOptional(asEither(asString, asLiteral(null)), null),
      requirement: asEither(
        asObject({
          levelId: asString,
          levelName: asString,
          types: asArray(asUmpireTypeCount)
        }),
        asLiteral(null)
      ),
      priority: asOptional(asEither(asNumber, asLiteral(null)), null)
    })
  )
})
/** A saved umpire availability filter (0 is Monday … 6 is Sunday). */
export const asUmpireAvailability = asObject({
  levels: asArray(asString),
  days: asArray(asNumber),
  from: asEither(asString, asLiteral(null)),
  to: asEither(asString, asLiteral(null)),
  timezone: asString
})
/**
 * A saved filter where one may be left out: absent stays absent (the field
 * is not for this caller) and null stays null (none is saved), which
 * `asOptional` would not tell apart.
 */
export const asOptionalUmpireAvailability = (
  raw: unknown
): ReturnType<typeof asUmpireAvailability> | null | undefined =>
  raw === undefined
    ? undefined
    : asEither(asUmpireAvailability, asLiteral(null))(raw)
/**
 * Leaves `umpireAvailability` off a cleaned object when the server left it
 * off, as `asObject` would otherwise keep the key with nothing in it.
 */
export function withoutAbsentAvailability<
  T extends { umpireAvailability?: unknown }
>(cleaner: Cleaner<T>): Cleaner<T> {
  return raw => {
    const clean = cleaner(raw)
    if (clean.umpireAvailability !== undefined) return clean
    const { umpireAvailability: _absent, ...rest } = clean
    return rest as T
  }
}
export const asUmpireAvailabilityAnswer = asObject({
  availability: asEither(asUmpireAvailability, asLiteral(null))
})
const asUmpirePerson = withoutAbsentAvailability(
  asObject({
    id: asString,
    name: asString,
    avatarUrl: asEither(asString, asLiteral(null)),
    affiliations: asOptional(asString, ''),
    certifications: asArray(
      asObject({ levelId: asString, typeId: asString, enabled: asBoolean })
    ),
    umpireAvailability: asOptionalUmpireAvailability
  })
)
export const asUmpirePeople = asObject({
  people: asArray(asUmpirePerson)
})
/** An umpire's games in a window: those they umpire and those they play. */
export const asUmpireCommitments = asObject({
  commitments: asArray(
    asObject({
      gameId: asString,
      leagueId: asString,
      startAt: asString,
      endAt: asString,
      home: asString,
      away: asString,
      role: asEither(asLiteral('umpire'), asLiteral('player')),
      slot: asOptional(asString)
    })
  )
})
export const asUmpireLeagues = asObject({
  leagues: asArray(
    asObject({
      id: asString,
      name: asString,
      logoUrl: asEither(asString, asLiteral(null))
    })
  )
})
/** What a schedule says beside its games, whole or a page at a time. */
export const asUmpireScheduleHead = {
  settings: asUmpireSettings,
  levels: asArray(asUmpireLevel),
  types: asArray(asUmpireLevel),
  noteTypes: asArray(asUmpireLevel),
  viewerId: asString,
  isAdmin: asBoolean,
  view: asEither(
    asLiteral('umpire'),
    asLiteral('league'),
    asLiteral('schedule')
  ),
  creditTeams: asArray(asObject({ id: asString, name: asString })),
  sort: asOptional(asUmpireSort)
}
export const asUmpireGameRow = asObject({
  id: asString,
  seasonId: asString,
  seasonName: asString,
  levelId: asString,
  levelName: asString,
  startAt: asString,
  endAt: asEither(asString, asLiteral(null)),
  timezone: asString,
  date: asString,
  status: asEither(
    asLiteral('scheduled'),
    asLiteral('inProgress'),
    asLiteral('final'),
    asLiteral('cancelled')
  ),
  home: asString,
  away: asString,
  homeTeamId: asOptional(asSideTeamId),
  awayTeamId: asOptional(asSideTeamId),
  location: asOptional(asString),
  venue: asString,
  field: asString,
  notes: asString,
  umpireNotes: asMap(asString),
  positions: asArray(asUmpirePosition),
  assignments: asMap(
    asObject({
      userId: asString,
      name: asString,
      displayName: asString,
      assignedBy: asString,
      canRemove: asBoolean,
      teams: asOptional(asArray(asObject({ id: asString, name: asString })), [])
    })
  ),
  conflicts: asArray(
    asObject({
      userId: asString,
      name: asString,
      activity: asEither(asLiteral('playing'), asLiteral('already umpiring')),
      gameId: asString,
      time: asString,
      closeness: asString
    })
  ),
  choices: asMap(
    asArray(
      asObject({
        userId: asString,
        name: asString,
        reason: asEither(asString, asLiteral(null))
      })
    )
  )
})
export const asUmpireSchedule = asObject({
  ...asUmpireScheduleHead,
  games: asArray(asUmpireGameRow)
})
export const asUmpireColumn = asObject({
  ...asUmpirePosition.shape,
  optionalHeader: asEither(asString, asLiteral(null))
})
const asRank = asObject({
  userId: asString,
  name: asString,
  count: asNumber,
  symbol: asString
})
export const asUmpireLeaderboard = asObject({
  completed: asArray(asRank),
  scheduled: asArray(asRank),
  teams: asEither(
    asArray(asObject({ id: asString, name: asString, count: asNumber })),
    asLiteral(null)
  ),
  page: asOptional(
    asObject({
      order: asEither(asLiteral('asc'), asLiteral('desc')),
      limit: asNumber,
      offset: asNumber,
      total: asNumber
    })
  )
})
