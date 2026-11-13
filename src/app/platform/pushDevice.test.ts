import { expect } from 'chai'
import { afterEach, describe, it } from 'mocha'

import type { PushRegistration, PushSwitches } from '../../common/api'
import {
  type NotificationSwitches,
  readSwitches,
  writeSwitches
} from './notificationSwitches'
import {
  askWhenWanted,
  type BrowserPush,
  browserPushDevice,
  keyBytes,
  type PushClient,
  pushDevice,
  type ReleaseClient,
  type WorkerContainer
} from './pushDevice'
import type { PushDeviceOptions } from './pushState'
import type { UserSettingStorage } from './userSetting'

type Permission = 'granted' | 'denied' | 'default'

const OFF: NotificationSwitches = { messages: false, rsvpEvents: false }
const ON: NotificationSwitches = { messages: true, rsvpEvents: false }
/** The signed-in person. */
const U = 'usr_1'

/** A browser's `localStorage`, as one or more tabs share it. */
function memory(): UserSettingStorage & { kept: Map<string, string> } {
  const kept = new Map<string, string>()
  return {
    kept,
    getItem: async key => kept.get(key) ?? null,
    setItem: async (key, value) => {
      kept.set(key, value)
    }
  }
}

/**
 * A browser's device, keeping its switches in `storage` (with `switches`
 * stored there first, when given) and trying nothing again on a timer
 * unless `options` says so.
 */
async function browserDevice(
  browser: BrowserPush,
  switches?: NotificationSwitches,
  storage: UserSettingStorage = memory(),
  options: PushDeviceOptions = {}
): Promise<ReturnType<typeof browserPushDevice>> {
  if (switches != null) await writeSwitches(U, switches, storage)
  return browserPushDevice(browser, { storage, retryMs: [], ...options })
}

/** Lets every timer and answer due within `ms` run. */
const wait = async (ms = 1): Promise<void> => {
  await new Promise(resolve => setTimeout(resolve, ms))
}

/** A browser's `Notification`, answering a request with `answer`. */
function notification(
  permission: Permission,
  answer: Permission | Error
): {
  permission: Permission
  asked: number
  requestPermission: () => Promise<Permission>
} {
  const api = {
    permission,
    asked: 0,
    requestPermission: async (): Promise<Permission> => {
      api.asked++
      if (answer instanceof Error) throw answer
      api.permission = answer
      return answer
    }
  }
  return api
}

/** A VAPID public key's shape: 65 bytes, uncompressed. */
const KEY = Buffer.alloc(65, 4).toString('base64url')
const OTHER_KEY = Buffer.alloc(65, 7).toString('base64url')

/** A subscription made for `key`, as the browser hands it back. */
function subscription(
  endpoint: string,
  key = KEY
): {
  options: { applicationServerKey: ArrayBuffer }
  toJSON: () => unknown
  unsubscribe: () => Promise<boolean>
  dropped: boolean
} {
  const made = {
    options: {
      applicationServerKey: Uint8Array.from(Buffer.from(key, 'base64url'))
        .buffer
    },
    toJSON: () => ({ endpoint, keys: { p256dh: 'p', auth: 'a' } }),
    unsubscribe: async () => {
      made.dropped = true
      return true
    },
    dropped: false
  }
  return made
}

/** `navigator.serviceWorker`, holding `held` until asked for a new one. */
function workers(
  held?: ReturnType<typeof subscription>,
  shown: string[] = []
): WorkerContainer & {
  registered: Array<{ url: string; scope: string }>
  subscribed: Array<{ userVisibleOnly: boolean; key: string }>
  /** The tags of the notifications the worker shows. */
  shown: string[]
} {
  // A subscription let go of is gone, as the browser's is.
  const current = (): ReturnType<typeof subscription> | null =>
    held == null || held.dropped ? null : held
  const container = {
    registered: [] as Array<{ url: string; scope: string }>,
    subscribed: [] as Array<{ userVisibleOnly: boolean; key: string }>,
    shown,
    getRegistration: async () => ({
      getNotifications: async (filter: { tag: string }) =>
        container.shown
          .filter(tag => tag === filter.tag)
          .map(tag => ({
            close: () => {
              container.shown.splice(container.shown.indexOf(tag), 1)
            }
          })),
      pushManager: { getSubscription: async () => current() }
    }),
    register: async (url: string, options: { scope: string }) => {
      container.registered.push({ url, scope: options.scope })
      return {}
    },
    ready: Promise.resolve({
      pushManager: {
        getSubscription: async () => current(),
        subscribe: async (options: {
          userVisibleOnly: true
          applicationServerKey: Uint8Array
        }) => {
          container.subscribed.push({
            userVisibleOnly: options.userVisibleOnly,
            key: Buffer.from(options.applicationServerKey).toString('base64url')
          })
          held = subscription('https://fcm.googleapis.com/fcm/send/new')
          return held
        }
      }
    })
  }
  return container
}

/**
 * The API: the server's key (null for none), and what was posted, patched
 * and deleted.
 */
function client(key: string | null = KEY): PushClient &
  ReleaseClient & {
    posted: PushRegistration[]
    patched: Array<[string, Partial<PushSwitches>]>
    deleted: string[]
  } {
  const api = {
    posted: [] as PushRegistration[],
    patched: [] as Array<[string, Partial<PushSwitches>]>,
    deleted: [] as string[],
    webPushKey: async () => key,
    registerPush: async (registration: PushRegistration) => {
      api.posted.push(registration)
      return 'psh_1'
    },
    updatePush: async (id: string, change: Partial<PushSwitches>) => {
      api.patched.push([id, change])
      return { ...OFF, ...change }
    },
    unregisterPush: async (id: string) => {
      api.deleted.push(id)
    }
  }
  return api
}

describe('notifications in a browser', function () {
  afterEach(function () {
    Reflect.deleteProperty(globalThis, 'Notification')
  })

  it('reads the browser’s permission without asking', async function () {
    for (const [permission, state] of [
      ['granted', 'granted'],
      ['denied', 'denied'],
      ['default', 'prompt']
    ] as const) {
      const api = notification(permission, 'granted')
      const device = await browserDevice({
        notification: () => api,
        workers: () => undefined
      })
      expect(await device.state()).equals(state)
      expect(await device.sync(client(), U)).equals(state)
      expect(api.asked).equals(0)
    }
  })

  it('asks only when not asked yet, and answers what the person chose', async function () {
    const ask = async (api: ReturnType<typeof notification>): Promise<string> =>
      await (
        await browserDevice({
          notification: () => api,
          workers: () => undefined
        })
      ).enable(client(), U)
    expect(await ask(notification('default', 'granted'))).equals('granted')
    expect(await ask(notification('default', 'denied'))).equals('denied')
    // A dismissed prompt is still unanswered.
    expect(await ask(notification('default', 'default'))).equals('prompt')
    const blocked = notification('denied', 'granted')
    expect(await ask(blocked)).equals('denied')
    expect(blocked.asked).equals(0)
    // Allowed already: nothing to ask.
    const allowed = notification('granted', 'denied')
    expect(await ask(allowed)).equals('granted')
    expect(allowed.asked).equals(0)
    // A browser that throws instead of asking is left unanswered.
    const broken = notification('default', new Error('No prompt'))
    expect(await ask(broken)).equals('prompt')
    expect(broken.asked).equals(1)
  })

  it('registers a browser allowed elsewhere once Allow is tapped, and only once', async function () {
    // Allowed in the site's settings, or another tab, before the tap.
    const api = client()
    const device = await browserDevice(
      {
        notification: () => notification('granted', 'denied'),
        workers: () => workers()
      },
      ON
    )
    expect(await device.enable(api, U)).equals('granted')
    expect(api.posted.map(row => row.messages)).deep.equals([true])
    // Registered already, as after a switch change: nothing more is posted.
    expect(await device.enable(api, U)).equals('granted')
    expect(api.posted).lengthOf(1)
  })

  it('registers its worker at the root, subscribes for the server’s key and posts the subscription', async function () {
    const container = workers()
    const api = client()
    const asking = notification('default', 'granted')
    const storage = memory()
    const device = await browserDevice(
      { notification: () => asking, workers: () => container },
      ON,
      storage
    )
    expect(await device.enable(api, U)).equals('granted')
    expect(container.registered).deep.equals([{ url: '/sw.js', scope: '/' }])
    expect(container.subscribed).deep.equals([
      { userVisibleOnly: true, key: KEY }
    ])
    expect(api.posted).deep.equals([
      {
        platform: 'web',
        address: JSON.stringify({
          endpoint: 'https://fcm.googleapis.com/fcm/send/new',
          keys: { p256dh: 'p', auth: 'a' }
        }),
        environment: 'production',
        messages: true,
        rsvpEvents: false
      }
    ])
    // Signed in again, the same subscription is posted again, with the
    // switches as they are stored now.
    await writeSwitches(U, OFF, storage)
    expect(await device.sync(api, U)).equals('granted')
    expect(container.subscribed).lengthOf(1)
    expect(api.posted).lengthOf(2)
    expect(api.posted[1]).deep.equals({
      ...api.posted[0],
      messages: false,
      rsvpEvents: false
    })
  })

  it('keeps a subscription for this key, and replaces one made for another', async function () {
    const kept = subscription('https://fcm.googleapis.com/fcm/send/kept')
    const keeping = workers(kept)
    const api = client()
    await (
      await browserDevice({
        notification: () => notification('granted', 'granted'),
        workers: () => keeping
      })
    ).sync(api, U)
    expect(keeping.subscribed).deep.equals([])
    expect(kept.dropped).equals(false)
    expect(JSON.parse(api.posted[0].address).endpoint).equals(
      'https://fcm.googleapis.com/fcm/send/kept'
    )

    const stale = subscription(
      'https://fcm.googleapis.com/fcm/send/stale',
      OTHER_KEY
    )
    const replacing = workers(stale)
    const again = client()
    await (
      await browserDevice({
        notification: () => notification('granted', 'granted'),
        workers: () => replacing
      })
    ).sync(again, U)
    expect(stale.dropped).equals(true)
    expect(replacing.subscribed).deep.equals([
      { userVisibleOnly: true, key: KEY }
    ])
    expect(JSON.parse(again.posted[0].address).endpoint).equals(
      'https://fcm.googleapis.com/fcm/send/new'
    )
  })

  it('registers nothing refused, without workers, or for a server without Web Push', async function () {
    const container = workers()
    const refused = client()
    await (
      await browserDevice({
        notification: () => notification('denied', 'granted'),
        workers: () => container
      })
    ).sync(refused, U)
    expect(refused.posted).deep.equals([])
    expect(container.registered).deep.equals([])

    const without = client()
    expect(
      await (
        await browserDevice({
          notification: () => notification('granted', 'granted'),
          workers: () => undefined
        })
      ).sync(without, U)
    ).equals('granted')
    expect(without.posted).deep.equals([])

    const off = client(null)
    await (
      await browserDevice({
        notification: () => notification('granted', 'granted'),
        workers: () => container
      })
    ).sync(off, U)
    expect(off.posted).deep.equals([])
    expect(container.registered).deep.equals([])
  })

  it('asks a server without Web Push again only at the next start or sign-in, or with other switches', async function () {
    const api = client(null)
    let asked = 0
    api.webPushKey = async () => {
      asked++
      return null
    }
    const storage = memory()
    const device = await browserDevice(
      {
        notification: () => notification('granted', 'granted'),
        workers: () => workers()
      },
      ON,
      storage
    )
    await device.sync(api, U)
    expect(asked).equals(1)
    // Each foreground finds the same switches: nothing to ask again.
    await askWhenWanted(device, api, U)
    await askWhenWanted(device, api, U)
    expect(asked).equals(1)
    // Another tab changed them: worth one more look.
    await writeSwitches(U, OFF, storage)
    await askWhenWanted(device, api, U)
    await askWhenWanted(device, api, U)
    expect(asked).equals(2)
    // The next start or sign-in asks again.
    await device.sync(api, U)
    expect(asked).equals(3)
    expect(api.posted).deep.equals([])
  })

  it('answers the permission when registering fails', async function () {
    const failing = client()
    failing.registerPush = async () => {
      throw new Error('offline')
    }
    expect(
      await (
        await browserDevice({
          notification: () => notification('granted', 'granted'),
          workers: () => workers()
        })
      ).sync(failing, U)
    ).equals('granted')
  })

  it('never asks on its own: a browser asks only from a tap', async function () {
    const api = notification('default', 'granted')
    const device = await browserDevice(
      { notification: () => api, workers: () => workers() },
      { messages: true, rsvpEvents: true }
    )
    const on = client()
    expect(await askWhenWanted(device, on, U)).equals('prompt')
    expect(api.asked).equals(0)
    expect(on.posted).deep.equals([])
  })

  it('keeps the switches it is given, a change at a time, for each person on their own', async function () {
    const storage = memory()
    const device = await browserDevice(
      {
        notification: () => notification('denied', 'granted'),
        workers: () => undefined
      },
      undefined,
      storage
    )
    expect(await device.switches(U)).deep.equals(OFF)
    expect(
      await device.setSwitches(client(), U, { rsvpEvents: true })
    ).deep.equals({ messages: false, rsvpEvents: true })
    expect(
      await device.setSwitches(client(), U, { messages: true })
    ).deep.equals({ messages: true, rsvpEvents: true })
    expect(await readSwitches(U, storage)).deep.equals({
      messages: true,
      rsvpEvents: true
    })
    expect(await device.switches('usr_2')).deep.equals(OFF)
  })

  it('patches its own registration when a switch changes, and posts again when it has none or the server lost it', async function () {
    const container = workers()
    const api = client()
    const device = await browserDevice({
      notification: () => notification('granted', 'granted'),
      workers: () => container
    })
    // Allowed but not registered yet: the change registers it.
    await device.setSwitches(api, U, ON)
    expect(api.posted.map(row => [row.messages, row.rsvpEvents])).deep.equals([
      [true, false]
    ])
    expect(api.patched).deep.equals([])
    // Registered: the registration takes the switches as stored.
    const both = { messages: true, rsvpEvents: true }
    await device.setSwitches(api, U, { rsvpEvents: true })
    expect(api.patched).deep.equals([['psh_1', both]])
    expect(api.posted).lengthOf(1)
    // The server no longer has it: posted again with the switches.
    api.updatePush = async () => {
      throw new Error('No such registration')
    }
    await device.setSwitches(api, U, OFF)
    expect(api.posted).lengthOf(2)
    expect(api.posted[1]).deep.include(OFF)
    // A later sign-in's sync posts what was last set.
    await device.sync(api, U)
    expect(api.posted[2]).deep.include(OFF)

    // A refused browser keeps the switches and registers nothing.
    const refused = client()
    await (
      await browserDevice({
        notification: () => notification('denied', 'granted'),
        workers: () => container
      })
    ).setSwitches(refused, U, ON)
    expect(refused.posted).deep.equals([])
    expect(refused.patched).deep.equals([])
    // Nothing it fails at throws.
    const failing = client()
    failing.registerPush = async () => {
      throw new Error('offline')
    }
    await (
      await browserDevice({
        notification: () => notification('granted', 'granted'),
        workers: () => container
      })
    ).setSwitches(failing, U, ON)
  })

  /**
   * An API whose posts and patches each wait to be answered, in `order`,
   * holding the switches the server has for the one registration.
   */
  function heldClient(): ReturnType<typeof client> & {
    order: string[]
    server: NotificationSwitches | undefined
    answerNext: () => Promise<void>
  } {
    const api = client()
    const waiting: Array<() => void> = []
    const held = Object.assign(api, {
      order: [] as string[],
      server: undefined as NotificationSwitches | undefined,
      answerNext: async () => {
        while (waiting.length === 0) await wait()
        waiting.shift()!()
        await wait()
      }
    })
    const answer = async (): Promise<void> => {
      await new Promise<void>(resolve => {
        waiting.push(resolve)
      })
    }
    api.registerPush = async registration => {
      const { messages, rsvpEvents } = registration
      held.order.push(`post ${String(messages)} ${String(rsvpEvents)}`)
      await answer()
      held.server = { messages, rsvpEvents }
      return 'psh_1'
    }
    api.updatePush = async (id, change) => {
      held.order.push(
        `patch ${String(change.messages)} ${String(change.rsvpEvents)}`
      )
      await answer()
      held.server = { ...held.server!, ...change }
      return held.server
    }
    return held
  }

  it('posts the switches stored when its turn comes, so turning one back off while asked is what the server gets', async function () {
    // The browser's prompt does not stop the page: the person turns the
    // switch on (asked), and off again before answering.
    const answers: Array<() => void> = []
    const asking = {
      permission: 'default' as Permission,
      requestPermission: async (): Promise<Permission> => {
        await new Promise<void>(resolve => {
          answers.push(resolve)
        })
        asking.permission = 'granted'
        return 'granted'
      }
    }
    const api = client()
    const device = await browserDevice({
      notification: () => asking,
      workers: () => workers()
    })
    const on = device.setSwitches(api, U, { messages: true })
    const enabling = device.enable(api, U)
    await on
    const off = device.setSwitches(api, U, { messages: false })
    await off
    // The question is still up while both changes are kept.
    expect(answers).lengthOf(1)
    answers[0]()
    expect(await enabling).equals('granted')
    expect(api.posted.map(row => [row.messages, row.rsvpEvents])).deep.equals([
      [false, false]
    ])
    expect(api.patched).deep.equals([])
  })

  it('lands the last change last, an on after offs as much as an off after an on', async function () {
    const api = heldClient()
    const storage = memory()
    const device = await browserDevice(
      {
        notification: () => notification('granted', 'granted'),
        workers: () => workers()
      },
      { messages: true, rsvpEvents: true },
      storage
    )
    const syncing = device.sync(api, U)
    await api.answerNext()
    await syncing
    // Messages off (its patch held), RSVPed events off behind it, then
    // Messages on before either has gone.
    const changes = [
      device.setSwitches(api, U, { messages: false }),
      device.setSwitches(api, U, { rsvpEvents: false }),
      device.setSwitches(api, U, { messages: true })
    ]
    for (let i = 0; i < 3; i++) await api.answerNext()
    await Promise.all(changes)
    // Each patch carries what was stored when it went: the last is what is
    // stored, and what the server has.
    expect(api.order).deep.equals([
      'post true true',
      'patch true false',
      'patch true false',
      'patch true false'
    ])
    expect(api.server).deep.equals({ messages: true, rsvpEvents: false })
    expect(await readSwitches(U, storage)).deep.equals(api.server)
  })

  it('sends a switch change only after the registration before it', async function () {
    const api = heldClient()
    const device = await browserDevice(
      {
        notification: () => notification('granted', 'granted'),
        workers: () => workers()
      },
      ON
    )
    const syncing = device.sync(api, U)
    const changing = device.setSwitches(api, U, OFF)
    while (api.order.length === 0) await wait()
    // The post carries the switches stored when it goes, and the change
    // waits for it.
    expect(api.order).deep.equals(['post false false'])
    await api.answerNext()
    await api.answerNext()
    await syncing
    await changing
    expect(api.order).deep.equals(['post false false', 'patch false false'])
  })

  it('tries a register that failed again, after a while and at the next foreground, until the server has the switches', async function () {
    const container = workers()
    const api = client()
    let offline = true
    const posting = api.registerPush
    api.registerPush = async registration => {
      if (offline) throw new Error('offline')
      return await posting(registration)
    }
    const device = await browserDevice(
      {
        notification: () => notification('granted', 'granted'),
        workers: () => container
      },
      undefined,
      memory(),
      { retryMs: [5] }
    )
    await device.setSwitches(api, U, ON)
    expect(api.posted).deep.equals([])
    // Back online: the retry posts what is stored.
    offline = false
    await wait(30)
    expect(api.posted.map(row => row.messages)).deep.equals([true])
    // A patch and its post both failing: tried once more after a while,
    // still offline, and then left to the next foreground.
    offline = true
    api.updatePush = async () => {
      throw new Error('offline')
    }
    await device.setSwitches(api, U, { rsvpEvents: true })
    await wait(30)
    expect(api.posted).lengthOf(1)
    offline = false
    expect(await askWhenWanted(device, api, U)).equals('granted')
    expect(api.posted[1]).deep.include({ messages: true, rsvpEvents: true })
    // Caught up, a foreground posts nothing more.
    await askWhenWanted(device, api, U)
    expect(api.posted).lengthOf(2)
  })

  it('registers a browser allowed in its settings after it was refused, at the next foreground', async function () {
    const browser = notification('denied', 'granted')
    const api = client()
    const device = await browserDevice(
      { notification: () => browser, workers: () => workers() },
      { messages: true, rsvpEvents: true }
    )
    await device.sync(api, U)
    expect(await askWhenWanted(device, api, U)).equals('denied')
    expect(api.posted).deep.equals([])
    // Allowed in the site's settings: the next foreground registers it,
    // once, with the switches.
    browser.permission = 'granted'
    expect(await askWhenWanted(device, api, U)).equals('granted')
    await askWhenWanted(device, api, U)
    expect(api.posted.map(row => [row.messages, row.rsvpEvents])).deep.equals([
      [true, true]
    ])
  })

  it('builds on what another tab stored, and posts it at a foreground when the server has older switches', async function () {
    // Two tabs share one storage, one subscription and so one registration.
    const storage = memory()
    const server = {
      switches: OFF,
      posted: [] as NotificationSwitches[]
    }
    const tabClient = (): ReturnType<typeof client> => {
      const api = client()
      api.registerPush = async ({ messages, rsvpEvents }) => {
        server.switches = { messages, rsvpEvents }
        server.posted.push(server.switches)
        return 'psh_1'
      }
      api.updatePush = async (id, change) => {
        server.switches = { ...server.switches, ...change }
        return server.switches
      }
      return api
    }
    const browser = (): BrowserPush => ({
      notification: () => notification('granted', 'granted'),
      workers: () => workers()
    })
    await writeSwitches(U, { messages: true, rsvpEvents: true }, storage)
    const a = await browserDevice(browser(), undefined, storage)
    const b = await browserDevice(browser(), undefined, storage)
    const inA = tabClient()
    const inB = tabClient()
    await a.sync(inA, U)
    await b.sync(inB, U)
    // A turns Messages off; B, which still shows it on, turns RSVPed
    // events off: B keeps A's change and sends both.
    await a.setSwitches(inA, U, { messages: false })
    expect(await b.setSwitches(inB, U, { rsvpEvents: false })).deep.equals(OFF)
    expect(server.switches).deep.equals(OFF)
    expect(await readSwitches(U, storage)).deep.equals(OFF)
    // A turns one on again. B last gave the server older switches than are
    // stored, so at its next foreground it posts what is stored; A, in step,
    // posts nothing.
    await a.setSwitches(inA, U, { rsvpEvents: true })
    const posts = server.posted.length
    await askWhenWanted(a, inA, U)
    expect(server.posted.length).equals(posts)
    await askWhenWanted(b, inB, U)
    expect(server.posted.slice(posts)).deep.equals([
      { messages: false, rsvpEvents: true }
    ])
  })

  it('closes a read conversation’s notifications, and leaves the rest to the worker', async function () {
    const container = workers(undefined, [
      'chat:cnv_1',
      'chat:cnv_2',
      'event:gam_1'
    ])
    const device = await browserDevice({
      notification: () => notification('granted', 'granted'),
      workers: () => container
    })
    // The worker looks at its windows itself.
    device.setActiveConversation('cnv_1')
    await device.clearConversation('cnv_1')
    expect(container.shown).deep.equals(['chat:cnv_2', 'event:gam_1'])
    // No worker, or one that fails, clears nothing and says nothing.
    await (
      await browserDevice({
        notification: () => undefined,
        workers: () => undefined
      })
    ).clearConversation('cnv_2')
    container.getRegistration = async () => {
      throw new Error('No worker yet')
    }
    await device.clearConversation('cnv_2')
    expect(container.shown).deep.equals(['chat:cnv_2', 'event:gam_1'])
  })

  it('deletes its registration at sign-out and unsubscribes, the server answering or not', async function () {
    const held = subscription('https://fcm.googleapis.com/fcm/send/held')
    const container = workers(held)
    const api = client()
    const device = await browserDevice({
      notification: () => notification('granted', 'granted'),
      workers: () => container
    })
    await device.sync(api, U)
    await device.release(api)
    expect(api.deleted).deep.equals(['psh_1'])
    expect(held.dropped).equals(true)
    // Released already: nothing more to delete.
    await device.release(api)
    expect(api.deleted).deep.equals(['psh_1'])

    // Signed in again, then out with the server away (the logout fails as
    // the delete does): the browser lets go of its subscription anyway.
    const subscribed = subscription('https://fcm.googleapis.com/fcm/send/again')
    const again = workers(subscribed)
    const offline = client()
    offline.unregisterPush = async () => {
      throw new Error('offline')
    }
    const browser = await browserDevice({
      notification: () => notification('granted', 'granted'),
      workers: () => again
    })
    await browser.sync(offline, U)
    await browser.release(offline)
    expect(subscribed.dropped).equals(true)

    // A registration that never went through leaves only the subscription
    // to drop, and a browser without workers nothing; neither throws.
    const failing = client()
    failing.registerPush = async () => {
      throw new Error('offline')
    }
    const unregistered = workers()
    const never = await browserDevice({
      notification: () => notification('granted', 'granted'),
      workers: () => unregistered
    })
    await never.sync(failing, U)
    await never.release(failing)
    expect(failing.deleted).deep.equals([])
    await (
      await browserDevice({
        notification: () => undefined,
        workers: () => undefined
      })
    ).release(failing)
    unregistered.getRegistration = async () => {
      throw new Error('No worker yet')
    }
    await never.release(failing)
  })

  it('lets go at sign-out at once, deletes the registration a change on its way made once it lands, and posts nothing asked for before', async function () {
    const api = heldClient()
    const held = subscription('https://fcm.googleapis.com/fcm/send/x')
    const device = await browserDevice(
      {
        notification: () => notification('granted', 'granted'),
        workers: () => workers(held)
      },
      undefined,
      memory(),
      { releaseTimeoutMs: 50 }
    )
    const changing = device.setSwitches(api, U, ON)
    while (api.order.length === 0) await wait()
    // Asked for before the sign-out, behind the change on its way.
    const syncing = device.sync(api, U)
    const releasing = device.release(api)
    await wait()
    // The subscription goes at once, the post still unanswered.
    expect(held.dropped).equals(true)
    await api.answerNext()
    await changing
    await syncing
    await releasing
    expect(api.order).deep.equals(['post true false'])
    expect(api.deleted).deep.equals(['psh_1'])
  })

  it('lets go at sign-out within its bound when a request ahead of it never answers', async function () {
    // A switch change on a stalled link: its post never comes back.
    const api = client()
    api.registerPush = async () => await new Promise<string>(() => {})
    const held = subscription('https://fcm.googleapis.com/fcm/send/x')
    const device = await browserDevice(
      {
        notification: () => notification('granted', 'granted'),
        workers: () => workers(held)
      },
      undefined,
      memory(),
      { releaseTimeoutMs: 20 }
    )
    device.setSwitches(api, U, ON).catch(() => undefined)
    await wait(5)
    const started = Date.now()
    await device.release(api)
    expect(Date.now() - started).lessThan(1000)
    expect(held.dropped).equals(true)
  })

  /**
   * A browser holding a subscription whose unsubscribing waits for
   * `letGo`, with a bound of its own, and an API whose delete never answers.
   */
  async function slowBrowser(): Promise<{
    device: ReturnType<typeof browserPushDevice>
    container: ReturnType<typeof workers>
    held: ReturnType<typeof subscription>
    api: ReturnType<typeof client>
    hanging: ReturnType<typeof client>
    letGo: () => void
  }> {
    const held = subscription('https://fcm.googleapis.com/fcm/send/held')
    const container = workers(held)
    const waiting: Array<() => void> = []
    held.unsubscribe = async () => {
      await new Promise<void>(resolve => {
        waiting.push(resolve)
      })
      held.dropped = true
      return true
    }
    const hanging = client()
    hanging.unregisterPush = async () => {
      await new Promise<void>(() => {})
    }
    return {
      device: await browserDevice(
        {
          notification: () => notification('granted', 'granted'),
          workers: () => container
        },
        undefined,
        memory(),
        { releaseTimeoutMs: 20 }
      ),
      container,
      held,
      api: client(),
      hanging,
      letGo: () => {
        for (const resolve of waiting.splice(0)) resolve()
      }
    }
  }

  it('waits for a hanging delete and a hanging unsubscribe only so long, and a sign-in registers then and again once it is let go', async function () {
    const { device, container, held, api, hanging, letGo } = await slowBrowser()
    await device.sync(api, U)
    expect(api.posted).length(1)
    const started = Date.now()
    let released = false
    const releasing = device.release(hanging).then(() => {
      released = true
    })
    // Signed in again at once: nothing registers within the bound.
    const syncing = device.sync(api, U)
    await wait(5)
    expect(api.posted).length(1)
    // Past it, sign-out is over (its logout goes), and the sign-in has
    // registered the subscription the browser still holds.
    await wait(40)
    expect(released).equals(true)
    await releasing
    await syncing
    expect(Date.now() - started).lessThan(1000)
    expect(api.posted).length(2)
    expect(held.dropped).equals(false)
    // The late unsubscribe took it down: a new one is made and registered.
    letGo()
    await wait(5)
    expect(held.dropped).equals(true)
    expect(container.subscribed).length(1)
    expect(api.posted).length(3)
    expect(JSON.parse(api.posted[2].address)).property(
      'endpoint',
      'https://fcm.googleapis.com/fcm/send/new'
    )
  })

  it('registers a sign-in after an unsubscribe that never settles, and nothing after a later sign-out', async function () {
    const { device, container, api, hanging, letGo } = await slowBrowser()
    await device.sync(api, U)
    const started = Date.now()
    await device.release(hanging)
    expect(Date.now() - started).lessThan(1000)
    await device.sync(api, U)
    expect(api.posted).length(2)
    // Signed out again before the first unsubscribe settles: nothing
    // registers after either.
    await device.release(hanging)
    letGo()
    await wait(5)
    expect(api.posted).length(2)
    expect(container.subscribed).length(0)
  })

  it('registers once only after an unsubscribe that settles within the bound', async function () {
    const { device, container, api, hanging, letGo } = await slowBrowser()
    await device.sync(api, U)
    const releasing = device.release(hanging)
    const syncing = device.sync(api, U)
    await wait(5)
    letGo()
    await releasing
    await syncing
    await wait(5)
    // Registered after the unsubscribe, which can no longer take it down.
    expect(container.subscribed).length(1)
    expect(api.posted).length(2)
  })

  it('reads a base64url key into its bytes', function () {
    expect([...keyBytes('BAEC_-8')]).deep.equals([4, 1, 2, 255, 239])
    expect(Buffer.from(keyBytes(KEY)).toString('base64url')).equals(KEY)
  })

  it('cannot notify in a browser without notifications', async function () {
    expect(await pushDevice.state()).equals('unsupported')
    expect(await pushDevice.enable(client(), U)).equals('unsupported')
    const api = notification('granted', 'granted')
    Object.assign(globalThis, { Notification: api })
    expect(await pushDevice.state()).equals('granted')
    // Node has no service workers to register.
    const none = client()
    expect(await pushDevice.sync(none, U)).equals('granted')
    expect(none.posted).deep.equals([])
  })
})
