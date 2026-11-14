import AsyncStorage from '@react-native-async-storage/async-storage'
import { Platform } from 'react-native'
import * as Keychain from 'react-native-keychain'

import { apiBaseUrl } from '../native/config'
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
 * On Android, in `AsyncStorage`, private to the app: nothing but the app's
 * own JavaScript reads it (`chatWakeTask.native.ts` among it).
 *
 * On iOS, in the keychain, as one generic password at
 * `app.teamstation.session`, readable after the phone's first unlock: the
 * notification extension reads it there, from the app's keychain group, to
 * open a chat wake in the background (`ChatWakeDecryptor.swift`). Its account
 * is the API's base URL, which the extension calls with the token. A token in
 * `AsyncStorage` (an older build's, or one the keychain would not keep) is
 * moved into the keychain the next time it is read. A keychain that will not
 * keep the token, or will not be read, leaves it in `AsyncStorage`, as
 * before: the person stays signed in, and only the extension goes without.
 *
 * iOS keeps a keychain item after the app is deleted, and `AsyncStorage`
 * goes with the app. So a token is kept with a mark in `AsyncStorage`,
 * written before the item, and one found without it was left by an earlier
 * install: it is removed, and a reinstalled app starts signed out, as it did
 * before.
 */
export const SESSION_SERVICE = 'app.teamstation.session'
const KEY = 'ts.session.token'
/** This install kept the keychain's token. */
const KEPT_KEY = 'ts.session.keychain'
/** Who the last good `whoAmI` said that token is: `{ id, displayName, isAdmin }`. */
const USER_KEY = 'ts.session.user'

/** The part of `react-native-keychain` this store uses. */
export type SessionKeychain = Pick<
  typeof Keychain,
  'getGenericPassword' | 'setGenericPassword' | 'resetGenericPassword'
> & { ACCESSIBLE: Pick<typeof Keychain.ACCESSIBLE, 'AFTER_FIRST_UNLOCK'> }

/** The part of `AsyncStorage` this store uses. */
export type SessionStorage = Pick<
  typeof AsyncStorage,
  'getItem' | 'setItem' | 'removeItem'
>

export interface SessionStore {
  loadToken: () => Promise<string | undefined>
  saveToken: (token: string | undefined) => Promise<void>
  loadUser: () => Promise<StoredUser | undefined>
  saveUser: (user: StoredUser | undefined) => Promise<void>
}

/** Runs `step`, and answers whether it finished. */
async function done(step: () => Promise<unknown>): Promise<boolean> {
  try {
    await step()
    return true
  } catch {
    return false
  }
}

export function sessionStore(
  keychain: SessionKeychain,
  storage: SessionStorage,
  baseUrl: string = apiBaseUrl,
  os: string = Platform.OS
): SessionStore {
  const service = { service: SESSION_SERVICE }

  /**
   * Puts the token in the keychain, the mark first; answers whether it is
   * there. Without the mark the item would read as an earlier install's. A
   * save that fails takes the mark back, so whatever older token the keychain
   * still holds is never read as this one.
   */
  async function inKeychain(token: string): Promise<boolean> {
    if (
      !(await done(async () => {
        await storage.setItem(KEPT_KEY, '1')
      }))
    )
      return false
    let saved = false
    try {
      saved =
        (await keychain.setGenericPassword(baseUrl, token, {
          ...service,
          accessible: keychain.ACCESSIBLE.AFTER_FIRST_UNLOCK
        })) !== false
    } catch {}
    if (!saved)
      await done(async () => {
        await storage.removeItem(KEPT_KEY)
      })
    return saved
  }

  /** The token in `AsyncStorage`, moved into the keychain when it will take it. */
  async function fromStorage(): Promise<string | undefined> {
    const left = await storage.getItem(KEY)
    if (left == null) return undefined
    // Deleted only once it is kept: a failed save or delete reads it here
    // again, and this launch has the token either way.
    if (await inKeychain(left))
      await done(async () => {
        await storage.removeItem(KEY)
      })
    return left
  }

  async function loadIos(): Promise<string | undefined> {
    let found: false | { password: string }
    try {
      found = await keychain.getGenericPassword(service)
    } catch {
      // A keychain that will not open now may next launch: the copy in
      // `AsyncStorage`, if there is one, signs in meanwhile.
      return (await storage.getItem(KEY)) ?? undefined
    }
    if (found === false) return await fromStorage()
    if ((await storage.getItem(KEPT_KEY)) != null) return found.password
    // An earlier install's session, not this one's.
    await done(async () => await keychain.resetGenericPassword(service))
    return await fromStorage()
  }

  async function saveIos(token: string | undefined): Promise<void> {
    if (token == null) {
      await done(async () => await keychain.resetGenericPassword(service))
      await done(async () => {
        await storage.removeItem(KEY)
      })
      await done(async () => {
        await storage.removeItem(KEPT_KEY)
      })
      return
    }
    if (await inKeychain(token)) {
      await done(async () => {
        await storage.removeItem(KEY)
      })
      return
    }
    // Kept in `AsyncStorage` instead, and the keychain's older token taken
    // away, or else disowned, so it is never read in this one's place.
    await done(async () => {
      await storage.setItem(KEY, token)
    })
    if (!(await done(async () => await keychain.resetGenericPassword(service))))
      await done(async () => {
        await storage.removeItem(KEPT_KEY)
      })
  }

  return {
    async loadToken() {
      try {
        if (os === 'ios') return await loadIos()
        return (await storage.getItem(KEY)) ?? undefined
      } catch {
        // A store that will not open is a person who has to sign in again,
        // which is a nuisance rather than a failure worth stopping the app for.
        return undefined
      }
    },

    async saveToken(token) {
      try {
        if (os === 'ios') await saveIos(token)
        else if (token == null) await storage.removeItem(KEY)
        else await storage.setItem(KEY, token)
      } catch {
        // As above: the session stays good for this launch either way.
      }
    },

    /** Who was signed in at the last good answer, for a launch with no signal. */
    async loadUser() {
      try {
        const kept = await storage.getItem(USER_KEY)
        return kept == null ? undefined : asStoredUser(JSON.parse(kept))
      } catch {
        // Unreadable is the same as unknown: the server is asked as before.
        return undefined
      }
    },

    async saveUser(user) {
      try {
        if (user == null) await storage.removeItem(USER_KEY)
        else await storage.setItem(USER_KEY, JSON.stringify(user))
      } catch {
        // As with the token: this launch is unaffected.
      }
    }
  }
}

const phone = sessionStore(Keychain, AsyncStorage)

export const loadToken = phone.loadToken
export const saveToken = phone.saveToken
export const loadUser = phone.loadUser
export const saveUser = phone.saveUser
