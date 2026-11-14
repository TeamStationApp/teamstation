import { expect } from 'chai'
import { afterEach, describe, it } from 'mocha'

import type { AccountNotifications } from '../../common/accountSettings'
import type { PushRegistration } from '../../common/api'
import type {
  AskClient,
  PushClient,
  PushDevice,
  ReleaseClient
} from './pushState'

/** What the phone registered, through the API. */
let registered: PushRegistration[] = []
const client: PushClient = {
  webPushKey: async () => {
    throw new Error('A phone has no Web Push key')
  },
  registerPush: async registration => {
    registered.push(registration)
    return 'reg-1'
  }
}

/**
 * A phone's notifications through `TSPush`, the app's own module. React
 * Native is replaced in the module cache by a registry of this test's, as
 * `NativeChatCrypto.test.ts` does.
 */
const reactNative = require.resolve('react-native')
const file = require.resolve('./pushDevice.native')

/** The module's `askWhenWanted`, loaded as `loadWith` loads it. */
type Ask = (device: PushDevice, client: AskClient) => Promise<string>

function loadWith(push: object | undefined, os = 'android'): PushDevice {
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
  return (require('./pushDevice.native') as { pushDevice: PushDevice })
    .pushDevice
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
    Reflect.deleteProperty(require.cache, file)
    Reflect.deleteProperty(require.cache, reactNative)
  })

  it('reads the phone’s permission without asking', async function () {
    for (const state of ['granted', 'denied', 'prompt'] as const) {
      const push = module(state, 'granted')
      const device = loadWith(push)
      expect(await device.state()).equals(state)
      expect(await device.sync(client)).equals(state)
      expect(push.asked).equals(0)
    }
    expect(await loadWith(module('restricted', 'granted')).state()).equals(
      'unsupported'
    )
  })

  it('leaves asking to the module, which asks only once, and answers what the person chose', async function () {
    const allowed = module('prompt', 'granted')
    expect(await loadWith(allowed).enable(client)).equals('granted')
    const refused = module('prompt', 'denied')
    expect(await loadWith(refused).enable(client)).equals('denied')
    const blocked = module('denied', 'granted')
    expect(await loadWith(blocked).enable(client)).equals('denied')
    expect(blocked.asked).equals(1)
    const allowed2 = module('granted', 'denied')
    expect(await loadWith(allowed2).enable(client)).equals('granted')
    expect(allowed2.asked).equals(0)
  })

  it('registers an allowed phone’s token, and nothing without one', async function () {
    const device = loadWith(module('granted', 'granted', 'fcm-token-1'))
    expect(await device.sync(client)).equals('granted')
    expect(
      await loadWith(module('prompt', 'granted', 'fcm-token-2')).enable(client)
    ).equals('granted')
    expect(registered).deep.equals([
      {
        platform: 'android',
        address: 'fcm-token-1',
        environment: 'production'
      },
      { platform: 'android', address: 'fcm-token-2', environment: 'production' }
    ])
    registered = []
    // Refused, or allowed with no Firebase: nothing is registered.
    expect(
      await loadWith(module('prompt', 'denied', 'fcm-token-3')).enable(client)
    ).equals('denied')
    expect(await loadWith(module('granted', 'granted')).sync(client)).equals(
      'granted'
    )
    expect(registered).deep.equals([])
  })

  it('posts an iPhone’s token with its APNs environment, and survives a failed post', async function () {
    const phone = loadWith(
      module('granted', 'granted', 'apns-1', 'development'),
      'ios'
    )
    expect(await phone.sync(client)).equals('granted')
    expect(registered).deep.equals([
      { platform: 'ios', address: 'apns-1', environment: 'development' }
    ])
    const offline: PushClient = {
      ...client,
      registerPush: async () => {
        throw new Error('offline')
      }
    }
    expect(
      await loadWith(module('granted', 'granted', 'fcm-1')).sync(offline)
    ).equals('granted')
  })

  it('asks a phone not asked yet once either switch is on, and only then', async function () {
    let reads = 0
    const switches = (
      notifications: AccountNotifications
    ): AskClient & { reads: () => number } => ({
      ...client,
      accountNotifications: async () => {
        reads++
        return notifications
      },
      reads: () => reads
    })
    const ask = (): Ask =>
      (require('./pushDevice.native') as { askWhenWanted: Ask }).askWhenWanted
    // Asked before, either way: nothing is read, nothing asked again.
    for (const state of ['granted', 'denied'] as const) {
      const push = module(state, 'granted')
      const device = loadWith(push)
      const on = switches({ messages: true, rsvpEvents: true })
      expect(await ask()(device, on)).equals(state)
      expect(push.asked).equals(0)
    }
    expect(reads).equals(0)
    // Not asked yet, with both switches off: the phone waits.
    const waiting = module('prompt', 'granted')
    const off = loadWith(waiting)
    expect(
      await ask()(off, switches({ messages: false, rsvpEvents: false }))
    ).equals('prompt')
    expect(waiting.asked).equals(0)
    expect(reads).equals(1)
    // Either switch on: asked once, and the allowed phone registers.
    for (const notifications of [
      { messages: true, rsvpEvents: false },
      { messages: false, rsvpEvents: true }
    ]) {
      const push = module('prompt', 'granted', 'fcm-on')
      const device = loadWith(push)
      expect(await ask()(device, switches(notifications))).equals('granted')
      expect(push.asked).equals(1)
    }
    expect(registered.map(row => row.address)).deep.equals(['fcm-on', 'fcm-on'])
  })

  it('asks once while the question is up, and again after a failed read', async function () {
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
    const device = loadWith(push)
    const { askWhenWanted } = require('./pushDevice.native') as {
      askWhenWanted: Ask
    }
    const on: AskClient = {
      ...client,
      accountNotifications: async () => ({ messages: true, rsvpEvents: false })
    }
    const first = askWhenWanted(device, on)
    // The app comes to the foreground again while the system asks.
    const second = askWhenWanted(device, on)
    while (push.asked === 0) await new Promise(resolve => setTimeout(resolve))
    answer('denied')
    expect(await first).equals('prompt')
    expect(await second).equals('prompt')
    expect(push.asked).equals(1)
    // A read that fails asks nothing, and the next foreground tries again.
    const failing: AskClient = {
      ...client,
      accountNotifications: async () => {
        throw new Error('offline')
      }
    }
    const later = loadWith(module('prompt', 'granted'))
    const ask = (require('./pushDevice.native') as { askWhenWanted: Ask })
      .askWhenWanted
    let failed = false
    await ask(later, failing).catch(() => {
      failed = true
    })
    expect(failed).equals(true)
    expect(await ask(later, on)).equals('granted')
  })

  it('registers a phone allowed in its settings after it was refused, on the next foreground', async function () {
    const push = module('prompt', 'denied', 'fcm-later')
    const device = loadWith(push)
    const { askWhenWanted } = require('./pushDevice.native') as {
      askWhenWanted: Ask
    }
    const on: AskClient = {
      ...client,
      accountNotifications: async () => ({ messages: true, rsvpEvents: true })
    }
    // Refused when asked; a foreground while refused registers nothing.
    expect(await askWhenWanted(device, on)).equals('denied')
    expect(await askWhenWanted(device, on)).equals('denied')
    expect(registered).deep.equals([])
    // Allowed in Settings: the next foreground registers, once.
    push.permissionState = async () => 'granted'
    expect(await askWhenWanted(device, on)).equals('granted')
    expect(await askWhenWanted(device, on)).equals('granted')
    expect(registered.map(row => row.address)).deep.equals(['fcm-later'])
    // Already allowed at the first look: the app's own sync registers it.
    const allowed = loadWith(module('granted', 'granted', 'fcm-start'))
    const ask = (require('./pushDevice.native') as { askWhenWanted: Ask })
      .askWhenWanted
    expect(await ask(allowed, on)).equals('granted')
    expect(registered.map(row => row.address)).deep.equals(['fcm-later'])
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
    await device.sync(api)
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
    await iphone.sync(offline)
    await iphone.release(offline)
    expect(phone.released).equals(1)
    // A token the PushToken task registered (a new one, from FCM) is the
    // one sign-out deletes.
    const task = loadWith(module('granted', 'granted'))
    const { registerAddress } = require('./pushDevice.native') as {
      registerAddress: (
        client: PushClient,
        address: string,
        environment: string
      ) => Promise<void>
    }
    await registerAddress(api, 'fcm-new', 'production')
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
    loadWith(push)
    const { phonePushDevice } = require('./pushDevice.native') as {
      phonePushDevice: (
        module: () => object | null,
        releaseTimeoutMs?: number
      ) => PushDevice
    }
    return {
      device: phonePushDevice(() => push, 20),
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
      unregisterPush: async () => {
        await new Promise<void>(() => {})
      }
    }
  }

  const wait = async (ms: number): Promise<void> => {
    await new Promise(resolve => setTimeout(resolve, ms))
  }

  it('waits for a hanging delete and a hanging unregister only so long, and a sign-in registers then and again once it is let go', async function () {
    const trace: string[] = []
    const { device, letGo } = slowPhone(trace, 'fcm-token-3')
    const api = hangingApi(trace)
    await device.sync(api)
    const started = Date.now()
    let released = false
    const releasing = device.release(api).then(() => {
      released = true
    })
    // Signed in again at once: nothing registers within the bound.
    const syncing = device.sync(api)
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
    await device.sync(api)
    const started = Date.now()
    await device.release(api)
    expect(Date.now() - started).lessThan(1000)
    await device.sync(api)
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
    await device.sync(api)
    const releasing = device.release(api)
    const syncing = device.sync(api)
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
    expect(await device.enable(client)).equals('unsupported')
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
