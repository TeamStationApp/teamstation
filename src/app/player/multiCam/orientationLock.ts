/** The Android module that lets the activity turn (`OrientationModule.kt`). */
export interface NativeOrientation {
  allowRotation: () => void
  lockPortrait: () => void
  /** Either landscape, by the phone's sensor; missing from older builds. */
  lockLandscape?: () => void
}

/**
 * What the multi-camera view calls to turn with the phone while it is up,
 * and to stand the app upright again when it closes; and what the streaming
 * screen calls to hold the app sideways while it records (`lockLandscape`).
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
): { allow: () => void; lockLandscape: () => void; restore: () => void } {
  const module = platform === 'android' ? native : null
  return {
    allow: () => {
      module?.allowRotation()
    },
    lockLandscape: () => {
      module?.lockLandscape?.()
    },
    restore: () => {
      module?.lockPortrait()
    }
  }
}
