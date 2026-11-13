/**
 * Whether this device may show notifications: allowed, refused, not asked
 * yet, or unable to show them at all.
 */
export type PushState = 'granted' | 'denied' | 'prompt' | 'unsupported'

/** This device's side of notifications. */
export interface PushDevice {
  /** The device's permission now, without asking. */
  state: () => Promise<PushState>
  /** Asks for permission when it has not been asked yet, then registers. */
  enable: () => Promise<PushState>
  /** Registers again a device already allowed, after sign-in or at start. */
  sync: () => Promise<PushState>
}
