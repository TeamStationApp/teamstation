import { type TurboModule, TurboModuleRegistry } from 'react-native'

import type { PushDevice, PushState } from './pushState'

export type { PushDevice, PushState } from './pushState'

/** The permission half of the app's `TSPush` module. */
interface PushPermissions extends TurboModule {
  permissionState: () => Promise<string>
  requestPermission: () => Promise<string>
}

const answered = (value: string): PushState =>
  value === 'granted' || value === 'denied' || value === 'prompt'
    ? value
    : 'unsupported'

/**
 * A phone's notifications, through `TSPush`. A build without the module
 * cannot show any.
 */
export function phonePushDevice(
  module: () => PushPermissions | null = () =>
    TurboModuleRegistry.get<PushPermissions>('TSPush') ?? null
): PushDevice {
  const state = async (): Promise<PushState> => {
    const push = module()
    if (push == null) return 'unsupported'
    return answered(await push.permissionState())
  }
  return {
    state,
    enable: async () => {
      const push = module()
      const now = await state()
      return push != null && now === 'prompt'
        ? answered(await push.requestPermission())
        : now
    },
    sync: state
  }
}

export const pushDevice = phonePushDevice()
