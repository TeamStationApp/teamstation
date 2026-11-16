import {
  type PushDevice,
  type PushDeviceOptions,
  sharedPushDevice
} from './pushState'

export type { PushDevice, PushState } from './pushState'

/** The part of the browser's `Notification` this reads. */
interface NotificationApi {
  permission: 'granted' | 'denied' | 'default'
  requestPermission: () => Promise<'granted' | 'denied' | 'default'>
}

/**
 * A browser's notifications (`sharedPushDevice`). The browser asks the
 * person only in answer to a click, so `enable` is called from one; a
 * browser without `Notification` cannot show any.
 */
export function browserPushDevice(
  api: () => NotificationApi | undefined = () =>
    (globalThis as { Notification?: NotificationApi }).Notification,
  options: PushDeviceOptions = {}
): PushDevice {
  return sharedPushDevice(
    {
      state: async () => {
        const notification = api()
        if (notification == null) return 'unsupported'
        return notification.permission === 'default'
          ? 'prompt'
          : notification.permission
      },
      ask: async () => {
        const notification = api()
        if (notification?.permission === 'default')
          await notification.requestPermission()
      }
    },
    options
  )
}

export const pushDevice = browserPushDevice()
