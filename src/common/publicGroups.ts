import {
  asArray,
  asBoolean,
  asNumber,
  asObject,
  asOptional,
  asString
} from 'cleaners'

import { asLiteral } from './asLiteral'
import { asLocality } from './locality'

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
export const asPublicGame = asObject({
  id: asString,
  homeTeam: asObject({ id: asString, name: asString }),
  awayTeam: asObject({ id: asString, name: asString }),
  seasonId: nullable(asString),
  startAt: asString,
  venue: nullable(asString),
  exhibition: asOptional(asBoolean, false),
  timezone: asOptional(asString, 'UTC'),
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
export type PublicGame = ReturnType<typeof asPublicGame>
export const asGroupDetail = asObject({
  group: asPublicGroup,
  parents: asArray(asPublicGroup),
  children: asArray(asPublicGroup),
  participatingSeasons: asArray(asPublicGroup),
  competingTeams: asArray(asPublicGroup),
  staff: asArray(asObject({ name: asString, roles: asArray(asString) })),
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
  canSeePeople: asOptional(asBoolean)
})
export type GroupDetail = ReturnType<typeof asGroupDetail>
