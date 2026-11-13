import type { TeamStationClient } from '../../common/api'
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
 * The API a device registers its push address through, with its own
 * switches, and changes them through.
 */
export type PushClient = Pick<
  TeamStationClient,
  'webPushKey' | 'registerPush' | 'updatePush'
>

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

/**
 * How long after a register or a switch change that did not reach the server
 * the device tries again, one try for each.
 */
export const RETRY_MS: readonly number[] = [5000, 30000, 120000]

/** This device's side of notifications. */
export interface PushDevice {
  /** The device's permission now, without asking. */
  state: () => Promise<PushState>
  /**
   * This device's switches for `userId`, as stored once every change begun
   * before has been.
   */
  switches: (userId: string) => Promise<NotificationSwitches>
  /**
   * Asks for permission when it has not been asked yet; a device allowed
   * then registers through `client` (`sync`). One allowed already registers
   * only when it has not yet, so it is not posted twice after a switch change.
   */
  enable: (client: PushClient, userId: string) => Promise<PushState>
  /**
   * Registers again a device already allowed, after sign-in or at start,
   * with the switches stored for `userId` when its turn comes.
   */
  sync: (client: PushClient, userId: string) => Promise<PushState>
  /**
   * Changes this device's switches for `userId` by `change`: stored first,
   * then, in its turn, the registration it last made takes the switches
   * stored then (`PATCH /me/push-registrations/:id`), or, with none or one
   * the server no longer has, an allowed device registers again with them.
   * A device not allowed keeps them for when it is. Answers the switches
   * stored, once the server has been told or the try failed; never throws.
   */
  setSwitches: (
    client: PushClient,
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
  /**
   * Posts this device's address through `client` with `switches`. Answers
   * the registration's id, or undefined with nothing to register (no
   * service worker, a server without Web Push, a phone that cannot yet).
   * Throws when the post fails.
   */
  register: (
    client: PushClient,
    switches: NotificationSwitches
  ) => Promise<string | undefined>
}

export interface PushDeviceOptions {
  /** When to try a failed register again (`RETRY_MS`). */
  retryMs?: readonly number[]
  /** Where the switches are kept; the device's own storage by default. */
  storage?: UserSettingStorage
}

/**
 * A device's notifications, the same on every platform but for what
 * `platform` does itself. Every register and switch change runs in one turn
 * after another (`serially`), each reading the switches stored when it
 * runs, never ones it was handed earlier: a late register posts what is
 * stored then, and a later change always lands last. The switches are
 * stored in a turn of their own, so a change is kept at once, whatever the
 * server is doing.
 */
export function sharedPushDevice(
  platform: PushPlatform,
  { retryMs = RETRY_MS, storage }: PushDeviceOptions = {}
): PushDevice {
  /** Registering and switch changes, one after another. */
  const inTurn = serially()
  /** Reading and changing the stored switches, one after another. */
  const storing = serially()
  /** The registration this device last made, which a switch change updates. */
  let registered: string | undefined
  /** Who is signed in here, by the last call: a retry registers for them. */
  let signedIn: { client: PushClient; userId: string } | undefined
  let retry: ReturnType<typeof setTimeout> | undefined
  let tries = 0

  const stored = async (userId: string): Promise<NotificationSwitches> =>
    await storing(async () => await readSwitches(userId, storage))
  const caughtUp = (): void => {
    tries = 0
    clearTimeout(retry)
    retry = undefined
  }
  /** Tries again after the next of `retryMs`. */
  const fellBehind = (): void => {
    const delay = retryMs[tries]
    if (retry != null || signedIn == null || delay == null) return
    tries++
    retry = setTimeout(() => {
      retry = undefined
      const now = signedIn
      if (now != null) sync(now.client, now.userId).catch(() => undefined)
    }, delay)
  }
  /** In a turn: registers an allowed device; the answer is its permission. */
  const post = async (
    client: PushClient,
    userId: string
  ): Promise<PushState> => {
    const now = await platform.state()
    if (now !== 'granted') return now
    const switches = await stored(userId)
    try {
      registered = (await platform.register(client, switches)) ?? registered
      caughtUp()
    } catch {
      fellBehind()
    }
    return now
  }
  const sync = async (
    client: PushClient,
    userId: string
  ): Promise<PushState> => {
    signedIn = { client, userId }
    return await inTurn(async () => await post(client, userId))
  }
  return {
    state: platform.state,
    switches: stored,
    enable: async (client, userId) => {
      signedIn = { client, userId }
      if ((await platform.state()) === 'granted')
        return await inTurn(async () =>
          registered == null ? await post(client, userId) : 'granted'
        )
      await platform.ask().catch(() => undefined)
      return await sync(client, userId)
    },
    sync,
    setSwitches: async (client, userId, change) => {
      signedIn = { client, userId }
      const next = storing(async () => {
        const switches = { ...(await readSwitches(userId, storage)), ...change }
        await writeSwitches(userId, switches, storage)
        return switches
      })
      // In its turn from the moment it is asked, so a change after it
      // lands after it.
      await inTurn(async () => {
        await next
        const id = registered
        if (id != null) {
          try {
            await client.updatePush(id, await stored(userId))
            caughtUp()
            return
          } catch {
            // Gone from the server, or unreachable: posted again below.
          }
        }
        await post(client, userId)
      }).catch(() => undefined)
      return await next
    }
  }
}
