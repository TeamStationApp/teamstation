import { expect } from 'chai'
import { afterEach, describe, it } from 'mocha'

import type { PushRegistration, PushSwitches } from '../../common/api'
import {
  type NotificationSwitches,
  readSwitches,
  writeSwitches
} from './notificationSwitches'
import type {
  PushClient,
  PushDevice,
  PushDeviceOptions,
  ReleaseClient,
  TokenDevice
} from './pushState'
import type { UserSettingStorage } from './userSetting'

const OFF: NotificationSwitches = { messages: false, rsvpEvents: false }
const ON: NotificationSwitches = { messages: true, rsvpEvents: false }
const BOTH: NotificationSwitches = { messages: true, rsvpEvents: true }
/** The signed-in person. */
const U = 'usr_1'

/** What the phone registered and patched, through the API. */
let registered: PushRegistration[] = []
let patched: Array<[string, Partial<PushSwitches>]> = []
const client: PushClient = {
  webPushKey: async () => {
    throw new Error('A phone has no Web Push key')
  },
  registerPush: async registration => {
    registered.push(registration)
    return 'reg-1'
  },
  updatePush: async (id, change) => {
    patched.push([id, change])
    return { ...OFF, leagueManagement: true, ...change }
  }
}

/** The phone's AsyncStorage, which a test can fill first. */
let storage: UserSettingStorage = memory()
function memory(): UserSettingStorage {
  const kept = new Map<string, string>()
  return {
    getItem: async key => kept.get(key) ?? null,
    setItem: async (key, value) => {
      kept.set(key, value)
    }
  }
}
/** Stores `switches` on the phone for the signed-in person. */
const keep = async (switches: NotificationSwitches): Promise<void> => {
  await writeSwitches(U, switches, storage)
}

/**
 * A phone's notifications through `TSPush`, the app's own module. React
 * Native is replaced in the module cache by a registry of this test's, as
 * `NativeChatCrypto.test.ts` does.
 */
const reactNative = require.resolve('react-native')
const file = require.resolve('./pushDevice.native')

/** The module's `askWhenWanted`, loaded as `loadWith` loads it. */
type Ask = (
  device: PushDevice,
  client: PushClient,
  userId: string
) => Promise<string>

/** The module, loaded afresh with `push` as `TSPush` on an `os` phone. */
function load(
  push: object | undefined,
  os = 'android'
): {
  phonePushDevice: (
    module?: () => object | null,
    options?: PushDeviceOptions
  ) => TokenDevice
  askWhenWanted: Ask
} {
  Reflect.deleteProperty(require.cache, file)
  require.cache[reactNative] = {
    id: reactNative,
    filename: reactNative,
    loaded: true,
    exports: {
      Platform: { OS: os },
      TurboModuleRegistry: {
        get: (name: string) => (name === 'TSPush' ? push : null)
      }
    }
  } as unknown as NodeJS.Module
  return require('./pushDevice.native') as ReturnType<typeof load>
}

/**
 * The phone's device with `push` as `TSPush`, its switches in this test's
 * `storage`, and no timer to try again unless `options` says so.
 */
function loadWith(
  push: object | undefined,
  os = 'android',
  options: PushDeviceOptions = {}
): TokenDevice {
  return load(push, os).phonePushDevice(undefined, {
    storage,
    retryMs: [],
    ...options
  })
}

/** The module's `askWhenWanted`, as last loaded. */
const ask = (): Ask =>
  (require('./pushDevice.native') as { askWhenWanted: Ask }).askWhenWanted

const wait = async (ms = 1): Promise<void> => {
  await new Promise(resolve => setTimeout(resolve, ms))
}

/**
 * `TSPush`, now in `permission`, answering a request with `answer`, with
 * `token` as its push address (null: no Firebase in this build).
 */
function module(
  permission: string,
  answer: string,
  token: string | null = null,
  environment = 'production'
): {
  asked: number
  permissionState: () => Promise<string>
  requestPermission: () => Promise<string>
  token: () => Promise<string | null>
  environment: () => Promise<string>
  told: Array<string | null>
  cleared: string[]
  setActiveConversation: (conversationId: string | null) => void
  clear: (tag: string) => void
  released: number
  unregister: () => Promise<void>
  users: Array<string | null>
  setUser: (userId: string | null) => void
} {
  const push = {
    asked: 0,
    released: 0,
    unregister: async () => {
      push.released++
    },
    told: [] as Array<string | null>,
    cleared: [] as string[],
    setActiveConversation: (conversationId: string | null) => {
      push.told.push(conversationId)
    },
    clear: (tag: string) => {
      push.cleared.push(tag)
    },
    users: [] as Array<string | null>,
    setUser: (userId: string | null) => {
      push.users.push(userId)
    },
    permissionState: async () => permission,
    // As the module does: the person is asked only before any answer.
    requestPermission: async () => {
      push.asked++
      if (permission === 'prompt') permission = answer
      return permission
    },
    token: async () => token,
    environment: async () => environment
  }
  return push
}

describe('notifications on a phone', function () {
  afterEach(function () {
    registered = []
    patched = []
    storage = memory()
    Reflect.deleteProperty(require.cache, file)
    Reflect.deleteProperty(require.cache, reactNative)
  })

  it('reads the phone’s permission without asking', async function () {
    for (const state of ['granted', 'denied', 'prompt'] as const) {
      const push = module(state, 'granted')
      const device = loadWith(push)
      expect(await device.state()).equals(state)
      expect(await device.sync(client, U)).equals(state)
      expect(push.asked).equals(0)
    }
    expect(await loadWith(module('restricted', 'granted')).state()).equals(
      'unsupported'
    )
    // The app's own device, as the app loads it.
    expect(
      await (
        require('./pushDevice.native') as { pushDevice: PushDevice }
      ).pushDevice.state()
    ).equals('unsupported')
  })

  it('leaves asking to the module, which asks only once, and answers what the person chose', async function () {
    const allowed = module('prompt', 'granted')
    expect(await loadWith(allowed).enable(client, U)).equals('granted')
    const refused = module('prompt', 'denied')
    expect(await loadWith(refused).enable(client, U)).equals('denied')
    const blocked = module('denied', 'granted')
    expect(await loadWith(blocked).enable(client, U)).equals('denied')
    expect(blocked.asked).equals(1)
    const allowed2 = module('granted', 'denied')
    expect(await loadWith(allowed2).enable(client, U)).equals('granted')
    expect(allowed2.asked).equals(0)
  })

  it('registers an allowed phone’s token, and nothing without one', async function () {
    const device = loadWith(module('granted', 'granted', 'fcm-token-1'))
    expect(await device.sync(client, U)).equals('granted')
    await keep(ON)
    expect(
      await loadWith(module('prompt', 'granted', 'fcm-token-2')).enable(
        client,
        U
      )
    ).equals('granted')
    expect(registered).deep.equals([
      {
        platform: 'android',
        address: 'fcm-token-1',
        environment: 'production',
        messages: false,
        rsvpEvents: false
      },
      {
        platform: 'android',
        address: 'fcm-token-2',
        environment: 'production',
        messages: true,
        rsvpEvents: false
      }
    ])
    registered = []
    // Refused, or allowed with no Firebase: nothing is registered.
    expect(
      await loadWith(module('prompt', 'denied', 'fcm-token-3')).enable(
        client,
        U
      )
    ).equals('denied')
    expect(await loadWith(module('granted', 'granted')).sync(client, U)).equals(
      'granted'
    )
    expect(registered).deep.equals([])
  })

  it('posts an iPhone’s token with its APNs environment, and survives a failed post', async function () {
    const phone = loadWith(
      module('granted', 'granted', 'apns-1', 'development'),
      'ios'
    )
    expect(await phone.sync(client, U)).equals('granted')
    expect(registered).deep.equals([
      {
        platform: 'ios',
        address: 'apns-1',
        environment: 'development',
        messages: false,
        rsvpEvents: false
      }
    ])
    const offline: PushClient = {
      ...client,
      registerPush: async () => {
        throw new Error('offline')
      }
    }
    expect(
      await loadWith(module('granted', 'granted', 'fcm-1')).sync(offline, U)
    ).equals('granted')
  })

  it('asks a phone not asked yet once either of its own switches is on, and only then', async function () {
    // Asked before, either way: nothing is asked again.
    await keep(BOTH)
    for (const state of ['granted', 'denied'] as const) {
      const push = module(state, 'granted')
      const device = loadWith(push)
      expect(await ask()(device, client, U)).equals(state)
      expect(push.asked).equals(0)
    }
    // Not asked yet, with both switches off: the phone waits.
    await keep(OFF)
    const waiting = module('prompt', 'granted')
    const off = loadWith(waiting)
    expect(await ask()(off, client, U)).equals('prompt')
    expect(waiting.asked).equals(0)
    // Either switch on: asked once, and the allowed phone registers with
    // them.
    for (const switches of [ON, { messages: false, rsvpEvents: true }]) {
      await keep(switches)
      const push = module('prompt', 'granted', 'fcm-on')
      const device = loadWith(push)
      expect(await ask()(device, client, U)).equals('granted')
      expect(push.asked).equals(1)
    }
    expect(
      registered.map(row => [row.address, row.messages, row.rsvpEvents])
    ).deep.equals([
      ['fcm-on', true, false],
      ['fcm-on', false, true]
    ])
  })

  it('asks once while the question is up', async function () {
    let answer!: (value: string) => void
    const push = {
      ...module('prompt', 'denied'),
      requestPermission: async () => {
        push.asked++
        return await new Promise<string>(resolve => {
          answer = resolve
        })
      }
    }
    await keep(ON)
    const device = loadWith(push)
    const first = ask()(device, client, U)
    // The app comes to the foreground again while the system asks.
    const second = ask()(device, client, U)
    while (push.asked === 0) await wait()
    answer('denied')
    expect(await first).equals('prompt')
    expect(await second).equals('prompt')
    expect(push.asked).equals(1)
  })

  it('registers a phone allowed in its settings after it was refused, on the next foreground', async function () {
    const push = module('prompt', 'denied', 'fcm-later')
    await keep(BOTH)
    const device = loadWith(push)
    // Refused when asked; a foreground while refused registers nothing.
    expect(await ask()(device, client, U)).equals('denied')
    expect(await ask()(device, client, U)).equals('denied')
    expect(registered).deep.equals([])
    // Allowed in Settings: the next foreground registers, once, with the
    // phone's switches.
    push.permissionState = async () => 'granted'
    expect(await ask()(device, client, U)).equals('granted')
    expect(await ask()(device, client, U)).equals('granted')
    expect(
      registered.map(row => [row.address, row.messages, row.rsvpEvents])
    ).deep.equals([['fcm-later', true, true]])
    // Registered at start by the app's own sync: a foreground after it
    // posts nothing more.
    const allowed = loadWith(module('granted', 'granted', 'fcm-start'))
    await allowed.sync(client, U)
    expect(await ask()(allowed, client, U)).equals('granted')
    expect(registered.map(row => row.address)).deep.equals([
      'fcm-later',
      'fcm-start'
    ])
  })

  it('patches its own registration when a switch changes, and posts again when it has none or the server lost it', async function () {
    const push = module('granted', 'granted', 'fcm-switch')
    const device = loadWith(push)
    // Allowed but not registered yet: the change registers it.
    expect(await device.setSwitches(client, U, ON)).deep.equals(ON)
    expect(
      registered.map(row => [row.address, row.messages, row.rsvpEvents])
    ).deep.equals([['fcm-switch', true, false]])
    expect(patched).deep.equals([])
    // Registered: the registration takes the switches as stored.
    await device.setSwitches(client, U, { rsvpEvents: true })
    expect(patched).deep.equals([['reg-1', BOTH]])
    expect(registered).lengthOf(1)
    // The server no longer has it: posted again with the switches.
    const lost: PushClient = {
      ...client,
      updatePush: async () => {
        throw new Error('No such registration')
      }
    }
    await device.setSwitches(lost, U, OFF)
    expect(registered).lengthOf(2)
    expect(registered[1]).deep.include(OFF)
    expect(await readSwitches(U, storage)).deep.equals(OFF)
    // A phone refused, or without the module, keeps them and posts nothing.
    registered = []
    await loadWith(module('denied', 'granted', 'fcm-no')).setSwitches(
      client,
      U,
      ON
    )
    await loadWith(undefined).setSwitches(client, U, BOTH)
    expect(registered).deep.equals([])
    expect(await readSwitches(U, storage)).deep.equals(BOTH)
    // Nothing it fails at throws.
    await loadWith(module('granted', 'granted', 'fcm-x')).setSwitches(
      {
        ...client,
        registerPush: async () => {
          throw new Error('offline')
        }
      },
      U,
      ON
    )
  })

  it('posts a new token in its turn, so a switch change made meanwhile reaches the registration it makes', async function () {
    // The PushToken task's post of a new token is held; the person turns
    // Messages off while it is under way.
    await keep(ON)
    const answers: Array<() => void> = []
    const order: string[] = []
    const api: PushClient = {
      ...client,
      registerPush: async registration => {
        order.push(
          `post ${registration.address} ${String(registration.messages)}`
        )
        if (registration.address === 'fcm-new')
          await new Promise<void>(resolve => {
            answers.push(resolve)
          })
        return `reg-${registration.address}`
      },
      updatePush: async (id, change) => {
        order.push(`patch ${id} ${String(change.messages)}`)
        return { ...OFF, leagueManagement: true, ...change }
      }
    }
    const device = loadWith(module('granted', 'granted', 'fcm-old'))
    await device.sync(api, U)
    const task = device.tokenChanged(api, U, 'fcm-new')
    const change = device.setSwitches(api, U, { messages: false })
    while (answers.length === 0) await wait()
    answers[0]()
    await task
    await change
    // The new token's post reads what is stored when it goes, and the
    // change, after it, patches the registration that post made.
    expect(order).deep.equals([
      'post fcm-old true',
      'post fcm-new false',
      'patch reg-fcm-new false'
    ])
    // Somebody it cannot tell is posted with both off.
    await device.tokenChanged(api, undefined, 'fcm-unknown')
    expect(order.at(-1)).equals('post fcm-unknown false')
  })

  it('tries a register that failed again after a while, and at the next foreground', async function () {
    let offline = true
    const api: PushClient = {
      ...client,
      registerPush: async registration => {
        if (offline) throw new Error('offline')
        return await client.registerPush(registration)
      }
    }
    await keep(ON)
    const device = loadWith(
      module('granted', 'granted', 'fcm-retry'),
      'android',
      {
        retryMs: [5]
      }
    )
    await device.sync(api, U)
    expect(registered).deep.equals([])
    offline = false
    await wait(30)
    expect(registered.map(row => row.messages)).deep.equals([true])
    // Failing again, and once more after a while: the next foreground posts.
    offline = true
    await device.setSwitches(
      {
        ...api,
        updatePush: async () => await Promise.reject(new Error('offline'))
      },
      U,
      { rsvpEvents: true }
    )
    await wait(30)
    offline = false
    expect(await ask()(device, api, U)).equals('granted')
    expect(registered.map(row => [row.messages, row.rsvpEvents])).deep.equals([
      [true, false],
      [true, true]
    ])
    // A sign-out stops any retry.
    offline = true
    await device.setSwitches(
      {
        ...api,
        updatePush: async () => await Promise.reject(new Error('offline'))
      },
      U,
      OFF
    )
    await device.release({ unregisterPush: async () => undefined })
    offline = false
    await wait(30)
    expect(registered).lengthOf(2)
  })

  it('tells the module the conversation on screen, and clears a read one by its tag', async function () {
    const push = module('granted', 'granted')
    const device = loadWith(push)
    device.setActiveConversation('cnv_1')
    device.setActiveConversation(null)
    await device.clearConversation('cnv_1')
    expect(push.told).deep.equals(['cnv_1', null])
    expect(push.cleared).deep.equals(['chat:cnv_1'])
  })

  it('tells the module who is signed in, and when nobody is', function () {
    const push = module('granted', 'granted')
    const device = loadWith(push)
    device.signedIn(U)
    device.signedIn(undefined)
    expect(push.users).deep.equals([U, null])
  })

  it('lets go of its token at sign-out at once, though a post ahead of it never answers', async function () {
    const push = module('granted', 'granted', 'fcm-token-1')
    const device = loadWith(push, 'android', { releaseTimeoutMs: 20 })
    const stalled: PushClient & ReleaseClient = {
      ...client,
      registerPush: async () => await new Promise<string>(() => {}),
      unregisterPush: async () => undefined
    }
    device.sync(stalled, U).catch(() => undefined)
    await wait(5)
    await device.release(stalled)
    expect(push.released).equals(1)
  })

  it('deletes its registration at sign-out and lets go of its token, the server answering or not', async function () {
    const deleted: string[] = []
    const api: PushClient & ReleaseClient = {
      ...client,
      unregisterPush: async id => {
        deleted.push(id)
      }
    }
    const push = module('granted', 'granted', 'fcm-token-1')
    const device = loadWith(push)
    await device.sync(api, U)
    await device.release(api)
    expect(deleted).deep.equals(['reg-1'])
    expect(push.released).equals(1)
    // Released already: the token still goes, with nothing to delete.
    await device.release(api)
    expect(deleted).deep.equals(['reg-1'])
    expect(push.released).equals(2)

    // Signed out with the server away, the logout failing as the delete
    // does: the module lets go of the token anyway, and nothing throws.
    const offline: PushClient & ReleaseClient = {
      ...api,
      unregisterPush: async () => {
        throw new Error('offline')
      }
    }
    const phone = module('granted', 'granted', 'apns-1')
    const iphone = loadWith(phone, 'ios')
    await iphone.sync(offline, U)
    await iphone.release(offline)
    expect(phone.released).equals(1)
    // A token the PushToken task registered (a new one, from FCM) is the
    // one sign-out deletes.
    const task = loadWith(module('granted', 'granted'))
    await task.tokenChanged(api, U, 'fcm-new')
    await task.release(api)
    expect(deleted).deep.equals(['reg-1', 'reg-1'])
    // A module that fails to let go is let be.
    const failing = {
      ...module('granted', 'granted', 'fcm-token-2'),
      unregister: async () => {
        throw new Error('No Firebase')
      }
    }
    await loadWith(failing).release(offline)
  })

  /** A phone whose `unregister` waits for `letGo`, with its own bound. */
  function slowPhone(
    trace: string[],
    token: string
  ): {
    device: PushDevice
    push: ReturnType<typeof module>
    letGo: () => void
  } {
    const push = module('granted', 'granted', token)
    const waiting: Array<() => void> = []
    push.unregister = async () => {
      await new Promise<void>(resolve => {
        waiting.push(resolve)
      })
      trace.push('unregister')
    }
    return {
      device: load(push).phonePushDevice(() => push, {
        storage,
        retryMs: [],
        releaseTimeoutMs: 20
      }),
      push,
      letGo: () => {
        for (const resolve of waiting.splice(0)) resolve()
      }
    }
  }

  /** The API, posting into `trace`, whose delete never answers. */
  function hangingApi(trace: string[]): PushClient & ReleaseClient {
    return {
      webPushKey: client.webPushKey,
      registerPush: async registration => {
        trace.push(`register ${registration.address}`)
        return 'reg-3'
      },
      updatePush: client.updatePush,
      unregisterPush: async () => {
        await new Promise<void>(() => {})
      }
    }
  }

  it('waits for a hanging delete and a hanging unregister only so long, and a sign-in registers then and again once it is let go', async function () {
    const trace: string[] = []
    const { device, letGo } = slowPhone(trace, 'fcm-token-3')
    const api = hangingApi(trace)
    await device.sync(api, U)
    const started = Date.now()
    let released = false
    const releasing = device.release(api).then(() => {
      released = true
    })
    // Signed in again at once: nothing registers within the bound.
    const syncing = device.sync(api, U)
    await wait(5)
    expect(trace).deep.equals(['register fcm-token-3'])
    // Past it, sign-out is over (its logout goes) and the sign-in has
    // registered, though the module has not let go yet.
    await wait(40)
    expect(released).equals(true)
    await releasing
    await syncing
    expect(Date.now() - started).lessThan(1000)
    expect(trace).deep.equals(['register fcm-token-3', 'register fcm-token-3'])
    // The late letting go took the token that sign-in posted: it registers
    // again.
    letGo()
    await wait(5)
    expect(trace).deep.equals([
      'register fcm-token-3',
      'register fcm-token-3',
      'unregister',
      'register fcm-token-3'
    ])
  })

  it('registers a sign-in after an unregister that never settles, and not again after a later sign-out', async function () {
    const trace: string[] = []
    const { device, letGo } = slowPhone(trace, 'fcm-token-4')
    const api = hangingApi(trace)
    await device.sync(api, U)
    const started = Date.now()
    await device.release(api)
    expect(Date.now() - started).lessThan(1000)
    await device.sync(api, U)
    expect(trace).deep.equals(['register fcm-token-4', 'register fcm-token-4'])
    // Signed out again before the first letting go settles: neither one
    // registers anything after.
    await device.release(api)
    letGo()
    await wait(5)
    expect(trace).deep.equals([
      'register fcm-token-4',
      'register fcm-token-4',
      'unregister',
      'unregister'
    ])
  })

  it('registers once only after an unregister that settles within the bound', async function () {
    const trace: string[] = []
    const { device, letGo } = slowPhone(trace, 'fcm-token-5')
    const api = hangingApi(trace)
    await device.sync(api, U)
    const releasing = device.release(api)
    const syncing = device.sync(api, U)
    await wait(5)
    letGo()
    await releasing
    await syncing
    await wait(5)
    expect(trace).deep.equals([
      'register fcm-token-5',
      'unregister',
      'register fcm-token-5'
    ])
  })

  it('cannot notify in a build without the module', async function () {
    const device = loadWith(undefined)
    expect(await device.state()).equals('unsupported')
    expect(await device.enable(client, U)).equals('unsupported')
    // Nothing to tell, nothing to clear, and nothing to let go of.
    device.setActiveConversation('cnv_1')
    await device.clearConversation('cnv_1')
    await device.release({
      unregisterPush: async () => {
        throw new Error('nothing was registered')
      }
    })
  })
})
