import { TurboModuleRegistry } from 'react-native'

import type { Spec } from '../push/NativePush'

/**
 * Sends the person to this phone's notification settings for the app
 * (`TSPush.openSettings`: the app's page in Settings on an iPhone, its
 * notification settings on Android), and answers whether it could. A build
 * without the module, or a phone that would not open them, answers false.
 */
export async function openNotificationSettings(
  module: () => Pick<Spec, 'openSettings'> | null = () =>
    TurboModuleRegistry.get<Spec>('TSPush') ?? null
): Promise<boolean> {
  try {
    return (await module()?.openSettings()) === true
  } catch {
    return false
  }
}
