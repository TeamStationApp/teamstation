import AsyncStorage from '@react-native-async-storage/async-storage'

import { asStoredUser, type StoredUser } from './storedUser'

/**
 * Where a session token is kept between launches.
 *
 * A browser has a cookie jar and an app does not, which the server already
 * knows — `server/auth/tokens.ts` reads an `Authorization` header first and
 * says why. So the token the sign-in returns is kept here and handed to the
 * client at start-up, and signing in is something a person does once rather
 * than every time they open the app.
 *
 * `AsyncStorage` rather than the keychain: this is a bearer token for watching
 * a children's baseball league, it expires on its own, and the keychain would
 * add a native dependency and a prompt for no threat this app faces. It is
 * still private to the app on both platforms.
 */
const KEY = 'ts.session.token'
/** Who the last good `whoAmI` said that token is: `{ id, displayName, isAdmin }`. */
const USER_KEY = 'ts.session.user'

export async function loadToken(): Promise<string | undefined> {
  try {
    return (await AsyncStorage.getItem(KEY)) ?? undefined
  } catch {
    // A store that will not open is a person who has to sign in again, which
    // is a nuisance rather than a failure worth stopping the app for.
    return undefined
  }
}

export async function saveToken(token: string | undefined): Promise<void> {
  try {
    if (token == null) await AsyncStorage.removeItem(KEY)
    else await AsyncStorage.setItem(KEY, token)
  } catch {
    // As above: the session stays good for this launch either way.
  }
}

/** Who was signed in at the last good answer, for a launch with no signal. */
export async function loadUser(): Promise<StoredUser | undefined> {
  try {
    const kept = await AsyncStorage.getItem(USER_KEY)
    return kept == null ? undefined : asStoredUser(JSON.parse(kept))
  } catch {
    // Unreadable is the same as unknown: the server is asked as before.
    return undefined
  }
}

export async function saveUser(user: StoredUser | undefined): Promise<void> {
  try {
    if (user == null) await AsyncStorage.removeItem(USER_KEY)
    else await AsyncStorage.setItem(USER_KEY, JSON.stringify(user))
  } catch {
    // As with the token: this launch is unaffected.
  }
}
