import type { StoredUser } from './storedUser'

/**
 * Where a session token is kept between launches.
 *
 * Nowhere, on the web. The session there is an `HttpOnly` cookie the browser
 * keeps and this code cannot read, which is the stronger arrangement and the
 * reason the client has a cookie path at all. These functions exist so the
 * shell can call them unconditionally.
 */
export async function loadToken(): Promise<string | undefined> {
  return undefined
}

export async function saveToken(_token: string | undefined): Promise<void> {
  // The cookie is the store.
}

/**
 * Who was signed in, kept beside the token on a phone. The web asks the
 * server each time, so there is nobody here.
 */
export async function loadUser(): Promise<StoredUser | undefined> {
  return undefined
}

export async function saveUser(_user: StoredUser | undefined): Promise<void> {
  // Nothing is kept.
}
