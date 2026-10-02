import type { ImageSourcePropType } from 'react-native'

/**
 * The mark, as something `Image` will take.
 *
 * `require`, not `import`: Metro's asset handling is built on it, and what
 * comes back is a registered asset rather than a path or a string.
 */
export const tsLogoSource: ImageSourcePropType =
  require('./tsLogo.png') as ImageSourcePropType
