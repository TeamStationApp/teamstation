/**
 * `TSOrientation`: on Android the module that lets the activity turn
 * (`OrientationModule.kt`); on iOS the one that sets what the app's root
 * controller allows (`RCTCameraOrientation.mm`, `CameraGeometry`).
 */
export interface NativeOrientation {
  allowRotation: () => void
  lockPortrait: () => void
  /** Either landscape, by the phone's sensor; missing from older builds. */
  lockLandscape?: () => void
  /**
   * Upright or either landscape, by the sensor even with the phone's
   * rotation lock on; missing from older builds.
   */
  followSensor?: () => void
}

/**
 * What the streaming screen calls to hold the app sideways while it records
 * (`lockLandscape`) and to stand it upright after (`restore`), and what its
 * settings call to follow the phone's sensor (`followSensor`).
 * `allow` keeps to the phone's rotation lock and `followSensor` does not, so
 * settings turns in the hand even with auto-rotate off. An older build
 * without `followSensor` falls back to `allow`.
 *
 * Android only: the activity, which the manifest holds upright, is asked to
 * hold or follow. iOS's camera screen sets its geometry itself
 * (`applyCameraOrientation`), and the full-screen player turns through
 * `gridRotation` below. A build without the module does nothing rather than
 * throw.
 */
export function orientationLock(
  platform: string,
  native: NativeOrientation | null | undefined
): {
  allow: () => void
  lockLandscape: () => void
  followSensor: () => void
  restore: () => void
} {
  const module = platform === 'android' ? native : null
  return {
    allow: () => {
      module?.allowRotation()
    },
    lockLandscape: () => {
      module?.lockLandscape?.()
    },
    followSensor: () => {
      if (module?.followSensor != null) module.followSensor()
      else module?.allowRotation()
    },
    restore: () => {
      module?.lockPortrait()
    }
  }
}

/**
 * What the full-screen player calls to turn with the phone while it is up,
 * and to stand the app upright again when it goes.
 *
 * Both platforms. On Android the activity is asked to follow the phone, as
 * `orientationLock` does. On iOS the player is a sheet: a transparent
 * `Modal`, presented over the page rather than in place of it, so iOS turns
 * it only as far as the app's root controller allows, and that is held
 * upright. `allowRotation` lets the root turn with the phone (the
 * `Info.plist` set) while the sheet is up, and `lockPortrait` stands it
 * upright again. A build without the module does nothing.
 */
export function gridRotation(native: NativeOrientation | null | undefined): {
  allow: () => void
  restore: () => void
} {
  return {
    allow: () => {
      native?.allowRotation()
    },
    restore: () => {
      native?.lockPortrait()
    }
  }
}
