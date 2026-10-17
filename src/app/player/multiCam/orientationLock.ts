/** The Android module that lets the activity turn (`OrientationModule.kt`). */
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
 * What the multi-camera view calls to turn with the phone while it is up,
 * and to stand the app upright again when it closes; what the streaming
 * screen calls to hold the app sideways while it records (`lockLandscape`);
 * and what its settings call to follow the phone's sensor (`followSensor`).
 * `allow` keeps to the phone's rotation lock and `followSensor` does not, so
 * settings turns in the hand even with auto-rotate off. An older build
 * without `followSensor` falls back to `allow`.
 *
 * Android only. An Android `Modal` is a dialog inside the app's one activity,
 * which the manifest holds upright, so the activity itself is asked to follow
 * the phone. On iOS the `Modal` is a view controller of its own and turns by
 * declaring it (`supportedOrientations`), while the app's root controller
 * stays upright — there is nothing here to call. A build without the module
 * does nothing rather than throw: the view still works, upright.
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
