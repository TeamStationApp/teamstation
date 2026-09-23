import { asArray, asValue, type Cleaner } from 'cleaners'

/**
 * What somebody may do on a league, a season or a team, besides watch.
 *
 * Four flags, each independent of the others, and one role above them all.
 * A flag set on a league reaches its seasons and their teams, a season's
 * reaches its teams, and a team's reaches that team alone. An administrator
 * of any of those holds every flag without having one set: `admin` is the
 * role that can do everything, and the flags are the pieces of it that can
 * be handed out one at a time.
 *
 * - **coach**: edits each player's settings, and sees their whole name.
 * - **scorekeeper**: scores games.
 * - **songkeeper**: sets walk-up songs and DJs a game.
 * - **videographer**: films and streams the team's games.
 */
export const ROLE_FLAGS = [
  'coach',
  'scorekeeper',
  'songkeeper',
  'videographer'
] as const
export type RoleFlag = (typeof ROLE_FLAGS)[number]
export type Role = 'admin' | RoleFlag

/** Every role, administrator first, in the order the app lists them. */
export const ROLES: readonly Role[] = ['admin', ...ROLE_FLAGS]

export const asRoleFlag: Cleaner<RoleFlag> = asValue(...ROLE_FLAGS)
export const asRole: Cleaner<Role> = asValue('admin', ...ROLE_FLAGS)

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
 * coach of it, or its administrator, who holds every flag. The app offers a
 * player's Settings tab on this; the server decides again on the save.
 */
export function coachesTeam(
  roles: { teams: Record<string, readonly Role[]> } | undefined,
  teamId: string | undefined
): boolean {
  if (roles == null || teamId == null) return false
  const held = roles.teams[teamId] ?? []
  return held.includes('coach') || held.includes('admin')
}

/**
 * Whether the signed-in person keeps this team's walk-up songs, from
 * `GET /me/roles`: a songkeeper of it, or its administrator. The app offers a
 * player's Walk-up tab on this; the server decides again on every change.
 */
export function keepsSongs(
  roles: { teams: Record<string, readonly Role[]> } | undefined,
  teamId: string | undefined
): boolean {
  if (roles == null || teamId == null) return false
  const held = roles.teams[teamId] ?? []
  return held.includes('songkeeper') || held.includes('admin')
}
