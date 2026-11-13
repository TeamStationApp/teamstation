import { Platform, TurboModuleRegistry } from 'react-native'

import { chatTag } from '../../common/push'
import type { Spec } from '../push/NativePush'
import {
  type AskClient,
  type PushClient,
  type PushDevice,
  type PushState,
  RELEASE_TIMEOUT_MS,
  type ReleaseClient,
  releaser
} from './pushState'

export type {
  AskClient,
  PushDevice,
  PushState,
  ReleaseClient
} from './pushState'

/** The parts of the app's `TSPush` module this uses. */
type PushModule = Pick<
  Spec,
  | 'permissionState'
  | 'requestPermission'
  | 'token'
  | 'environment'
  | 'clear'
  | 'setActiveConversation'
  | 'unregister'
>

const answered = (value: string): PushState =>
  value === 'granted' || value === 'denied' || value === 'prompt'
    ? value
    : 'unsupported'

/**
 * The registration this phone last made, by the app's sync or by the
 * `PushToken` task for a new token, which sign-out deletes.
 */
let registered: string | undefined

/**
 * Registers `address`, this phone's push token, for the signed-in session,
 * and keeps the registration's id for sign-out. The platform is the
 * phone's; the environment is which APNs a token is for, and always
 * `production` on Android.
 */
export async function registerAddress(
  client: Pick<PushClient, 'registerPush'>,
  address: string,
  environment: string,
  os: string = Platform.OS
): Promise<void> {
  registered = await client.registerPush({
    platform: os === 'ios' ? 'ios' : 'android',
    address,
    environment: environment === 'development' ? 'development' : 'production'
  })
}

/**
 * A phone's notifications, through `TSPush`. A build without the module
 * cannot show any; one whose module has no token (Android without Firebase)
 * shows the permission the same way and registers nothing.
 */
export function phonePushDevice(
  module: () => PushModule | null = () =>
    TurboModuleRegistry.get<Spec>('TSPush') ?? null,
  releaseTimeoutMs = RELEASE_TIMEOUT_MS
): PushDevice {
  const state = async (): Promise<PushState> => {
    const push = module()
    if (push == null) return 'unsupported'
    return answered(await push.permissionState())
  }
  /**
   * The last sign-out's `unregister`, which a sign-in after it waits for, so
   * it never lets go of the token that sign-in registers.
   */
  const releasing = releaser(releaseTimeoutMs)
  /** Registers an allowed phone; the answer is its permission. */
  const sync = async (client: PushClient): Promise<PushState> => {
    await releasing.settled(async () => await sync(client))
    const now = await state()
    const push = module()
    if (now !== 'granted' || push == null) return now
    try {
      const token = await push.token()
      if (token != null)
        await registerAddress(client, token, await push.environment())
    } catch {
      // Registered again at the next start or sign-in.
    }
    return now
  }
  /**
   * The registration deleted, and the token let go of by the module
   * (`unregister`), which until the next `token` also shows nothing it posts
   * itself (a reminder, a DM's fallback).
   */
  const release = async (client: ReleaseClient): Promise<void> => {
    const id = registered
    registered = undefined
    await releasing.release(
      id == null ? undefined : client.unregisterPush(id),
      (async () => {
        await module()?.unregister()
      })()
    )
  }
  return {
    state,
    enable: async client => {
      // The module asks only when it has not asked yet, and otherwise
      // answers as things stand.
      const push = module()
      if (push != null && (await state()) !== 'granted')
        await push.requestPermission()
      return await sync(client)
    },
    sync,
    release,
    setActiveConversation: conversationId => {
      module()?.setActiveConversation(conversationId)
    },
    clearConversation: async conversationId => {
      module()?.clear(chatTag(conversationId))
    }
  }
}

let asking: Promise<PushState> | undefined
/** The permission the last ask found, so a change since is seen. */
let seen: PushState | undefined

/**
 * Asks a phone that has never been asked, once either of the account's
 * switches is on: at start, after a sign-in and whenever the app comes to the
 * foreground. Asked already, it answers as things stand, and a call while one
 * is under way waits for the same answer. A phone allowed in its settings
 * since the last look registers then, and not only at the next start.
 */
export async function askWhenWanted(
  device: PushDevice,
  client: AskClient
): Promise<PushState> {
  asking ??= askOnce(device, client).finally(() => {
    asking = undefined
  })
  return await asking
}

async function askOnce(
  device: PushDevice,
  client: AskClient
): Promise<PushState> {
  const now = await device.state()
  const before = seen
  seen = now
  // At start and after a sign-in the app's own sync registers it.
  if (now === 'granted' && before != null && before !== 'granted')
    return await device.sync(client)
  if (now !== 'prompt') return now
  const wanted = await client.accountNotifications()
  if (!(wanted.messages || wanted.rsvpEvents)) return now
  seen = await device.enable(client)
  return seen
}

export const pushDevice = phonePushDevice()
