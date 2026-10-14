import type { NativeOrientation } from '../player/multiCam/orientationLock'

/**
 * Turns the iPhone's interface.
 *
 * iOS intersects the top controller with the mask the app delegate reports.
 * Landscape narrows that mask to both landscapes, so the camera can flip
 * upside down and cannot stand upright. `any` restores the Info.plist mask,
 * which is what the settings sheet asks for so it can stand upright.
 * Android keeps its own activity lock; the multi-camera view never calls this.
 */
export function applyCameraOrientation(
  platform: string,
  native: NativeOrientation | null | undefined,
  mode: 'landscape' | 'any' | 'portrait'
): void {
  if (platform !== 'ios' || native == null) return
  if (mode === 'landscape') native.lockLandscape?.()
  else if (mode === 'any') native.allowRotation()
  else native.lockPortrait()
}
