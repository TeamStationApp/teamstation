import type { ImageSourcePropType } from 'react-native'

import tsLogo from './tsLogo.png'

/**
 * The mark, as something `Image` will take.
 *
 * esbuild inlines a `.png` import as a data URL — a string — and Metro turns
 * the same import into an opaque handle, so `{ uri: … }` is right on one
 * platform and meaningless on the other. Both sides of that are here, in the
 * two files, rather than at the one place in the app that draws it.
 */
export const tsLogoSource: ImageSourcePropType = { uri: tsLogo }
