import { Platform } from 'react-native'

/**
 * The names a `fontFamily` may be given, on a phone.
 *
 * One family name each, because that is all React Native accepts — a CSS stack
 * handed to `fontFamily` matches nothing and the platform quietly draws its own
 * system font instead, which is a whole app set in the wrong type with no error
 * anywhere to say so.
 *
 * `Space Grotesk` and `Material Symbols Outlined` are carried in the app;
 * `app/assets/fonts/README.md` says how. The two families `gsDark` names are
 * not, so they resolve to the system font rather than to nothing.
 */
export const fonts = {
  spaceGrotesk: 'Space Grotesk',
  quicksand: Platform.select({ ios: 'System', default: 'sans-serif' }) as string,
  helveticaNeue: Platform.select({
    ios: 'Helvetica Neue',
    default: 'sans-serif'
  }) as string,
  materialSymbols: 'Material Symbols Outlined'
}
