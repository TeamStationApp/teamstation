import type { TeamStationClient } from '../../common/api'

/**
 * Whether this device may show notifications: allowed, refused, not asked
 * yet, or unable to show them at all.
 */
export type PushState = 'granted' | 'denied' | 'prompt' | 'unsupported'

/** The API a device registers its push address through. */
export type PushClient = Pick<TeamStationClient, 'webPushKey' | 'registerPush'>

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

/** The API `askWhenWanted` reads the account's switches through. */
export type AskClient = PushClient &
  Pick<TeamStationClient, 'accountNotifications'>

/** This device's side of notifications. */
export interface PushDevice {
  /** The device's permission now, without asking. */
  state: () => Promise<PushState>
  /**
   * Asks for permission when it has not been asked yet, then registers
   * through `client` when allowed.
   */
  enable: (client: PushClient) => Promise<PushState>
  /** Registers again a device already allowed, after sign-in or at start. */
  sync: (client: PushClient) => Promise<PushState>
  /**
   * At sign-out, while the session is still there: deletes the registration
   * this device last made (`DELETE /me/push-registrations/:id`), and lets go
   * of its address itself, a browser's subscription or a phone's token, so a
   * sign-out the server never hears of leaves nothing to wake it for that
   * person. The delete and the letting go are waited for
   * `RELEASE_TIMEOUT_MS` at most, together; letting go happens whatever the
   * server answers, and a `sync` begun meanwhile registers once it has, or
   * after that bound and again when a late one settles. Never throws.
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
}
