import { expect } from 'chai'
import { afterEach, describe, it } from 'mocha'

import { userIdOfGumbo } from '../../common/userId'
import type * as Config from '../native/config'
import type * as SessionModule from './sessionStore.native'

/**
 * The phone's session store, on stand-ins for `react-native-keychain` and
 * `AsyncStorage`, whose real modules need React Native's native side. The
 * stand-ins are put where Node would load the packages from, as
 * `keyStore.native.test.ts` does.
 */
interface Item {
  username: string
  password: string
  options: Record<string, unknown> | undefined
}

function keychainOf(): {
  items: Map<string, Item>
  refuse: boolean
  locked: boolean
  /** Only saving throws, as a Keystore key invalidated by the OS does. */
  saveThrows: boolean
  readThrows: boolean
  resetThrows: boolean
  ACCESSIBLE: { AFTER_FIRST_UNLOCK: string }
  getGenericPassword: (options: {
    service: string
  }) => Promise<false | { username: string; password: string }>
  setGenericPassword: (
    username: string,
    password: string,
    options: { service: string; accessible: string }
  ) => Promise<false | { service: string; storage: string }>
  resetGenericPassword: (options: { service: string }) => Promise<boolean>
} {
  const keychain = {
    items: new Map<string, Item>(),
    refuse: false,
    locked: false,
    saveThrows: false,
    readThrows: false,
    resetThrows: false,
    ACCESSIBLE: { AFTER_FIRST_UNLOCK: 'AccessibleAfterFirstUnlock' },
    async getGenericPassword(options: { service: string }) {
      if (keychain.locked || keychain.readThrows)
        throw new Error('User interaction is not allowed')
      const found = keychain.items.get(options.service)
      return found == null
        ? (false as const)
        : { username: found.username, password: found.password }
    },
    async setGenericPassword(
      username: string,
      password: string,
      options: { service: string; accessible: string }
    ) {
      if (keychain.locked) throw new Error('User interaction is not allowed')
      if (keychain.saveThrows) throw new Error('KeyPermanentlyInvalidated')
      if (keychain.refuse) return false as const
      keychain.items.set(options.service, { username, password, options })
      return { service: options.service, storage: 'keychain' }
    },
    async resetGenericPassword(options: { service: string }) {
      if (keychain.locked || keychain.resetThrows)
        throw new Error('User interaction is not allowed')
      return keychain.items.delete(options.service)
    }
  }
  return keychain
}

function storageOf(): {
  values: Map<string, string>
  broken: boolean
  getItem: (key: string) => Promise<string | null>
  setItem: (key: string, value: string) => Promise<void>
  removeItem: (key: string) => Promise<void>
} {
  const storage = {
    values: new Map<string, string>(),
    broken: false,
    async getItem(key: string) {
      if (storage.broken) throw new Error('The store will not open')
      return storage.values.get(key) ?? null
    },
    async setItem(key: string, value: string) {
      if (storage.broken) throw new Error('The store will not open')
      storage.values.set(key, value)
    },
    async removeItem(key: string) {
      if (storage.broken) throw new Error('The store will not open')
      storage.values.delete(key)
    }
  }
  return storage
}

const reactNative = require.resolve('react-native')
const keychainPath = require.resolve('react-native-keychain')
const storagePath = require.resolve('@react-native-async-storage/async-storage')
const file = require.resolve('./sessionStore.native')

const stand = (path: string, exports: unknown): void => {
  require.cache[path] = {
    id: path,
    filename: path,
    loaded: true,
    exports
  } as unknown as NodeJS.Module
}

/** The module, over these stand-ins, with `TSPush`'s cookie jar `jar` (URL → token). */
function load(
  keychain: ReturnType<typeof keychainOf>,
  storage: ReturnType<typeof storageOf>,
  os = 'ios',
  jar?: Map<string, string>
): typeof SessionModule {
  Reflect.deleteProperty(require.cache, file)
  stand(reactNative, {
    Platform: { OS: os },
    TurboModuleRegistry: {
      get: (name: string) =>
        name !== 'TSPush' || jar == null
          ? null
          : {
              sessionCookie: async (url: string) => jar.get(url) ?? null,
              clearSessionCookie: async (url: string) => {
                jar.delete(url)
              }
            }
    }
  })
  stand(keychainPath, keychain)
  stand(storagePath, { __esModule: true, default: storage })
  return require('./sessionStore.native') as typeof SessionModule
}

const BASE = 'https://api.example.test/api/v1'

/** A cookie jar (URL → token), recording what was read and cleared. */
function jarOf(entries: Array<[string, string]>): SessionModule.SessionJar & {
  cookies: Map<string, string>
  asked: string[]
  cleared: string[]
} {
  const cookies = new Map(entries)
  const asked: string[] = []
  const cleared: string[] = []
  return {
    cookies,
    asked,
    cleared,
    read: async url => {
      asked.push(url)
      return cookies.get(url)
    },
    clear: async url => {
      cleared.push(url)
      cookies.delete(url)
    }
  }
}

/** The stand-in as the store's type: only the calls it makes are there. */
const asKeychain = (
  keychain: ReturnType<typeof keychainOf>
): SessionModule.SessionKeychain =>
  keychain as unknown as SessionModule.SessionKeychain

describe('the phone session store', function () {
  afterEach(function () {
    for (const path of [file, reactNative, keychainPath, storagePath])
      Reflect.deleteProperty(require.cache, path)
  })

  it('keeps the token in the keychain, with the API it is for, readable after first unlock', async function () {
    const keychain = keychainOf()
    const storage = storageOf()
    const { sessionStore, SESSION_SERVICE } = load(keychain, storage)
    const store = sessionStore(asKeychain(keychain), storage, async () => BASE)
    expect(await store.loadToken()).equals(undefined)
    await store.saveToken('token-one')
    expect(keychain.items.get(SESSION_SERVICE)).deep.equals({
      username: BASE,
      password: 'token-one',
      options: {
        service: 'app.teamstation.session',
        accessible: 'AccessibleAfterFirstUnlock'
      }
    })
    expect([...storage.values]).deep.equals([['ts.session.keychain', '1']])
    expect(await store.loadToken()).equals('token-one')
    await store.saveToken(undefined)
    expect(keychain.items.size).equals(0)
    expect(storage.values.size).equals(0)
    expect(await store.loadToken()).equals(undefined)
  })

  it('a reinstalled app starts signed out: the token an earlier install left in the keychain is removed', async function () {
    const keychain = keychainOf()
    const storage = storageOf()
    const { sessionStore, SESSION_SERVICE } = load(keychain, storage)
    await sessionStore(
      asKeychain(keychain),
      storage,
      async () => BASE
    ).saveToken('earlier-install')
    // Deleting the app empties its storage; the keychain keeps the item.
    storage.values.clear()
    const store = sessionStore(asKeychain(keychain), storage, async () => BASE)
    expect(await store.loadToken()).equals(undefined)
    expect(keychain.items.has(SESSION_SERVICE)).equals(false)
    // A token an older build left in this install's storage is still moved.
    await sessionStore(
      asKeychain(keychain),
      storage,
      async () => BASE
    ).saveToken('earlier-install')
    storage.values.clear()
    storage.values.set('ts.session.token', 'this-install')
    expect(await store.loadToken()).equals('this-install')
    expect(keychain.items.get(SESSION_SERVICE)?.password).equals('this-install')
  })

  it('moves a token an older build left in AsyncStorage into the keychain, once', async function () {
    const keychain = keychainOf()
    const storage = storageOf()
    storage.values.set('ts.session.token', 'old-token')
    const { sessionStore, SESSION_SERVICE } = load(keychain, storage)
    const store = sessionStore(asKeychain(keychain), storage, async () => BASE)
    expect(await store.loadToken()).equals('old-token')
    expect(keychain.items.get(SESSION_SERVICE)?.password).equals('old-token')
    expect(storage.values.has('ts.session.token')).equals(false)
    storage.values.set('ts.session.token', 'stale')
    expect(await store.loadToken()).equals('old-token')
  })

  it('leaves the old token where it is when the keychain will not keep it, and still signs in', async function () {
    const keychain = keychainOf()
    const storage = storageOf()
    storage.values.set('ts.session.token', 'old-token')
    keychain.refuse = true
    const { sessionStore } = load(keychain, storage)
    const store = sessionStore(asKeychain(keychain), storage, async () => BASE)
    expect(await store.loadToken()).equals('old-token')
    expect(storage.values.get('ts.session.token')).equals('old-token')
    expect(keychain.items.size).equals(0)
    keychain.refuse = false
    expect(await store.loadToken()).equals('old-token')
    expect(storage.values.has('ts.session.token')).equals(false)
  })

  it('keeps the token for this launch when the old copy cannot be deleted', async function () {
    const keychain = keychainOf()
    const storage = storageOf()
    storage.values.set('ts.session.token', 'old-token')
    const { sessionStore } = load(keychain, storage)
    const store = sessionStore(asKeychain(keychain), {
      ...storage,
      removeItem: async () => {
        throw new Error('The store will not write')
      }
    })
    expect(await store.loadToken()).equals('old-token')
  })

  it('signing out removes an old copy too', async function () {
    const keychain = keychainOf()
    const storage = storageOf()
    storage.values.set('ts.session.token', 'old-token')
    const { sessionStore } = load(keychain, storage)
    const store = sessionStore(asKeychain(keychain), storage, async () => BASE)
    await store.saveToken(undefined)
    expect(storage.values.size).equals(0)
    expect(await store.loadToken()).equals(undefined)
  })

  it('a keychain that will not open is a person who signs in again, and nothing throws', async function () {
    const keychain = keychainOf()
    const storage = storageOf()
    keychain.locked = true
    storage.broken = true
    const { sessionStore } = load(keychain, storage)
    const store = sessionStore(asKeychain(keychain), storage, async () => BASE)
    expect(await store.loadToken()).equals(undefined)
    await store.saveToken('token-one')
    await store.saveToken(undefined)
    expect(await store.loadUser()).equals(undefined)
    await store.saveUser(undefined)
  })

  it('keeps the token in AsyncStorage when the keychain refuses it, and takes the older token away', async function () {
    const keychain = keychainOf()
    const storage = storageOf()
    const { sessionStore, SESSION_SERVICE } = load(keychain, storage)
    const store = sessionStore(asKeychain(keychain), storage, async () => BASE)
    await store.saveToken('old-token')
    keychain.refuse = true
    await store.saveToken('new-token')
    expect(storage.values.get('ts.session.token')).equals('new-token')
    expect(keychain.items.has(SESSION_SERVICE)).equals(false)
    expect(await store.loadToken()).equals('new-token')
    // Once the keychain takes it again, it is moved there.
    keychain.refuse = false
    expect(await store.loadToken()).equals('new-token')
    expect(keychain.items.get(SESSION_SERVICE)?.password).equals('new-token')
    expect(storage.values.has('ts.session.token')).equals(false)
  })

  it('keeps the token in AsyncStorage when saving throws, and disowns an older token it cannot take away', async function () {
    const keychain = keychainOf()
    const storage = storageOf()
    const { sessionStore, SESSION_SERVICE } = load(keychain, storage)
    const store = sessionStore(asKeychain(keychain), storage, async () => BASE)
    await store.saveToken('old-token')
    keychain.saveThrows = true
    keychain.resetThrows = true
    await store.saveToken('new-token')
    expect(storage.values.get('ts.session.token')).equals('new-token')
    // The revoked token is still there, without the mark that owns it.
    expect(keychain.items.get(SESSION_SERVICE)?.password).equals('old-token')
    expect(storage.values.has('ts.session.keychain')).equals(false)
    expect(await store.loadToken()).equals('new-token')
    keychain.resetThrows = false
    expect(await store.loadToken()).equals('new-token')
    expect(keychain.items.has(SESSION_SERVICE)).equals(false)
  })

  it('a keychain read that throws signs in from AsyncStorage, and leaves the keychain as it is', async function () {
    const keychain = keychainOf()
    const storage = storageOf()
    const { sessionStore, SESSION_SERVICE } = load(keychain, storage)
    const store = sessionStore(asKeychain(keychain), storage, async () => BASE)
    await store.saveToken('kept-token')
    keychain.readThrows = true
    expect(await store.loadToken()).equals(undefined)
    storage.values.set('ts.session.token', 'stored-token')
    expect(await store.loadToken()).equals('stored-token')
    // Read again once the keychain opens: nothing was taken away.
    keychain.readThrows = false
    storage.values.delete('ts.session.token')
    expect(keychain.items.get(SESSION_SERVICE)?.password).equals('kept-token')
    expect(await store.loadToken()).equals('kept-token')
  })

  it('writes the mark before the keychain item, and keeps the token in AsyncStorage when the mark will not write', async function () {
    const keychain = keychainOf()
    const storage = storageOf()
    const order: string[] = []
    const { sessionStore, SESSION_SERVICE } = load(keychain, storage)
    const set = keychain.setGenericPassword
    keychain.setGenericPassword = async (...args) => {
      order.push('keychain')
      return await set(...args)
    }
    let markFails = false
    const marking: typeof storage = {
      ...storage,
      setItem: async (key, value) => {
        if (key === 'ts.session.keychain') {
          order.push('mark')
          if (markFails) throw new Error('The store will not write')
        }
        await storage.setItem(key, value)
      }
    }
    const store = sessionStore(asKeychain(keychain), marking, async () => BASE)
    await store.saveToken('old-token')
    expect(order).deep.equals(['mark', 'keychain'])
    markFails = true
    storage.values.delete('ts.session.keychain')
    await store.saveToken('new-token')
    // Never written without its mark, which would read as a leftover.
    expect(order).deep.equals(['mark', 'keychain', 'mark'])
    expect(keychain.items.has(SESSION_SERVICE)).equals(false)
    expect(storage.values.get('ts.session.token')).equals('new-token')
    expect(await store.loadToken()).equals('new-token')
  })

  it('on Android keeps the token in AsyncStorage, as before, and never touches the keychain', async function () {
    const keychain = keychainOf()
    const storage = storageOf()
    const loaded = load(keychain, storage, 'android')
    keychain.items.set(loaded.SESSION_SERVICE, {
      username: BASE,
      password: 'keychain-token',
      options: undefined
    })
    keychain.locked = true
    const store = loaded.sessionStore(
      asKeychain(keychain),
      storage,
      async () => BASE
    )
    expect(await store.loadToken()).equals(undefined)
    await loaded.saveToken('android-token')
    expect([...storage.values]).deep.equals([
      ['ts.session.token', 'android-token']
    ])
    expect(await loaded.loadToken()).equals('android-token')
    await loaded.saveToken(undefined)
    expect(storage.values.size).equals(0)
    expect(keychain.items.get(loaded.SESSION_SERVICE)?.password).equals(
      'keychain-token'
    )
    storage.broken = true
    expect(await loaded.loadToken()).equals(undefined)
    await loaded.saveToken('android-token')
  })

  it('a phone that keeps no token takes the session cookie’s, for the API this launch talks to, and keeps it', async function () {
    const keychain = keychainOf()
    const storage = storageOf()
    const { sessionStore, SESSION_SERVICE } = load(keychain, storage)
    let api = BASE
    const jar = jarOf([[BASE, 'cookie-token']])
    const store = sessionStore(
      asKeychain(keychain),
      storage,
      async () => api,
      'ios',
      jar
    )
    // Signed in on the cookie alone: the state a refused request leaves.
    expect(await store.loadToken()).equals('cookie-token')
    expect(jar.asked).deep.equals([BASE])
    expect(keychain.items.get(SESSION_SERVICE)).deep.include({
      username: BASE,
      password: 'cookie-token'
    })
    // A kept token is the one used: the cookie is not read again.
    jar.cookies.set(BASE, 'newer-cookie')
    expect(await store.loadToken()).equals('cookie-token')
    expect(jar.asked).deep.equals([BASE])
    // Confirmed by `whoAmI`, which keeps the same token: the jar is left be.
    await store.saveToken('cookie-token')
    expect(jar.cleared).deep.equals([])
    // A develop build's server override: that API's cookie, kept for it.
    await keychain.resetGenericPassword({ service: SESSION_SERVICE })
    api = 'https://override.example.test/api/v1'
    jar.cookies.set(api, 'override-cookie')
    expect(await store.loadToken()).equals('override-cookie')
    expect(keychain.items.get(SESSION_SERVICE)?.username).equals(api)
  })

  it('a token taken from the cookie and then refused takes the cookie out of the jar, so the next launch does not take it again', async function () {
    const keychain = keychainOf()
    const storage = storageOf()
    const { sessionStore } = load(keychain, storage)
    const jar = jarOf([[BASE, 'dead-cookie']])
    const launch = (): SessionModule.SessionStore =>
      sessionStore(asKeychain(keychain), storage, async () => BASE, 'ios', jar)
    const first = launch()
    expect(await first.loadToken()).equals('dead-cookie')
    // `whoAmI` answers nobody: the app drops the token.
    await first.saveToken(undefined)
    expect(jar.cleared).deep.equals([BASE])
    expect(keychain.items.size).equals(0)
    expect(storage.values.size).equals(0)
    // The next launch finds neither, and reads the jar once.
    expect(await launch().loadToken()).equals(undefined)
    expect(jar.asked).deep.equals([BASE, BASE])
  })

  it('a kept token refused leaves the jar as it is, and so does a new sign-in after a cookie’s token', async function () {
    const keychain = keychainOf()
    const storage = storageOf()
    const { sessionStore } = load(keychain, storage)
    const jar = jarOf([[BASE, 'cookie-token']])
    const kept = sessionStore(
      asKeychain(keychain),
      storage,
      async () => BASE,
      'ios',
      jar
    )
    await kept.saveToken('signed-in')
    expect(await kept.loadToken()).equals('signed-in')
    await kept.saveToken(undefined)
    expect(jar.cleared).deep.equals([])
    // Taken from the cookie, then replaced by a sign-in's own token: that
    // token's refusal is not the cookie's.
    const restored = sessionStore(
      asKeychain(keychain),
      storage,
      async () => BASE,
      'ios',
      jar
    )
    expect(await restored.loadToken()).equals('cookie-token')
    await restored.saveToken('token-two')
    await restored.saveToken(undefined)
    expect(jar.cleared).deep.equals([])
  })

  it('a sign-out whose logout never lands: the app takes the cookie out first, and the next cold launch stays signed out', async function () {
    const keychain = keychainOf()
    const storage = storageOf()
    const { sessionStore } = load(keychain, storage)
    // Signed in with a password: the token kept, and the API's cookie set.
    const jar = jarOf([[BASE, 'token-one']])
    const launch = (): SessionModule.SessionStore =>
      sessionStore(asKeychain(keychain), storage, async () => BASE, 'ios', jar)
    const running = launch()
    await running.saveToken('token-one')
    // Sign Out: the cookie goes, then the kept token; the logout, whose
    // answer would have cleared the cookie, never reaches the server.
    await running.forgetCookie()
    await running.saveToken(undefined)
    expect(jar.cleared).deep.equals([BASE])
    expect(jar.cookies.size).equals(0)
    expect(await launch().loadToken()).equals(undefined)
    expect(keychain.items.size).equals(0)
  })

  it('a jar that will not be cleared is no failure', async function () {
    const keychain = keychainOf()
    const storage = storageOf()
    const { sessionStore } = load(keychain, storage)
    const jar = jarOf([[BASE, 'cookie-token']])
    jar.clear = async () => {
      throw new Error('no cookie jar')
    }
    const store = sessionStore(
      asKeychain(keychain),
      storage,
      async () => BASE,
      'ios',
      jar
    )
    await store.forgetCookie()
    expect(await store.loadToken()).equals('cookie-token')
    await store.saveToken(undefined)
    expect(keychain.items.size).equals(0)
  })

  it('a jar that holds nothing, an empty cookie or a jar that will not be read leaves the launch on the cookie alone', async function () {
    for (const read of [
      async () => null,
      async () => '',
      async () => {
        throw new Error('no cookie jar')
      }
    ]) {
      const keychain = keychainOf()
      const storage = storageOf()
      const { sessionStore } = load(keychain, storage)
      const store = sessionStore(
        asKeychain(keychain),
        storage,
        async () => BASE,
        'ios',
        { read, clear: async () => undefined }
      )
      expect(await store.loadToken()).equals(undefined)
      expect(keychain.items.size).equals(0)
      expect(storage.values.size).equals(0)
    }
  })

  it('on Android the cookie’s token is kept in AsyncStorage, and its refusal clears the jar', async function () {
    const keychain = keychainOf()
    const storage = storageOf()
    const { sessionStore } = load(keychain, storage, 'android')
    const jar = jarOf([[BASE, 'android-cookie']])
    const store = sessionStore(
      asKeychain(keychain),
      storage,
      async () => BASE,
      'android',
      jar
    )
    expect(await store.loadToken()).equals('android-cookie')
    expect([...storage.values]).deep.equals([
      ['ts.session.token', 'android-cookie']
    ])
    expect(keychain.items.size).equals(0)
    await store.saveToken(undefined)
    expect(storage.values.size).equals(0)
    expect(jar.cleared).deep.equals([BASE])
  })

  it('the phone’s own store reads and clears the cookie through TSPush, for the launch’s API, and goes without where the build has no TSPush', async function () {
    const config = require('../native/config') as typeof Config
    const keychain = keychainOf()
    const storage = storageOf()
    const cookies = new Map([[config.apiBaseUrl, 'jar-token']])
    const loaded = load(keychain, storage, 'ios', cookies)
    expect(await loaded.loadToken()).equals('jar-token')
    expect(keychain.items.get(loaded.SESSION_SERVICE)?.username).equals(
      config.apiBaseUrl
    )
    await loaded.forgetSessionCookie()
    expect(cookies.size).equals(0)
    const bare = load(keychainOf(), storageOf())
    expect(await bare.loadToken()).equals(undefined)
    await bare.forgetSessionCookie()
  })

  it('keeps who was signed in beside the token, in AsyncStorage', async function () {
    const keychain = keychainOf()
    const storage = storageOf()
    const loaded = load(keychain, storage)
    const user = {
      id: userIdOfGumbo(7),
      displayName: 'Ichiro S',
      isAdmin: true
    }
    expect(await loaded.loadUser()).equals(undefined)
    await loaded.saveUser(user)
    expect(JSON.parse(storage.values.get('ts.session.user') ?? '')).deep.equals(
      user
    )
    expect(await loaded.loadUser()).deep.equals(user)
    storage.values.set('ts.session.user', '{not json')
    expect(await loaded.loadUser()).equals(undefined)
    await loaded.saveUser(undefined)
    expect(storage.values.has('ts.session.user')).equals(false)
  })

  it('the phone’s own store keeps the token under the build’s API', async function () {
    const keychain = keychainOf()
    const storage = storageOf()
    const loaded = load(keychain, storage)
    await loaded.saveToken('token-two')
    expect(await loaded.loadToken()).equals('token-two')
    expect(keychain.items.get(loaded.SESSION_SERVICE)?.username).matches(
      /^https?:\/\/.+\/api\/v1$/
    )
  })
})
