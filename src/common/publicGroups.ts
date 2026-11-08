import {
  asArray,
  asBoolean,
  asEither,
  asNull,
  asNumber,
  asObject,
  asOptional,
  asString,
  asValue
} from 'cleaners'

import { asLiteral } from './asLiteral'
import { withEventMetadata } from './eventInfo'
import { asLocality } from './locality'
import {
  asPlayerNamePrivacy,
  DEFAULT_PLAYER_NAME_PRIVACY
} from './playerNamePrivacy'
import { asPlayingTimeRules } from './playingTimeRules'
import { asRole } from './roles'

const nullable =
  <T>(clean: (raw: unknown) => T) =>
  (raw: unknown): T | null =>
    raw == null ? null : clean(raw)
export const asPublicGroup = asObject({
  id: asString,
  kind: asLiteral('league', 'season', 'team'),
  name: asString,
  imageUrl: nullable(asString),
  locality: nullable(asLocality),
  startsOn: asOptional(nullable(asString), null),
  endsOn: asOptional(nullable(asString), null),
  timezone: asOptional(asString, 'UTC'),
  external: asOptional(asBoolean, false),
  parentNames: asOptional(asArray(asString), []),
  /** A season's or team's parent league, so a picker can keep to one. */
  leagueId: asOptional(nullable(asString), null)
})
export type PublicGroup = ReturnType<typeof asPublicGroup>
/**
 * A row of a public search or suggestion: a group, and for a team the seasons
 * it is in, newest first, and its staff as public short names, coaches first.
 * No other answer carries these, and absent means not loaded, not none.
 */
export const asSearchRow = asObject({
  ...asPublicGroup.shape,
  seasonNames: asOptional(asArray(asString)),
  staffNames: asOptional(asArray(asString))
})
export type SearchRow = PublicGroup & {
  seasonNames?: string[]
  staffNames?: string[]
}
export const asPublicGame = withEventMetadata(
  asObject({
    id: asString,
    homeTeam: asObject({ id: asString, name: asString }),
    awayTeam: asObject({ id: asString, name: asString }),
    seasonId: nullable(asString),
    startAt: asString,
    venue: nullable(asString),
    exhibition: asOptional(asBoolean, false),
    timezone: asOptional(asString, 'UTC'),
    videoCount: asOptional(asNumber, 0),
    pendingApproval: asOptional(asBoolean, false),
    pendingRequestId: asOptional(nullable(asString), null),
    homeTeamExternal: asOptional(asBoolean, false),
    awayTeamExternal: asOptional(asBoolean, false),
    status: asString,
    homeScore: nullable(asNumber),
    awayScore: nullable(asNumber),
    cancellationReason: nullable(asString),
    withdrawnByTeamId: nullable(asString),
    withdrawnByTeamName: asOptional(nullable(asString), null)
  })
)
export type PublicGame = ReturnType<typeof asPublicGame>
const cleanPublicStaff = asObject({
  name: asString,
  roles: asArray(asString),
  avatarUrl: asOptional(nullable(asString), null),
  inheritedFrom: asOptional(
    nullable(
      asObject({
        level: asLiteral('season', 'league'),
        role: asRole
      })
    )
  )
})
function asPublicStaff(
  raw: unknown
): ReturnType<typeof cleanPublicStaff> & { isHeadCoach?: boolean } {
  const person = cleanPublicStaff(raw)
  if (typeof raw === 'object' && raw != null && 'isHeadCoach' in raw)
    return { ...person, isHeadCoach: asBoolean(raw.isHeadCoach) }
  return person
}
export const asGroupDetail = asObject({
  group: asPublicGroup,
  parents: asArray(asPublicGroup),
  children: asArray(asPublicGroup),
  participatingSeasons: asArray(asPublicGroup),
  competingTeams: asArray(asPublicGroup),
  staff: asArray(asPublicStaff),
  games: asArray(asPublicGame),
  custodian: asOptional(nullable(asPublicGroup), null),
  /** Placeholder teams this group keeps; a league's only. */
  keptTeams: asOptional(asArray(asPublicGroup), []),
  /** For a league: which of its seasons each of its teams is in. */
  teamSeasons: asOptional(
    asArray(asObject({ teamId: asString, seasonIds: asArray(asString) })),
    []
  ),
  canViewPrivate: asOptional(asBoolean, false),
  /**
   * Anybody signed in who is not a member of this team, following it or
   * not: the team page shows names without pictures, the schedule and each
   * game's score, and says the figures and the video are for members. False
   * for members, for nobody signed in, and on every season and league.
   */
  nonMemberView: asBoolean,
  canManage: asBoolean,
  /**
   * An administrator, coach or assistant of this group: they open anybody on
   * its people list and give or take away every role there but Admin.
   */
  canManagePeople: asOptional(asBoolean),
  /**
   * Whether this viewer reads the group's people list with its photos: its
   * members and role holders. A season's and league's People tab is theirs.
   */
  canSeePeople: asOptional(asBoolean),
  /**
   * An administrator, coach, assistant or scorekeeper of this team: they add
   * and create its players. False on every season and league.
   */
  canManageRoster: asOptional(asBoolean, false),
  /** What this level stores: null is Default, which inherits. */
  playerNamePrivacy: asOptional(asEither(asNull, asPlayerNamePrivacy), null),
  /** The format this level's players are shown in. */
  playerNamePrivacyFormat: asOptional(
    asPlayerNamePrivacy,
    DEFAULT_PLAYER_NAME_PRIVACY
  ),
  /** The closest levels whose value won; empty for no inheritance. */
  playerNamePrivacyInheritedFrom: asOptional(
    asArray(
      asObject({
        kind: asValue('league', 'season', 'team'),
        id: asString,
        name: asString
      })
    ),
    () => []
  ),
  /**
   * A season's or team's own Playing Time Rules, for its administrators
   * only: null is none on a season, and on a team follows its season's.
   */
  playingTimeRules: asOptional(nullable(asPlayingTimeRules), null),
  /**
   * For a team's administrators: the rules of the managing season it
   * follows, the latest-starting one that has rules, or null for none.
   */
  seasonPlayingTimeRules: asOptional(
    nullable(
      asObject({
        season: asObject({ id: asString, name: asString }),
        rules: asPlayingTimeRules
      })
    ),
    null
  )
})
export type GroupDetail = ReturnType<typeof asGroupDetail>
