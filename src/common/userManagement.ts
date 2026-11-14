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
