import type { TeamStationClient } from '../../common/api'
import {
  type NotificationSwitches,
  readSwitches,
  SWITCHES_OFF,
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

/** The API a device lets go of its registration through. */
export type ReleaseClient = Pick<TeamStationClient, 'unregisterPush'>

/**
 * How long sign-out waits for the server to delete this device's
 * registration, and for the device to let go of its address, before it
 * signs out anyway: either can hang for minutes on a poor connection, and
 * the session's logout waits behind them.
 */
export const RELEASE_TIMEOUT_MS = 3000

/** Waits for `work` to settle, or `ms` at most; never throws. */
export async function settleWithin(
  work: Promise<unknown>,
  ms: number
): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined
  await Promise.race([
    work.then(
      () => undefined,
      () => undefined
    ),
    new Promise<void>(resolve => {
      timer = setTimeout(resolve, ms)
    })
  ])
  clearTimeout(timer)
}

/** Sign-out's letting go of a device's address, and a sign-in's wait for it. */
export interface Releaser {
  /**
   * Waits `ms` at most for the server's delete and the device's own letting
   * go (`local`) together, so the logout after it always goes in time.
   */
  release: (
    server: Promise<unknown> | undefined,
    local: Promise<unknown>
  ) => Promise<void>
  /**
   * Waited for before a sign-in registers: the last letting go, or `ms` of
   * it. One still under way then may yet take down what the sign-in
   * registers, so once it settles `again` runs, unless another sign-out
   * came first.
   */
  settled: (again: () => Promise<unknown>) => Promise<void>
}

export function releaser(ms: number): Releaser {
  /** The last letting go, bounded by `ms`. */
  let releasing: Promise<void> | undefined
  /** The last letting go, while it has not settled. */
  let late: Promise<void> | undefined
  let releases = 0
  return {
    release: async (server, local) => {
      releases++
      const done = local.then(
        () => undefined,
        () => undefined
      )
      late = done
      // Cleared before `releasing` answers, when it settles within `ms`.
      done
        .then(() => {
          if (late === done) late = undefined
        })
        .catch(() => undefined)
      releasing = settleWithin(done, ms)
      await Promise.all([
        server == null ? undefined : settleWithin(server, ms),
        releasing
      ])
    },
    settled: async again => {
      await releasing
      const pending = late
      if (pending == null) return
      const release = releases
      pending
        .then(async () => {
          if (releases === release) await again()
        })
        .catch(() => undefined)
    }
  }
}

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
 * the device tries again, one try for each, after which the next foreground
 * (`catchUp`) does.
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
   * then registers through `client` (`sync`). One allowed already catches up
   * (`catchUp`), so it is not posted twice after a switch change.
   */
  enable: (client: PushClient, userId: string) => Promise<PushState>
  /**
   * Registers again a device already allowed, after sign-in or at start,
   * with the switches stored for `userId` when its turn comes.
   */
  sync: (client: PushClient, userId: string) => Promise<PushState>
  /**
   * At a foreground: an allowed device with no registration, one whose
   * register or switch change did not reach the server, or one whose stored
   * switches are not those it last gave the server (another tab changed
   * them) registers again. One whose last register found nothing to post
   * (a server without Web Push, a phone with no token) with the switches
   * stored now waits for the next start or sign-in (`sync`).
   */
  catchUp: (client: PushClient, userId: string) => Promise<PushState>
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
  /**
   * At sign-out, while the session is still there: lets go of the device's
   * address itself at once, a browser's subscription or a phone's token,
   * whatever the turns ahead of it are doing, so a sign-out the server never
   * hears of leaves nothing to wake it for that person; and, in its turn
   * after every register and switch change begun before, deletes the
   * registration this device last made (`DELETE /me/push-registrations/:id`).
   * A register or switch change asked for before it and still waiting posts
   * nothing. The delete and the letting go are waited for
   * `RELEASE_TIMEOUT_MS` at most, together; a `sync` begun meanwhile
   * registers once the letting go has settled, or after that bound and again
   * when a late one settles. Never throws.
   */
  release: (client: ReleaseClient) => Promise<void>
  /**
   * Tells the device which conversation is on screen in the foreground, or
   * that none is: a wake for it shows nothing. A browser's service worker
   * looks at its windows itself.
   */
  setActiveConversation: (conversationId: string | null) => void
  /** Takes down this device's notifications of a conversation, once read. */
  clearConversation: (conversationId: string) => Promise<void>
  /**
   * Tells the device who is signed in in the app, or that nobody is: a
   * phone shows what it posts on its own only for them (`TSPush.setUser`).
   */
  signedIn: (userId: string | undefined) => void
}

/** A phone's device, which its `PushToken` task posts a new token through. */
export interface TokenDevice extends PushDevice {
  /**
   * Registers `address`, a new push token, in its turn, with the switches
   * stored for `userId` then: all off when it is not known.
   */
  tokenChanged: (
    client: PushClient,
    userId: string | undefined,
    address: string
  ) => Promise<void>
}

/** What a browser or a phone does itself, beneath `sharedPushDevice`. */
export interface PushPlatform {
  /** The device's permission now, without asking. */
  state: () => Promise<PushState>
  /** Asks the person, where this platform asks from where it stands. */
  ask: () => Promise<void>
  /**
   * Posts this device's address through `client` with `switches`: `address`
   * when given (a phone's new token), the device's own otherwise. Answers
   * the registration's id, or undefined with nothing to register (no
   * service worker, a server without Web Push, a phone with no token yet).
   * Throws when the post fails.
   */
  register: (
    client: PushClient,
    switches: NotificationSwitches,
    address?: string
  ) => Promise<string | undefined>
  /** Lets go of the device's address itself, at sign-out. */
  letGo: () => Promise<void>
  setActiveConversation: (conversationId: string | null) => void
  clearConversation: (conversationId: string) => Promise<void>
  signedIn: (userId: string | undefined) => void
}

export interface PushDeviceOptions {
  /** How long sign-out waits for its letting go (`RELEASE_TIMEOUT_MS`). */
  releaseTimeoutMs?: number
  /** When to try a failed register again (`RETRY_MS`). */
  retryMs?: readonly number[]
  /** Where the switches are kept; the device's own storage by default. */
  storage?: UserSettingStorage
}

const sameSwitches = (
  a: NotificationSwitches,
  b: NotificationSwitches
): boolean =>
  a.messages === b.messages &&
  a.rsvpEvents === b.rsvpEvents &&
  a.leagueManagement === b.leagueManagement

/**
 * A device's notifications, the same on every platform but for what
 * `platform` does itself. Every register, switch change, catch-up and
 * sign-out runs in one turn after another (`serially`), each reading the
 * switches stored when it runs, never ones it was handed earlier: a late
 * register posts what is stored then, and a later change always lands last.
 * The switches are stored in a turn of their own, so a change is kept at
 * once, whatever the server is doing.
 */
export function sharedPushDevice(
  platform: PushPlatform,
  {
    releaseTimeoutMs = RELEASE_TIMEOUT_MS,
    retryMs = RETRY_MS,
    storage
  }: PushDeviceOptions = {}
): TokenDevice {
  /** Registering, switch changes and sign-out, one after another. */
  const inTurn = serially()
  /** Reading and changing the stored switches, one after another. */
  const storing = serially()
  /**
   * The last sign-out's letting go, which a sign-in after it waits for, so it
   * never takes down what that sign-in registers.
   */
  const releasing = releaser(releaseTimeoutMs)
  /**
   * The registration this device last made, which a switch change updates
   * and sign-out deletes.
   */
  let registered: string | undefined
  /** The switches the server last took for it. */
  let sent: NotificationSwitches | undefined
  /**
   * The switches the last register posted nothing with, having nothing to
   * post: `catchUp` does not try again with the same ones.
   */
  let nothing: NotificationSwitches | undefined
  /**
   * Counts sign-outs: a register or switch change asked for before one
   * posts nothing once its turn comes after it.
   */
  let releases = 0
  /** Whether the last register or switch change failed to reach the server. */
  let behind = false
  /** Who is signed in here, by the last call: a retry registers for them. */
  let signedIn: { client: PushClient; userId: string } | undefined
  let retry: ReturnType<typeof setTimeout> | undefined
  let tries = 0

  const stored = async (
    userId: string | undefined
  ): Promise<NotificationSwitches> =>
    userId == null
      ? SWITCHES_OFF
      : await storing(async () => await readSwitches(userId, storage))
  const caughtUp = (): void => {
    behind = false
    tries = 0
    clearTimeout(retry)
    retry = undefined
  }
  /** Tries again after the next of `retryMs`, and at the next foreground. */
  const fellBehind = (): void => {
    behind = true
    const delay = retryMs[tries]
    if (retry != null || signedIn == null || delay == null) return
    tries++
    retry = setTimeout(() => {
      retry = undefined
      const now = signedIn
      if (now != null) sync(now.client, now.userId).catch(() => undefined)
    }, delay)
  }
  /**
   * In a turn: registers an allowed device, unless a sign-out came since it
   * was asked for (`asked`); the answer is its permission.
   */
  const post = async (
    client: PushClient,
    userId: string | undefined,
    asked: number,
    address?: string
  ): Promise<PushState> => {
    const now = await platform.state()
    if (now !== 'granted' || asked !== releases) return now
    const switches = await stored(userId)
    try {
      const id = await platform.register(client, switches, address)
      if (id != null) {
        registered = id
        sent = switches
      }
      nothing = id == null ? switches : undefined
      caughtUp()
    } catch {
      fellBehind()
    }
    return now
  }
  /** `post`, once the last sign-out's letting go has settled. */
  const postAfterRelease = async (
    client: PushClient,
    userId: string | undefined,
    asked: number,
    address?: string
  ): Promise<PushState> => {
    await releasing.settled(
      async () => await inTurn(async () => await post(client, userId, releases))
    )
    return await post(client, userId, asked, address)
  }
  const sync = async (
    client: PushClient,
    userId: string
  ): Promise<PushState> => {
    signedIn = { client, userId }
    const asked = releases
    return await inTurn(
      async () => await postAfterRelease(client, userId, asked)
    )
  }
  const catchUp = async (
    client: PushClient,
    userId: string
  ): Promise<PushState> => {
    signedIn = { client, userId }
    const asked = releases
    return await inTurn(async () => {
      const now = await platform.state()
      if (now !== 'granted') return now
      const switches = await stored(userId)
      if (
        registered != null &&
        !behind &&
        sent != null &&
        sameSwitches(sent, switches)
      )
        return now
      if (
        registered == null &&
        !behind &&
        nothing != null &&
        sameSwitches(nothing, switches)
      )
        return now
      return await postAfterRelease(client, userId, asked)
    })
  }
  return {
    state: platform.state,
    switches: stored,
    enable: async (client, userId) => {
      signedIn = { client, userId }
      if ((await platform.state()) === 'granted')
        return await catchUp(client, userId)
      await platform.ask().catch(() => undefined)
      return await sync(client, userId)
    },
    sync,
    catchUp,
    setSwitches: async (client, userId, change) => {
      signedIn = { client, userId }
      const next = storing(async () => {
        const switches = { ...(await readSwitches(userId, storage)), ...change }
        await writeSwitches(userId, switches, storage)
        return switches
      })
      // In its turn from the moment it is asked, so a change after it
      // lands after it.
      const asked = releases
      await inTurn(async () => {
        await next
        if (asked !== releases) return
        const id = registered
        if (id != null) {
          const switches = await stored(userId)
          try {
            await client.updatePush(id, switches)
            sent = switches
            caughtUp()
            return
          } catch {
            // Gone from the server, or unreachable: posted again below.
          }
        }
        await postAfterRelease(client, userId, asked)
      }).catch(() => undefined)
      return await next
    },
    tokenChanged: async (client, userId, address) => {
      if (userId != null) signedIn ??= { client, userId }
      const asked = releases
      await inTurn(
        async () => await postAfterRelease(client, userId, asked, address)
      ).catch(() => undefined)
    },
    release: async client => {
      signedIn = undefined
      releases++
      caughtUp()
      // At once: a turn ahead that never settles (a request on a stalled
      // link) cannot keep the address.
      const local = platform.letGo()
      const turn = inTurn(async () => {
        const id = registered
        registered = undefined
        sent = undefined
        nothing = undefined
        // Bounded, so the turns behind it (a sign-in's) wait no longer.
        if (id != null)
          await settleWithin(client.unregisterPush(id), releaseTimeoutMs)
      })
      await releasing.release(turn, local)
    },
    setActiveConversation: platform.setActiveConversation,
    clearConversation: platform.clearConversation,
    signedIn: platform.signedIn
  }
}
