import {
  asArray,
  asBoolean,
  asEither,
  asMap,
  asNumber,
  asObject,
  asOptional,
  asString
} from 'cleaners'

import { asLiteral } from './asLiteral'
export const asUmpireSettings = asObject({
  management: asBoolean,
  credits: asBoolean
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
      requirement: asEither(
        asObject({
          levelId: asString,
          levelName: asString,
          types: asArray(asUmpireTypeCount)
        }),
        asLiteral(null)
      )
    })
  )
})
export const asUmpirePeople = asObject({
  people: asArray(
    asObject({
      id: asString,
      name: asString,
      avatarUrl: asEither(asString, asLiteral(null)),
      affiliations: asString,
      certifications: asArray(
        asObject({ levelId: asString, typeId: asString, enabled: asBoolean })
      )
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
  creditTeams: asArray(asObject({ id: asString, name: asString }))
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
  homeTeamId: asOptional(asString),
  awayTeamId: asOptional(asString),
  location: asOptional(asString),
  venue: asString,
  notes: asString,
  umpireNotes: asMap(asString),
  positions: asArray(asUmpirePosition),
  assignments: asMap(
    asObject({
      userId: asString,
      name: asString,
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
  )
})
