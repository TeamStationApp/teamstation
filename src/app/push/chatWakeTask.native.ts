import { TurboModuleRegistry } from 'react-native'

import { TeamStationClient } from '../../common/api'
import { loadChatCore } from '../../common/chatCrypto/core.native'
import { asChatWake, type ChatWake } from '../../common/push'
import type { ChatKeyRecord } from '../chat/keyRecord'
import { keyStore } from '../chat/keyStore.native'
import { apiBaseUrl } from '../native/config'
import { registerAddress } from '../platform/pushDevice.native'
import { loadToken } from '../platform/sessionStore.native'
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
 *   the signed-in session.
 *
 * Both read the session the app keeps (`sessionStore`), so a phone signed
 * out does nothing.
 */

/** What the tasks read. */
export interface TaskDeps {
  /** The signed-in session's bearer token. */
  loadToken: () => Promise<string | undefined>
  /** This phone's chat key record for `userId`, when it holds one. */
  loadRecord: (userId: string) => Promise<ChatKeyRecord | undefined>
  /** The API, signed in with `token`. */
  client: (
    token: string
  ) => Pick<
    TeamStationClient,
    'chatMessages' | 'chatEpochs' | 'chatIdentity' | 'registerPush'
  >
  /** The chat crypto core, which opening a message needs. */
  loadCore: () => Promise<unknown>
  /** `TSPush`, where the build has it. */
  push: () => Pick<Spec, 'show' | 'environment'> | null
}

/** The data `PushHandler` hands each task. */
interface TaskData {
  payload?: unknown
  token?: unknown
}

/** Opens one chat wake and shows what `openWake` says to, if anything. */
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
  const token = await deps.loadToken()
  if (push == null || token == null) return
  const client = deps.client(token)
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

/** Registers a new push token for the signed-in session. */
export async function runPushToken(
  data: TaskData,
  deps: TaskDeps
): Promise<void> {
  const push = deps.push()
  const session = await deps.loadToken()
  if (typeof data.token !== 'string' || push == null || session == null) return
  await registerAddress(
    deps.client(session),
    data.token,
    await push.environment()
  ).catch(() => undefined)
}

/** The phone's own: its session, its key store, its chat core and the API. */
export function phoneDeps(): TaskDeps {
  return {
    loadToken,
    loadRecord: async userId => await keyStore.load(userId),
    client: token => new TeamStationClient({ baseUrl: apiBaseUrl, token }),
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
