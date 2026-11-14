import { TeamStationClient } from '../../common/api'
import { loadChatCore } from '../../common/chatCrypto/core'
import {
  asPushPayload,
  chatTag,
  type PushPayload,
  showsEveryPush
} from '../../common/push'
import type { ChatKeyRecord } from '../chat/keyRecord'
import { webKeyStore } from '../chat/keyStore'
import { openWake, type WakeNotification } from '../push/chatWake'

/**
 * The web app's service worker (`sw.js`, built by
 * `scripts/serviceWorkerBuild.mjs` and registered by `pushDevice.ts`). It
 * wakes for a push and decides what this browser shows, Signal style: a chat
 * wake is opened here with this browser's own chat keys, and only a DM or a
 * mention of the person it is for is shown, unless a focused TeamStation
 * window is showing that conversation (where a push service counts a push
 * that shows nothing, it is shown and taken down at once); a reminder is
 * shown as it came. Either is shown only while the person it is for is the
 * one signed in here. A
 * read (`ChatRead`) takes the conversation's notifications down. A tap
 * brings a TeamStation window to the conversation or the event.
 */
declare const TS_API_BASE_URL: string | undefined

/** What showing a push reads. */
export interface WorkerDeps {
  /** This browser's key record for `userId`, when it holds one. */
  loadRecord: (userId: string) => Promise<ChatKeyRecord | undefined>
  /** The API, with this browser's session cookie. */
  client: Pick<
    TeamStationClient,
    'chatMessages' | 'chatEpochs' | 'chatIdentity'
  >
  /** The chat crypto core, which opening a message needs. */
  loadCore: () => Promise<unknown>
  /**
   * Who this browser's session is for, or null when nobody is signed in;
   * throws when the server cannot say.
   */
  signedIn: () => Promise<string | null>
}

interface ExtendableEvent {
  waitUntil: (work: Promise<unknown>) => void
}
interface PushEvent extends ExtendableEvent {
  data: { text: () => string } | null
}
interface NotificationClickEvent extends ExtendableEvent {
  notification: { data?: unknown; close: () => void }
}
export interface WindowClient {
  url: string
  focused: boolean
  visibilityState: 'visible' | 'hidden' | 'prerender'
  focus: () => Promise<WindowClient>
  navigate: (url: string) => Promise<WindowClient | null>
}
export interface WorkerClients {
  claim: () => Promise<void>
  matchAll: (options: {
    type: 'window'
    includeUncontrolled: boolean
  }) => Promise<readonly WindowClient[]>
  openWindow: (url: string) => Promise<unknown>
}
/** The part of `ServiceWorkerGlobalScope` this uses. */
export interface WorkerScope {
  addEventListener: {
    (
      type: 'install' | 'activate',
      listener: (event: ExtendableEvent) => void
    ): void
    (type: 'push', listener: (event: PushEvent) => void): void
    (
      type: 'notificationclick',
      listener: (event: NotificationClickEvent) => void
    ): void
  }
  skipWaiting: () => Promise<void>
  clients: WorkerClients
  registration: {
    showNotification: (
      title: string,
      options: {
        body: string
        tag: string
        data: ShownData
        icon: string
      }
    ) => Promise<void>
    getNotifications: (filter: {
      tag: string
    }) => Promise<ReadonlyArray<{ data?: unknown; close: () => void }>>
    pushManager: {
      getSubscription: () => Promise<{ endpoint: string } | null>
    }
  }
}

/**
 * What a shown notification keeps: the link a tap opens, and for a chat
 * wake its message's `seq`, so a read of an earlier one leaves it up.
 */
export interface ShownData {
  url: string
  seq?: number
}

/** A push's payload, or null when it is not a push of ours. */
export function payloadOf(data: string | null): PushPayload | null {
  try {
    return asPushPayload(JSON.parse(data ?? ''))
  } catch {
    return null
  }
}

/**
 * Whether a push for `userId` may show here: not once the server says nobody
 * is signed in, or somebody else is, when it would tell them about another
 * person's events or who writes to them. Not knowing (the server away) is
 * not taken for either.
 */
async function forWhoIsHere(
  userId: string,
  deps: WorkerDeps
): Promise<boolean> {
  try {
    return (await deps.signedIn()) === userId
  } catch {
    return true
  }
}

/**
 * What a push shows, or null to show nothing: a reminder as it came, and a
 * chat wake as `openWake` opens it with this browser's record for `wake.u`.
 * Without one, a DM still says who wrote and a group message shows nothing.
 * Neither shows while the server says the person it is for is not the one
 * signed in here (`forWhoIsHere`).
 */
export async function notificationOf(
  payload: PushPayload | null,
  deps: WorkerDeps
): Promise<WakeNotification | null> {
  if (payload == null || payload.t === 'read') return null
  if (!(await forWhoIsHere(payload.u, deps))) return null
  if (payload.t === 'event') {
    const { title, body, url, tag } = payload
    return { title, body, url, tag }
  }
  const record = await deps.loadRecord(payload.u).catch(() => undefined)
  // A core that will not load fails the open, which `openWake` answers.
  if (record != null) await deps.loadCore().catch(() => undefined)
  return await openWake(payload, {
    record,
    fetchMessage: async (conversationId, seq) =>
      (
        await deps.client.chatMessages(conversationId, {
          after: seq - 1,
          limit: 1
        })
      )[0],
    fetchEpochs: async (conversationId, after) =>
      await deps.client.chatEpochs(conversationId, after),
    fetchIdentity: async identityId =>
      await deps.client.chatIdentity(identityId)
  })
}

/**
 * The page a notification's link opens: `teamstation://chat/<id>` is
 * `/chat/<id>` here, and a web address keeps its path.
 */
export function pathOfLink(link: string): string {
  const url = new URL(link, 'https://app.invalid')
  return url.protocol === 'https:' || url.protocol === 'http:'
    ? `${url.pathname}${url.search}`
    : `/${url.host}${url.pathname}${url.search}`
}

/**
 * Brings a TeamStation window to `link`: the open one, focused and moved
 * there, or a new one when none is open (or the open one cannot be moved).
 */
export async function openLink(
  clients: WorkerClients,
  link: string
): Promise<void> {
  const path = pathOfLink(link)
  const [open] = await clients.matchAll({
    type: 'window',
    includeUncontrolled: true
  })
  if (open != null) {
    const focused = await open.focus().catch(() => open)
    try {
      await focused.navigate(path)
      return
    } catch {
      // Not this worker's page yet: a window of its own instead.
    }
  }
  await clients.openWindow(path)
}

/**
 * Whether a TeamStation window that is focused and visible is showing
 * `conversationId` now: the person is reading it, and needs no notification.
 */
export async function onScreen(
  clients: WorkerClients,
  conversationId: string
): Promise<boolean> {
  const path = `/chat/${encodeURIComponent(conversationId)}`
  return (
    await clients.matchAll({ type: 'window', includeUncontrolled: true })
  ).some(
    client =>
      client.focused &&
      client.visibilityState === 'visible' &&
      new URL(client.url).pathname === path
  )
}

/**
 * Takes down every notification of this browser's tagged `tag`, or with
 * `upTo` only those for a message at or before it: a read of seq 11 that
 * arrives after the wake for seq 12 leaves seq 12's up.
 */
export async function closeTagged(
  registration: Pick<WorkerScope['registration'], 'getNotifications'>,
  tag: string,
  upTo?: number
): Promise<void> {
  for (const shown of await registration.getNotifications({ tag })) {
    const seq = (shown.data as Partial<ShownData> | undefined)?.seq
    if (upTo == null || typeof seq !== 'number' || seq <= upTo) shown.close()
  }
}

/**
 * Whether this browser's push service counts against its subscription each
 * push that shows nothing (Safari's and Firefox's, `showsEveryPush`), which
 * would end it: then every push it is sent is shown.
 */
export async function mustShowEveryPush(
  registration: Pick<WorkerScope['registration'], 'pushManager'>
): Promise<boolean> {
  const subscription = await registration.pushManager
    .getSubscription()
    .catch(() => null)
  return subscription != null && showsEveryPush(subscription.endpoint)
}

/**
 * What one push does: a read takes its conversation's notifications down,
 * up to the message it read to; a wake for the conversation on screen shows
 * nothing; and anything else shows what `notificationOf` says to, if
 * anything, a chat wake keeping its `seq`. Where every push must be shown
 * (`mustShowEveryPush`), the wake on screen is shown and taken down at
 * once, so the person reading sees nothing stay.
 */
export async function handlePush(
  scope: Pick<WorkerScope, 'clients' | 'registration'>,
  data: string | null,
  deps: WorkerDeps
): Promise<void> {
  const payload = payloadOf(data)
  if (payload?.t === 'read') {
    await closeTagged(scope.registration, chatTag(payload.c), payload.seq)
    return
  }
  const reading =
    payload?.t === 'chat' && (await onScreen(scope.clients, payload.c))
  if (reading && !(await mustShowEveryPush(scope.registration))) return
  const shown = await notificationOf(payload, deps)
  if (shown == null) return
  await scope.registration.showNotification(shown.title, {
    body: shown.body,
    tag: shown.tag,
    data:
      payload?.t === 'chat'
        ? { url: shown.url, seq: payload.seq }
        : { url: shown.url },
    icon: '/favicon.png'
  })
  if (reading) await closeTagged(scope.registration, shown.tag)
}

/** The worker's handlers, on `scope`. */
export function installWorker(scope: WorkerScope, deps: WorkerDeps): void {
  // A new worker takes over at once, the pages already open included, so a
  // tap can move them.
  scope.addEventListener('install', event => {
    event.waitUntil(scope.skipWaiting())
  })
  scope.addEventListener('activate', event => {
    event.waitUntil(scope.clients.claim())
  })
  scope.addEventListener('push', event => {
    event.waitUntil(handlePush(scope, event.data?.text() ?? null, deps))
  })
  scope.addEventListener('notificationclick', event => {
    event.notification.close()
    const data = event.notification.data as { url?: unknown } | undefined
    if (typeof data?.url === 'string')
      event.waitUntil(openLink(scope.clients, data.url))
  })
}

/** The browser's: its key store, the chat core, and the API. */
export function browserDeps(
  apiBaseUrl: string = typeof TS_API_BASE_URL === 'string'
    ? TS_API_BASE_URL
    : '/api/v1'
): WorkerDeps {
  const store = webKeyStore()
  const client = new TeamStationClient({ baseUrl: apiBaseUrl })
  return {
    loadRecord: async userId => await store.load(userId),
    client,
    loadCore: loadChatCore,
    signedIn: async () => (await client.whoAmI())?.id ?? null
  }
}

const here = globalThis as unknown as { ServiceWorkerGlobalScope?: unknown }
if (typeof here.ServiceWorkerGlobalScope === 'function')
  installWorker(globalThis as unknown as WorkerScope, browserDeps())
