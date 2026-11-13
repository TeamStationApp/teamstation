import { TurboModuleRegistry } from 'react-native'

import { TeamStationClient } from '../../common/api'
import { loadChatCore } from '../../common/chatCrypto/core.native'
import { asChatWake, type ChatWake } from '../../common/push'
import type { ChatKeyRecord } from '../chat/keyRecord'
import { keyStore } from '../chat/keyStore.native'
import { launchApi } from '../native/launchApi'
import { pushDevice, type TokenDevice } from '../platform/pushDevice.native'
import { loadToken, loadUser } from '../platform/sessionStore.native'
import { openWake } from './chatWake'
import type { Spec } from './NativePush'

/**
 * The headless JavaScript tasks the Android app runs for a push
 * (`push/PushHandler.kt`), in the background or with the app open:
 *
 * - `ChatWake` opens a chat wake with this phone's own keys, and shows a
 *   notification only for a DM or a mention of the person it is for
 *   (`openWake`). A reminder never comes here: it is posted natively.
 * - `PushToken` registers a new FCM token (or a debug build's stand-in) for
 *   the person signed in, in the device's own turn (`tokenChanged`), with
 *   the switches this phone keeps for that person when it goes.
 *
 * Both go by who the app keeps as signed in (`sessionStore`'s user), so a
 * phone signed out does nothing, and a wake for anybody else shows nothing,
 * as the browser's service worker does. They call the API with the stored
 * token, or with none: a session whose token the app no longer keeps (a
 * refused request drops it) goes on in the cookie the API set at sign-in,
 * which React Native's networking sends from the app's own cookie jar.
 */

/** What the tasks read. */
export interface TaskDeps {
  /** The signed-in session's bearer token, when the app keeps one. */
  loadToken: () => Promise<string | undefined>
  /** Who is signed in, as the app last stored them; undefined signed out. */
  loadUser: () => Promise<{ id: string } | undefined>
  /** This phone's device, which registers in turn with its switch changes. */
  device: () => Pick<TokenDevice, 'tokenChanged'>
  /** This phone's chat key record for `userId`, when it holds one. */
  loadRecord: (userId: string) => Promise<ChatKeyRecord | undefined>
  /**
   * The API this launch talks to (`launchApi`, a develop build's server
   * override included: the one the token is kept for), signed in with
   * `token`, or with the session cookie alone.
   */
  client: (
    token: string | undefined
  ) => Promise<
    Pick<
      TeamStationClient,
      | 'chatMessages'
      | 'chatEpochs'
      | 'chatIdentity'
      | 'webPushKey'
      | 'registerPush'
      | 'updatePush'
    >
  >
  /** The chat crypto core, which opening a message needs. */
  loadCore: () => Promise<unknown>
  /** `TSPush`, where the build has it. */
  push: () => Pick<Spec, 'show'> | null
}

/** The data `PushHandler` hands each task. */
interface TaskData {
  payload?: unknown
  token?: unknown
}

/** Whether the app keeps `userId` as the person signed in here. */
async function signedInAs(deps: TaskDeps, userId: string): Promise<boolean> {
  const user = await deps.loadUser().catch(() => undefined)
  return user?.id === userId
}

/**
 * Opens one chat wake for the person signed in, and shows what `openWake`
 * says to, if anything.
 */
export async function runChatWake(
  data: TaskData,
  deps: TaskDeps
): Promise<void> {
  let wake: ChatWake
  try {
    wake = asChatWake(JSON.parse(String(data.payload)))
  } catch {
    return
  }
  const push = deps.push()
  if (push == null || !(await signedInAs(deps, wake.u))) return
  const client = await deps.client(await deps.loadToken())
  const record = await deps.loadRecord(wake.u).catch(() => undefined)
  // A core that will not load fails the open, which `openWake` answers.
  if (record != null) await deps.loadCore().catch(() => undefined)
  const shown = await openWake(wake, {
    record,
    fetchMessage: async (conversationId, seq) =>
      (
        await client.chatMessages(conversationId, { after: seq - 1, limit: 1 })
      )[0],
    fetchEpochs: async (conversationId, after) =>
      await client.chatEpochs(conversationId, after),
    fetchIdentity: async identityId => await client.chatIdentity(identityId)
  })
  if (shown == null) return
  push.show(shown.title, shown.body, shown.url, shown.tag, 'messages', wake.seq)
}

/**
 * Registers a new push token for the person signed in, after any register
 * or switch change already under way, with this phone's switches for them
 * as they are stored when it goes.
 */
export async function runPushToken(
  data: TaskData,
  deps: TaskDeps
): Promise<void> {
  const push = deps.push()
  if (typeof data.token !== 'string' || push == null) return
  const user = await deps.loadUser().catch(() => undefined)
  if (user == null) return
  await deps
    .device()
    .tokenChanged(
      await deps.client(await deps.loadToken()),
      user.id,
      data.token
    )
    .catch(() => undefined)
}

/**
 * The phone's own: its session, its key store, its chat core and the API
 * this launch talks to (`api`).
 */
export function phoneDeps(api: () => Promise<string> = launchApi): TaskDeps {
  return {
    loadToken,
    loadUser,
    device: () => pushDevice,
    loadRecord: async userId => await keyStore.load(userId),
    client: async token =>
      new TeamStationClient({ baseUrl: await api(), token }),
    loadCore: loadChatCore,
    push: () => TurboModuleRegistry.get<Spec>('TSPush') ?? null
  }
}

/** The part of `AppRegistry` this uses. */
export interface TaskRegistry {
  registerHeadlessTask: (
    name: string,
    task: () => (data: TaskData) => Promise<void>
  ) => void
}

/** Registers both tasks, before the app's component (`index.js`). */
export function registerPushTasks(
  registry: TaskRegistry,
  deps: () => TaskDeps = phoneDeps
): void {
  registry.registerHeadlessTask('ChatWake', () => async data => {
    await runChatWake(data, deps())
  })
  registry.registerHeadlessTask('PushToken', () => async data => {
    await runPushToken(data, deps())
  })
}
