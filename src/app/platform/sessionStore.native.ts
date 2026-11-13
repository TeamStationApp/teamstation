import AsyncStorage from '@react-native-async-storage/async-storage'
import { Platform, TurboModuleRegistry } from 'react-native'
import * as Keychain from 'react-native-keychain'

import { launchApi } from '../native/launchApi'
import type { Spec as PushSpec } from '../push/NativePush'
import { asStoredUser, type StoredUser } from './storedUser'

/**
 * Where a session token is kept between launches.
 *
 * A browser keeps the session in an `HttpOnly` cookie and sends it by
 * itself. The app keeps that cookie too, in its own cookie jar (below), but
 * sends its session as an `Authorization` header, which
 * `server/auth/tokens.ts` reads first: what calls the API outside the app's
 * networking (the notification extension, Android's background tasks)
 * cannot reach the jar and needs the token itself. So the token the sign-in returns
 * is kept here and handed to the client at start-up, and signing in is
 * something a person does once rather than every time they open the app.
 *
 * On Android, in `AsyncStorage`, private to the app: nothing but the app's
 * own JavaScript reads it (`chatWakeTask.native.ts` among it).
 *
 * On iOS, in the keychain, as one generic password at
 * `app.teamstation.session`, readable after the phone's first unlock: the
 * notification extension reads it there, from the app's keychain group, to
 * open a chat wake in the background (`ChatWakeDecryptor.swift`). Its account
 * is the API this launch talks to (a develop build's server override
 * included, `launchApi`), which the extension calls with the token. A token in
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
 *
 * The API also sets its session in a cookie (`ts_session`, the same token),
 * which React Native's networking keeps in the app's own cookie jar and sends
 * on every request. So a phone that keeps no token can still be signed in on
 * that cookie: a refused request drops the kept token (`App.tsx`'s
 * `sessionRefused`) while the cookie stays, and the next launch's `whoAmI`
 * answers on it. Everything in the app then works but what reads the kept
 * token outside it: the notification extension. So `loadToken`, finding no
 * token, takes the cookie's for the API this launch talks to and keeps it,
 * and the app's `whoAmI` confirms it with the header; a dead one is answered
 * nobody and dropped there, as a kept token is. It is the session the app
 * was already signed in on, so revoking that session still ends it, and a
 * reinstalled app still starts signed out, since the cookie jar goes with it.
 *
 * So the cookie is a session too, and the app takes it out of the jar itself
 * (`forgetCookie`, `TSPush.clearSessionCookie`) rather than leave that to the
 * server's answer: at sign-out and at an account switch, before the logout
 * is sent (`App.tsx`), so a sign-out whose logout never lands (no signal, the
 * app killed first) does not come back signed in at the next launch; and
 * when a token this launch took from the cookie is dropped (`saveToken`
 * with none: refused, or signed out), since that cookie is the dead session
 * and would only be taken again, launch after launch. A kept token refused
 * leaves the jar as it is: what a refusal clears is the app's call, not the
 * store's.
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

/** The app's cookie jar, as far as its session goes (`TSPush`). */
export interface SessionJar {
  /** The session token in the jar for the API at `baseUrl`, or nothing. */
  read: (baseUrl: string) => Promise<string | null | undefined>
  /** Takes the session cookie for the API at `baseUrl` out of the jar. */
  clear: (baseUrl: string) => Promise<void>
}

export interface SessionStore {
  /** The kept token, or else the session cookie's, kept from now on. */
  loadToken: () => Promise<string | undefined>
  /**
   * Keeps `token`, or none. None, after a token this launch took from the
   * cookie, takes that cookie out of the jar as well.
   */
  saveToken: (token: string | undefined) => Promise<void>
  /**
   * Takes the session cookie for the API this launch talks to out of the
   * jar, for a sign-out; never throws.
   */
  forgetCookie: () => Promise<void>
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

/** The phone's own cookie jar, through `TSPush`, where the build has it. */
const phoneJar: SessionJar = {
  read: async baseUrl =>
    await (TurboModuleRegistry.get<PushSpec>('TSPush')?.sessionCookie(
      baseUrl
    ) ?? null),
  clear: async baseUrl => {
    await TurboModuleRegistry.get<PushSpec>('TSPush')?.clearSessionCookie(
      baseUrl
    )
  }
}

export function sessionStore(
  keychain: SessionKeychain,
  storage: SessionStorage,
  baseUrl: () => Promise<string> = launchApi,
  os: string = Platform.OS,
  jar: SessionJar = phoneJar
): SessionStore {
  const service = { service: SESSION_SERVICE }
  /** The token this launch took from the cookie, while it is the one kept. */
  let fromCookie: string | undefined

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
        (await keychain.setGenericPassword(await baseUrl(), token, {
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

  async function keptToken(): Promise<string | undefined> {
    try {
      if (os === 'ios') return await loadIos()
      return (await storage.getItem(KEY)) ?? undefined
    } catch {
      // A store that will not open is a person who has to sign in again,
      // which is a nuisance rather than a failure worth stopping the app for.
      return undefined
    }
  }

  async function forgetCookie(): Promise<void> {
    await done(async () => {
      await jar.clear(await baseUrl())
    })
  }

  async function keepToken(token: string | undefined): Promise<void> {
    try {
      if (os === 'ios') await saveIos(token)
      else if (token == null) await storage.removeItem(KEY)
      else await storage.setItem(KEY, token)
    } catch {
      // As above: the session stays good for this launch either way.
    }
  }

  return {
    forgetCookie,

    async saveToken(token) {
      const taken = fromCookie
      if (token !== taken) fromCookie = undefined
      await keepToken(token)
      // The cookie it came from is that same session, dropped.
      if (token == null && taken != null) await forgetCookie()
    },

    async loadToken() {
      const kept = await keptToken()
      if (kept != null) return kept
      let found: string | null | undefined
      try {
        found = await jar.read(await baseUrl())
      } catch {
        // A jar that will not be read is a launch on the cookie alone, as before.
        return undefined
      }
      if (found == null || found === '') return undefined
      await keepToken(found)
      fromCookie = found
      return found
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
export const forgetSessionCookie = phone.forgetCookie
export const loadUser = phone.loadUser
export const saveUser = phone.saveUser
