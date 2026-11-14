/**
 * Node administration's User Management: the rows its activity lists and its
 * people search answer, shared by the server that writes them and the app
 * that reads them.
 */

/** Rows a page of recent logins or sessions holds, unless it asks for fewer. */
export const ACTIVITY_PAGE_SIZE = 50
/** The most rows one page of activity answers. */
export const ACTIVITY_PAGE_MAX = 100

/** The app a sign-in was made in, as far as what it sent says. */
export type AppType = 'Web' | 'iOS' | 'Android' | 'tvOS' | 'Unknown'

/**
 * One login, or one device session: who, on what, and when.
 *
 * `at` is the login's time or the session's start. `lastActiveAt` is the
 * account's latest use of any of its sign-ins, tokens or keys, not this
 * row's: the same on every row of one person.
 */
export interface ActivityRow {
  id: string
  at: string
  userId: string
  displayName: string
  email: string | null
  avatarUrl: string | null
  lastActiveAt: string | null
  device: string
  appType: AppType
}

/** One person a node administrator's search found, as Add Person draws them. */
export interface DirectoryPerson {
  userId: string
  displayName: string
  avatarUrl: string | null
  /** The address that matched the search, or their primary. */
  email: string | null
  /** The quieter line under the name: their players, guardians and teams. */
  affiliations: string
}

/** A role on a team, season or league, as User Management words it. */
export type AffiliationRole =
  | 'admin'
  | 'head coach'
  | 'coach'
  | 'assistant'
  | 'scorekeeper'
  | 'songkeeper'
  | 'videographer'
  | 'player'
  | 'member'
  | 'following'

/** A team, season or league somebody belongs to, holds a role on or follows. */
export interface Affiliation {
  kind: 'team' | 'season' | 'league'
  id: string
  name: string
  roles: AffiliationRole[]
}

/** One account, as a node administrator opens it from the search. */
export interface PersonAdministration {
  userId: string
  displayName: string
  avatarUrl: string | null
  emails: Array<{ email: string; isPrimary: boolean; isVerified: boolean }>
  lastActiveAt: string | null
  affiliations: Affiliation[]
}
