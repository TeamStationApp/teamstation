import type { PushClient, PushDevice, PushState } from './pushState'

export type { PushClient, PushDevice, PushState } from './pushState'

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

/** The part of the browser's `ServiceWorkerContainer` this uses. */
export interface WorkerContainer {
  register: (url: string, options: { scope: string }) => Promise<unknown>
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
 * session. A subscription made for another key (the server's was replaced)
 * is dropped for a new one. A server without Web Push registers nothing.
 */
export async function registerBrowser(
  workers: WorkerContainer,
  client: PushClient
): Promise<void> {
  const publicKey = await client.webPushKey()
  if (publicKey == null) return
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
  await client.registerPush({
    platform: 'web',
    address: JSON.stringify(subscription.toJSON()),
    environment: 'production'
  })
}

/**
 * A browser's notifications. The browser asks the person only in answer to a
 * click, so `enable` is called from one; a browser without `Notification`
 * cannot show any, and one without service workers cannot be woken.
 */
export function browserPushDevice(
  browser: BrowserPush = {
    notification: () =>
      (globalThis as { Notification?: NotificationApi }).Notification,
    workers: () =>
      (globalThis as { navigator?: { serviceWorker?: WorkerContainer } })
        .navigator?.serviceWorker
  }
): PushDevice {
  const state = async (): Promise<PushState> => {
    const notification = browser.notification()
    if (notification == null) return 'unsupported'
    return notification.permission === 'default'
      ? 'prompt'
      : notification.permission
  }
  /** Registers an allowed browser; the answer is its permission. */
  const sync = async (client: PushClient): Promise<PushState> => {
    const now = await state()
    const workers = browser.workers()
    if (now === 'granted' && workers != null)
      await registerBrowser(workers, client).catch(() => undefined)
    return now
  }
  return {
    state,
    enable: async client => {
      const notification = browser.notification()
      if (notification?.permission === 'default')
        await notification.requestPermission().catch(() => undefined)
      return await sync(client)
    },
    sync
  }
}

export const pushDevice = browserPushDevice()
