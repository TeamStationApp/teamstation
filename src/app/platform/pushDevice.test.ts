import { expect } from 'chai'
import { afterEach, describe, it } from 'mocha'

import type { PushRegistration } from '../../common/api'
import {
  browserPushDevice,
  keyBytes,
  type PushClient,
  pushDevice,
  type WorkerContainer
} from './pushDevice'

type Permission = 'granted' | 'denied' | 'default'

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
function workers(held?: ReturnType<typeof subscription>): WorkerContainer & {
  registered: Array<{ url: string; scope: string }>
  subscribed: Array<{ userVisibleOnly: boolean; key: string }>
} {
  const container = {
    registered: [] as Array<{ url: string; scope: string }>,
    subscribed: [] as Array<{ userVisibleOnly: boolean; key: string }>,
    register: async (url: string, options: { scope: string }) => {
      container.registered.push({ url, scope: options.scope })
      return {}
    },
    ready: Promise.resolve({
      pushManager: {
        getSubscription: async () => held ?? null,
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

/** The API: the server's key (null for none), and what was posted. */
function client(key: string | null = KEY): PushClient & {
  posted: PushRegistration[]
} {
  const api = {
    posted: [] as PushRegistration[],
    webPushKey: async () => key,
    registerPush: async (registration: PushRegistration) => {
      api.posted.push(registration)
      return 'psh_1'
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
      const device = browserPushDevice({
        notification: () => api,
        workers: () => undefined
      })
      expect(await device.state()).equals(state)
      expect(await device.sync(client())).equals(state)
      expect(api.asked).equals(0)
    }
  })

  it('asks only when not asked yet, and answers what the person chose', async function () {
    const ask = async (api: ReturnType<typeof notification>): Promise<string> =>
      await browserPushDevice({
        notification: () => api,
        workers: () => undefined
      }).enable(client())
    expect(await ask(notification('default', 'granted'))).equals('granted')
    expect(await ask(notification('default', 'denied'))).equals('denied')
    // A dismissed prompt is still unanswered.
    expect(await ask(notification('default', 'default'))).equals('prompt')
    const blocked = notification('denied', 'granted')
    expect(await ask(blocked)).equals('denied')
    expect(blocked.asked).equals(0)
    // A browser that throws instead of asking is left unanswered.
    const broken = notification('default', new Error('No prompt'))
    expect(await ask(broken)).equals('prompt')
    expect(broken.asked).equals(1)
  })

  it('registers its worker at the root, subscribes for the server’s key and posts the subscription', async function () {
    const container = workers()
    const api = client()
    const asking = notification('default', 'granted')
    const device = browserPushDevice({
      notification: () => asking,
      workers: () => container
    })
    expect(await device.enable(api)).equals('granted')
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
        environment: 'production'
      }
    ])
    // Signed in again, the same subscription is posted again.
    expect(await device.sync(api)).equals('granted')
    expect(container.subscribed).lengthOf(1)
    expect(api.posted).lengthOf(2)
    expect(api.posted[1]).deep.equals(api.posted[0])
  })

  it('keeps a subscription for this key, and replaces one made for another', async function () {
    const kept = subscription('https://fcm.googleapis.com/fcm/send/kept')
    const keeping = workers(kept)
    const api = client()
    await browserPushDevice({
      notification: () => notification('granted', 'granted'),
      workers: () => keeping
    }).sync(api)
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
    await browserPushDevice({
      notification: () => notification('granted', 'granted'),
      workers: () => replacing
    }).sync(again)
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
    await browserPushDevice({
      notification: () => notification('denied', 'granted'),
      workers: () => container
    }).sync(refused)
    expect(refused.posted).deep.equals([])
    expect(container.registered).deep.equals([])

    const without = client()
    expect(
      await browserPushDevice({
        notification: () => notification('granted', 'granted'),
        workers: () => undefined
      }).sync(without)
    ).equals('granted')
    expect(without.posted).deep.equals([])

    const off = client(null)
    await browserPushDevice({
      notification: () => notification('granted', 'granted'),
      workers: () => container
    }).sync(off)
    expect(off.posted).deep.equals([])
    expect(container.registered).deep.equals([])
  })

  it('answers the permission when registering fails', async function () {
    const failing = client()
    failing.registerPush = async () => {
      throw new Error('offline')
    }
    expect(
      await browserPushDevice({
        notification: () => notification('granted', 'granted'),
        workers: () => workers()
      }).sync(failing)
    ).equals('granted')
  })

  it('reads a base64url key into its bytes', function () {
    expect([...keyBytes('BAEC_-8')]).deep.equals([4, 1, 2, 255, 239])
    expect(Buffer.from(keyBytes(KEY)).toString('base64url')).equals(KEY)
  })

  it('cannot notify in a browser without notifications', async function () {
    expect(await pushDevice.state()).equals('unsupported')
    expect(await pushDevice.enable(client())).equals('unsupported')
    const api = notification('granted', 'granted')
    Object.assign(globalThis, { Notification: api })
    expect(await pushDevice.state()).equals('granted')
    // Node has no service workers to register.
    const none = client()
    expect(await pushDevice.sync(none)).equals('granted')
    expect(none.posted).deep.equals([])
  })
})
