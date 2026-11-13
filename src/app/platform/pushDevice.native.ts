import { Platform, TurboModuleRegistry } from 'react-native'

import { chatTag } from '../../common/push'
import type { Spec } from '../push/NativePush'
import { anySwitchOn, type NotificationSwitches } from './notificationSwitches'
import {
  type PushClient,
  type PushDevice,
  type PushDeviceOptions,
  type PushState,
  sharedPushDevice,
  type TokenDevice
} from './pushState'

export type {
  PushClient,
  PushDevice,
  PushState,
  ReleaseClient,
  TokenDevice
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
  | 'setUser'
>

const answered = (value: string): PushState =>
  value === 'granted' || value === 'denied' || value === 'prompt'
    ? value
    : 'unsupported'

/**
 * Registers `address`, this phone's push token, for the signed-in session,
 * with this phone's `switches`, and answers the registration's id. The
 * platform is the phone's; the environment is which APNs a token is for, and
 * always `production` on Android.
 */
export async function registerAddress(
  client: Pick<PushClient, 'registerPush'>,
  address: string,
  environment: string,
  switches: NotificationSwitches,
  os: string = Platform.OS
): Promise<string> {
  return await client.registerPush({
    platform: os === 'ios' ? 'ios' : 'android',
    address,
    environment: environment === 'development' ? 'development' : 'production',
    messages: switches.messages,
    rsvpEvents: switches.rsvpEvents
  })
}

/**
 * A phone's notifications, through `TSPush` (`sharedPushDevice`). A build
 * without the module cannot show any; one whose module has no token (Android
 * without Firebase) shows the permission the same way and registers nothing,
 * until the next start, sign-in or foreground.
 */
export function phonePushDevice(
  module: () => PushModule | null = () =>
    TurboModuleRegistry.get<Spec>('TSPush') ?? null,
  options: PushDeviceOptions = {}
): TokenDevice {
  return sharedPushDevice(
    {
      state: async () => {
        const push = module()
        if (push == null) return 'unsupported'
        return answered(await push.permissionState())
      },
      // The module asks only when it has not asked yet, and otherwise
      // answers as things stand.
      ask: async () => {
        await module()?.requestPermission()
      },
      register: async (client, switches, address) => {
        const push = module()
        if (push == null) return undefined
        const token = address ?? (await push.token())
        if (token == null) return undefined
        return await registerAddress(
          client,
          token,
          await push.environment(),
          switches
        )
      },
      // The token let go of by the module (`unregister`).
      letGo: async () => {
        await module()?.unregister()
      },
      setActiveConversation: conversationId => {
        module()?.setActiveConversation(conversationId)
      },
      clearConversation: async conversationId => {
        module()?.clear(chatTag(conversationId))
      },
      // What the module posts itself (a reminder, a DM's fallback) is shown
      // only for them.
      signedIn: userId => {
        module()?.setUser(userId ?? null)
      }
    },
    options
  )
}

let asking: Promise<PushState> | undefined

/**
 * Asks a phone that has never been asked, once either of its switches
 * stored for `userId` is on: at start, after a sign-in and whenever the app
 * comes to the foreground. Asked already, it catches up (`catchUp`): a phone
 * allowed in its settings since the last look, or whose register failed,
 * registers then, and not only at the next start. A call while one is under
 * way waits for the same answer.
 */
export async function askWhenWanted(
  device: PushDevice,
  client: PushClient,
  userId: string
): Promise<PushState> {
  asking ??= askOnce(device, client, userId).finally(() => {
    asking = undefined
  })
  return await asking
}

async function askOnce(
  device: PushDevice,
  client: PushClient,
  userId: string
): Promise<PushState> {
  if (
    (await device.state()) === 'prompt' &&
    anySwitchOn(await device.switches(userId))
  )
    return await device.enable(client, userId)
  return await device.catchUp(client, userId)
}

export const pushDevice = phonePushDevice()
