import {
  type NotificationSwitches,
  readSwitches,
  writeSwitches
} from './notificationSwitches'
import type { UserSettingStorage } from './userSetting'

/**
 * Whether this device may show notifications: allowed, refused, not asked
 * yet, or unable to show them at all.
 */
export type PushState = 'granted' | 'denied' | 'prompt' | 'unsupported'

/**
 * Runs each piece of work once the one before it has settled, in the order
 * given, so an older one never lands last.
 */
export function serially(): <T>(work: () => Promise<T>) => Promise<T> {
  let last: Promise<unknown> = Promise.resolve()
  return async work => {
    const next = last.then(work, work)
    last = next.catch(() => undefined)
    return await next
  }
}

/** This device's side of notifications. */
export interface PushDevice {
  /** The device's permission now, without asking. */
  state: () => Promise<PushState>
  /**
   * This device's switches for `userId`, as stored once every change begun
   * before has been.
   */
  switches: (userId: string) => Promise<NotificationSwitches>
  /** Asks for permission when it has not been asked yet. */
  enable: () => Promise<PushState>
  /** Registers again a device already allowed, after sign-in or at start. */
  sync: () => Promise<PushState>
  /**
   * Changes this device's switches for `userId` by `change`, on what is
   * stored, one change after another. Answers the switches stored; never
   * throws.
   */
  setSwitches: (
    userId: string,
    change: Partial<NotificationSwitches>
  ) => Promise<NotificationSwitches>
}

/** What a browser or a phone does itself, beneath `sharedPushDevice`. */
export interface PushPlatform {
  /** The device's permission now, without asking. */
  state: () => Promise<PushState>
  /** Asks the person, where this platform asks from where it stands. */
  ask: () => Promise<void>
}

export interface PushDeviceOptions {
  /** Where the switches are kept; the device's own storage by default. */
  storage?: UserSettingStorage
}

/**
 * A device's notifications, the same on every platform but for what
 * `platform` does itself. The switches are stored one change after another,
 * each on what the one before it stored.
 */
export function sharedPushDevice(
  platform: PushPlatform,
  { storage }: PushDeviceOptions = {}
): PushDevice {
  /** Reading and changing the stored switches, one after another. */
  const storing = serially()
  return {
    state: platform.state,
    switches: async userId =>
      await storing(async () => await readSwitches(userId, storage)),
    enable: async () => {
      if ((await platform.state()) === 'granted') return 'granted'
      await platform.ask().catch(() => undefined)
      return await platform.state()
    },
    sync: platform.state,
    setSwitches: async (userId, change) =>
      await storing(async () => {
        const switches = { ...(await readSwitches(userId, storage)), ...change }
        await writeSwitches(userId, switches, storage)
        return switches
      })
  }
}
