/**
 * The names a `fontFamily` may be given, on a phone.
 *
 * One family name each, because that is all React Native accepts — a CSS stack
 * handed to `fontFamily` matches nothing and the platform quietly draws its own
 * system font instead, which is a whole app set in the wrong type with no error
 * anywhere to say so.
 *
 * Every family is carried in the app (`app/assets/fonts/README.md` says
 * how), and none is ever the system's: a system font draws at another size
 * on every platform, which the scoreboard especially cannot have. Inter
 * stands in for Helvetica Neue, which cannot be shipped.
 */
export const fonts = {
  spaceGrotesk: 'Space Grotesk',
  quicksand: 'Quicksand',
  inter: 'Inter',
  materialSymbols: 'Material Symbols Outlined'
}
