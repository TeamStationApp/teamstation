import { chatTag } from '../../common/push'
import type { NotificationSwitches } from './notificationSwitches'
import {
  type PushClient,
  type PushDevice,
  type PushDeviceOptions,
  type PushState,
  sharedPushDevice
} from './pushState'

export type {
  PushClient,
  PushDevice,
  PushState,
  ReleaseClient
} from './pushState'

/** The part of the browser's `Notification` this reads. */
interface NotificationApi {
  permission: 'granted' | 'denied' | 'default'
  requestPermission: () => Promise<'granted' | 'denied' | 'default'>
}

/** The part of a `PushSubscription` this reads. */
interface Subscription {
  options?: { applicationServerKey?: ArrayBuffer | null }
  toJSON: () => unknown
  unsubscribe: () => Promise<boolean>
}

/** The part of a `ServiceWorkerRegistration` clearing and releasing read. */
interface WorkerRegistration {
  getNotifications: (filter: {
    tag: string
  }) => Promise<ReadonlyArray<{ close: () => void }>>
  pushManager: { getSubscription: () => Promise<Subscription | null> }
}

/** The part of the browser's `ServiceWorkerContainer` this uses. */
export interface WorkerContainer {
  register: (url: string, options: { scope: string }) => Promise<unknown>
  getRegistration: () => Promise<WorkerRegistration | undefined>
  ready: Promise<{
    pushManager: {
      getSubscription: () => Promise<Subscription | null>
      subscribe: (options: {
        userVisibleOnly: true
        applicationServerKey: Uint8Array
      }) => Promise<Subscription>
    }
  }>
}

export interface BrowserPush {
  notification: () => NotificationApi | undefined
  /** The page's `navigator.serviceWorker`, where there is one. */
  workers: () => WorkerContainer | undefined
}

/** The service worker `src/build.mjs` writes beside the page. */
export const SERVICE_WORKER_URL = '/sw.js'

/** The bytes of a base64url key, as `PushManager.subscribe` takes them. */
export function keyBytes(key: string): Uint8Array {
  const text = atob(key.replace(/-/g, '+').replace(/_/g, '/'))
  return Uint8Array.from(text, char => char.charCodeAt(0))
}

function sameBytes(a: ArrayBuffer, b: Uint8Array): boolean {
  const left = new Uint8Array(a)
  return left.length === b.length && left.every((byte, i) => byte === b[i])
}

/**
 * Registers this browser: its service worker at `/`, a push subscription
 * for the server's VAPID key, and that subscription, posted for this
 * session with this browser's `switches`; answers the registration's id. A
 * subscription made for another key (the server's was replaced) is dropped
 * for a new one. A server without Web Push registers nothing.
 */
export async function registerBrowser(
  workers: WorkerContainer,
  client: PushClient,
  switches: NotificationSwitches
): Promise<string | undefined> {
  const publicKey = await client.webPushKey()
  if (publicKey == null) return undefined
  const applicationServerKey = keyBytes(publicKey)
  await workers.register(SERVICE_WORKER_URL, { scope: '/' })
  const { pushManager } = await workers.ready
  let subscription = await pushManager.getSubscription()
  const made = subscription?.options?.applicationServerKey
  if (
    subscription != null &&
    made != null &&
    !sameBytes(made, applicationServerKey)
  ) {
    await subscription.unsubscribe()
    subscription = null
  }
  subscription ??= await pushManager.subscribe({
    userVisibleOnly: true,
    applicationServerKey
  })
  return await client.registerPush({
    platform: 'web',
    address: JSON.stringify(subscription.toJSON()),
    environment: 'production',
    messages: switches.messages,
    rsvpEvents: switches.rsvpEvents,
    leagueManagement: switches.leagueManagement
  })
}

/**
 * Lets go of this browser's push subscription, so its endpoint wakes it no
 * more whatever the server still holds.
 */
async function unsubscribe(workers: WorkerContainer): Promise<void> {
  const registration = await workers.getRegistration()
  const subscription = await registration?.pushManager.getSubscription()
  await subscription?.unsubscribe()
}

/**
 * A browser's notifications (`sharedPushDevice`). The browser asks the
 * person only in answer to a click, so `enable` is called from one; a
 * browser without `Notification` cannot show any, and one without service
 * workers cannot be woken.
 */
export function browserPushDevice(
  browser: BrowserPush = {
    notification: () =>
      (globalThis as { Notification?: NotificationApi }).Notification,
    workers: () =>
      (globalThis as { navigator?: { serviceWorker?: WorkerContainer } })
        .navigator?.serviceWorker
  },
  options: PushDeviceOptions = {}
): PushDevice {
  return sharedPushDevice(
    {
      state: async () => {
        const notification = browser.notification()
        if (notification == null) return 'unsupported'
        return notification.permission === 'default'
          ? 'prompt'
          : notification.permission
      },
      ask: async () => {
        const notification = browser.notification()
        if (notification?.permission === 'default')
          await notification.requestPermission()
      },
      register: async (client, switches) => {
        const workers = browser.workers()
        return workers == null
          ? undefined
          : await registerBrowser(workers, client, switches)
      },
      letGo: async () => {
        const workers = browser.workers()
        if (workers != null) await unsubscribe(workers)
      },
      // The service worker sees which conversation a focused window shows.
      setActiveConversation: () => undefined,
      clearConversation: async conversationId => {
        const tag = chatTag(conversationId)
        try {
          const registration = await browser.workers()?.getRegistration()
          for (const shown of (await registration?.getNotifications({
            tag
          })) ?? [])
            shown.close()
        } catch {
          // Nothing shown here, or no worker yet.
        }
      },
      // The service worker asks the server who is signed in (`forWhoIsHere`).
      signedIn: () => undefined
    },
    options
  )
}

/**
 * A browser never asks on its own: it may ask only from a tap, so Account
 * offers Allow notifications on this device instead. At a foreground it
 * catches up: allowed since it was last looked at, or with a register that
 * failed or switches another tab changed, it registers again.
 */
export async function askWhenWanted(
  device: PushDevice,
  client: PushClient,
  userId: string
): Promise<PushState> {
  return await device.catchUp(client, userId)
}

export const pushDevice = browserPushDevice()
