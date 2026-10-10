import type { ImageSourcePropType } from 'react-native'

/**
 * A screenshot of the Settings app, and its shape. Declared again here, not
 * imported: a native sibling cannot import from its own web twin.
 */
export interface SettingsShot {
  source: ImageSourcePropType
  /** Width over height. */
  aspectRatio: number
}

/**
 * Settings › Apps › Music on an iPhone in dark mode, each pair of settings
 * the walkthrough asks for switched on and boxed in red: Add Playlist Songs
 * and Sync Library, then Download over Cellular and Automatic Downloads.
 *
 * `require`, not `import`: Metro's asset handling is built on it, and picks
 * the `@3x` file by the phone's scale.
 *
 * To make them again, when iOS moves or renames a setting: on an iPhone in
 * dark mode, open Settings › Apps › Music and switch the four on. Take a
 * maestro-d `takeScreenshot` of each pair and crop it to the settings
 * around the pair, below the status bar. Then draw a 4 pt (12 px at 3x)
 * `#FF3B30` rounded rectangle, 12 pt radius, around each row the
 * walkthrough names, from the row's bounds in the maestro-d hierarchy (in
 * points, so times 3). Check the result for anything personal (an account,
 * device or carrier name) before committing, and keep the `@3x` names and
 * the aspect ratios below in step with the files.
 */
export const appleMusicSettings1: SettingsShot | null = {
  source: require('./appleMusicSettings1.png') as ImageSourcePropType,
  aspectRatio: 1144 / 1067
}
export const appleMusicSettings2: SettingsShot | null = {
  source: require('./appleMusicSettings2.png') as ImageSourcePropType,
  aspectRatio: 1144 / 1290
}
