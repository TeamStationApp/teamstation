import {
  asArray,
  asBoolean,
  asEither,
  asMap,
  asNumber,
  asObject,
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
          plate: asBoolean,
          fieldCount: asNumber
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
        asObject({ levelId: asString, plate: asBoolean, field: asBoolean })
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
export const asUmpireSchedule = asObject({
  settings: asUmpireSettings,
  levels: asArray(asUmpireLevel),
  viewerId: asString,
  isAdmin: asBoolean,
  view: asEither(asLiteral('umpire'), asLiteral('league')),
  creditTeams: asArray(asObject({ id: asString, name: asString })),
  games: asArray(
    asObject({
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
      venue: asString,
      notes: asString,
      plate: asBoolean,
      fieldCount: asNumber,
      assignments: asMap(
        asObject({
          userId: asString,
          name: asString,
          assignedBy: asString,
          canRemove: asBoolean
        })
      ),
      conflicts: asArray(
        asObject({
          userId: asString,
          name: asString,
          activity: asEither(
            asLiteral('playing'),
            asLiteral('already umpiring')
          ),
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
  )
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
