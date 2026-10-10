import type { ImageSourcePropType } from 'react-native'

/** A screenshot of the Settings app, and its shape. */
export interface SettingsShot {
  source: ImageSourcePropType
  /** Width over height. */
  aspectRatio: number
}

/**
 * The Apple Music settings screenshots belong to the iPhone, where the
 * walkthrough that shows them runs; the web has none.
 */
export const appleMusicSettings1: SettingsShot | null = null
export const appleMusicSettings2: SettingsShot | null = null
