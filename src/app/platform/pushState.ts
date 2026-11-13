import type { TeamStationClient } from '../../common/api'

/**
 * Whether this device may show notifications: allowed, refused, not asked
 * yet, or unable to show them at all.
 */
export type PushState = 'granted' | 'denied' | 'prompt' | 'unsupported'

/** The API a device registers its push address through. */
export type PushClient = Pick<TeamStationClient, 'webPushKey' | 'registerPush'>

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
}
