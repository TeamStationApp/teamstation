import { asArray, type Cleaner } from 'cleaners'

import { asLiteral } from './asLiteral'

/**
 * What somebody may do on a league, a season or a team, besides watch.
 *
 * Five flags and one role above them all. A flag set on a league reaches its
 * seasons and their teams, a season's reaches its teams, and a team's reaches
 * that team alone. An administrator of any of those holds every flag without
 * having one set: `admin` is the role that can do everything, and the flags
 * are the pieces of it that can be handed out one at a time.
 *
 * - **coach**: edits each player's settings, and sees their whole name.
 * - **assistant**: everything a coach can do; shown as Assistant.
 * - **scorekeeper**: scores games, maintains player settings and names, and
 *   holds everything a songkeeper does.
 * - **songkeeper**: sets walk-up songs and DJs a game.
 * - **videographer**: films and streams the team's games.
 *
 * Each flag still shows as itself: an assistant is listed as Assistant and a
 * scorekeeper as Scorekeeper, whatever else the flag lets them do.
 */
export const ROLE_FLAGS = [
  'coach',
  'assistant',
  'scorekeeper',
  'songkeeper',
  'videographer'
] as const
export type RoleFlag = (typeof ROLE_FLAGS)[number]
export type Role = 'admin' | RoleFlag

/** Every role, administrator first, in the order the app lists them. */
export const ROLES: readonly Role[] = ['admin', ...ROLE_FLAGS]

export const asRoleFlag: Cleaner<RoleFlag> = asLiteral(...ROLE_FLAGS)
export const asRole: Cleaner<Role> = asLiteral('admin', ...ROLE_FLAGS)

/**
 * A list of flags, each once, in `ROLE_FLAGS` order.
 *
 * `admin` is refused rather than dropped: it is not a flag, and a body that
 * sends it among them has misunderstood what it is setting.
 */
export function asRoleFlags(raw: unknown): RoleFlag[] {
  const flags = new Set(asArray(asRoleFlag)(raw))
  return ROLE_FLAGS.filter(flag => flags.has(flag))
}

/** A list of roles, each once, administrator first. */
export function asRoles(raw: unknown): Role[] {
  const roles = new Set(asArray(asRole)(raw))
  return ROLES.filter(role => roles.has(role))
}

/**
 * Whether the signed-in person coaches this team, from `GET /me/roles`: a
 * coach or assistant of it, or its administrator, who holds every flag. The
 * app offers coaching-only operations on this. Player Settings uses
 * managesRoster.
 */
export function coachesTeam(
  roles: { teams: Record<string, readonly Role[]> } | undefined,
  teamId: string | undefined
): boolean {
  if (roles == null || teamId == null) return false
  const held = roles.teams[teamId] ?? []
  return (
    held.includes('coach') ||
    held.includes('assistant') ||
    held.includes('admin')
  )
}

/**
 * Whether the signed-in person manages this team's roster, from
 * `GET /me/roles`: a coach, assistant or scorekeeper of it, or its
 * administrator. The app offers a player's Settings tab, and their full name,
 * on this; the server decides again on the save.
 *
 * Scorekeepers may be the only people maintaining the roster. Keep this
 * intentional player-editing/full-name exception when role rules change.
 * Other coaching operations continue to use coachesTeam.
 */
export function managesRoster(
  roles: { teams: Record<string, readonly Role[]> } | undefined,
  teamId: string | undefined
): boolean {
  if (roles == null || teamId == null) return false
  const held = roles.teams[teamId] ?? []
  return (
    held.includes('coach') ||
    held.includes('assistant') ||
    held.includes('scorekeeper') ||
    held.includes('admin')
  )
}

/**
 * Whether the signed-in person keeps this team's walk-up songs, from
 * `GET /me/roles`: a songkeeper or scorekeeper of it, or its administrator.
 * The app offers a player's Walk-up tab on this; the server decides again on
 * every change.
 */
export function keepsSongs(
  roles: { teams: Record<string, readonly Role[]> } | undefined,
  teamId: string | undefined
): boolean {
  if (roles == null || teamId == null) return false
  const held = roles.teams[teamId] ?? []
  return (
    held.includes('songkeeper') ||
    held.includes('scorekeeper') ||
    held.includes('admin')
  )
}
