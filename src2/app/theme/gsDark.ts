import type { Theme } from './types'

/**
 * GameStation's dark theme, carried over from the v1 scoreboard and dashboard
 * (`src/client/themes/gsDark.ts`) so the new app looks like the one Paul
 * already uses. The palette is the same; what is new are the component names
 * the watch path needs.
 *
 * Nothing outside this file names a colour.
 */
const palette = {
  white: '#FFFFFF',
  black: '#000000',
  transparent: '#00000000',

  // From the GameStation logo
  gsBeige: '#E8E4D8',
  gsLightOlive: '#7A9860',
  gsMediumOlive: '#6B8E4E',
  gsDarkOlive: '#3D4E2F',
  gsVeryDarkGreen: '#1F2418',
  gsAccentGreen: '#88A870',
  gsPaleGreen: '#C4D4B8',

  emeraldGreen: '#22c55e',
  coralRed: '#ef4444',
  amber: '#ffa500',
  gold: '#DAA520',

  blackOp30: 'rgba(0, 0, 0, .3)',
  blackOp70: 'rgba(0, 0, 0, .7)',

  helveticaNeue: 'Helvetica Neue, Arial, sans-serif',
  quicksandRegular: 'Quicksand, -apple-system, BlinkMacSystemFont, sans-serif',
  quicksandSemiBold: 'Quicksand, -apple-system, BlinkMacSystemFont, sans-serif',
  quicksandBold: 'Quicksand, -apple-system, BlinkMacSystemFont, sans-serif'
}

/**
 * One rem is 16 logical pixels until the app is running and can measure the
 * window. The app replaces this with the scaling helper at start-up; keeping a
 * plain function here means the theme can be read, tested and type-checked
 * without React Native present.
 */
const BASE_REM = 16
const rem = (size: number): number => Math.round(BASE_REM * size)

export const gsDark: Theme = {
  rem,
  isDark: true,

  defaultBorderColor: palette.gsPaleGreen,

  backgroundColor: palette.gsVeryDarkGreen,
  cardBackgroundColor: palette.gsBeige,
  cardBackgroundDark: palette.gsDarkOlive,
  containerBackgroundColor: palette.gsVeryDarkGreen,
  inactiveBackgroundColor: palette.gsDarkOlive,
  overlayBackgroundColor: palette.blackOp70,

  primaryTextFont: palette.quicksandBold,
  primaryTextFontSizeRem: 1.25,
  primaryTextColor: palette.gsBeige,
  secondaryTextColor: palette.gsVeryDarkGreen,
  tertiaryTextColor: palette.gsDarkOlive,
  placeholderTextColor: palette.gsMediumOlive,
  secondaryTextFont: palette.helveticaNeue,
  regularTextFont: palette.quicksandRegular,
  boldTextFont: palette.quicksandBold,
  semiBoldTextFont: palette.quicksandSemiBold,

  primaryButtonColor: palette.gsMediumOlive,
  secondaryButtonColor: palette.gsLightOlive,
  buttonGrayColor: palette.gsAccentGreen,
  clearButtonColor: palette.gsPaleGreen,
  buttonTextColor: palette.gsBeige,

  inputBackgroundColor: palette.white,
  inputBorderColor: palette.gsMediumOlive,
  inputTextColor: palette.gsVeryDarkGreen,

  activeColor: palette.coralRed,
  successColor: palette.gsLightOlive,
  warningColor: palette.amber,
  dangerColor: palette.coralRed,

  // The watch path
  highlightRowBackground: palette.gsDarkOlive,
  highlightRowActiveBackground: palette.gsMediumOlive,
  scoringPlayColor: palette.gold,
  videoBackgroundColor: palette.black,
  gridGutterRem: 0.75,

  shadowColor: palette.black,
  backgroundGradientColors: [palette.gsVeryDarkGreen, palette.gsDarkOlive],
  backgroundGradientStart: { x: 0, y: 0 },
  backgroundGradientEnd: { x: 1, y: 1 }
}
