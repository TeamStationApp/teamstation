import { fonts } from './fonts'
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
  blackOp35: 'rgba(0, 0, 0, .35)',
  blackOp70: 'rgba(0, 0, 0, .7)',

  helveticaNeue: fonts.helveticaNeue,
  quicksandRegular: fonts.quicksand,
  quicksandSemiBold: fonts.quicksand,
  quicksandBold: fonts.quicksand
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
  primaryButtonPressedColor: palette.gsDarkOlive,
  secondaryButtonColor: palette.gsLightOlive,
  secondaryButtonPressedColor: palette.gsDarkOlive,
  secondaryButtonTextColor: palette.gsVeryDarkGreen,
  buttonGrayColor: palette.gsAccentGreen,
  clearButtonColor: palette.gsPaleGreen,
  clearIconBackgroundColor: palette.gsMediumOlive,
  clearIconColor: palette.white,
  buttonTextColor: palette.gsBeige,

  inputBackgroundColor: palette.white,
  inputBorderColor: palette.gsMediumOlive,
  inputFocusBorderColor: palette.gsAccentGreen,
  inputTextColor: palette.gsVeryDarkGreen,

  activeColor: palette.coralRed,
  scoringInstructionBackground: '#665016',
  scoringInstructionBorder: '#c5a13c',
  scoringInstructionText: '#ffffff',
  scoringCountdownColor: '#f1cf55',
  scoringSafeColor: '#24713d',
  scoringSafeIdleColor: '#a9d7b5',
  scoringOutColor: '#a83535',
  scoringOutIdleColor: '#e8aaa5',
  scoringDecisionText: '#ffffff',
  successColor: palette.gsLightOlive,
  warningColor: palette.amber,
  dangerColor: palette.coralRed,
  liveColor: palette.coralRed,
  scheduledColor: palette.gsMediumOlive,

  winBadgeBackground: palette.gsDarkOlive,
  winBadgeTextColor: palette.gsPaleGreen,
  lossBadgeBackground: palette.gsDarkOlive,
  lossBadgeTextColor: palette.amber,
  honourBadgeBackground: palette.gsDarkOlive,
  honourBadgeTextColor: palette.gold,
  neutralBadgeBackground: palette.gsDarkOlive,
  neutralBadgeTextColor: palette.gsPaleGreen,

  pillBackground: palette.gsDarkOlive,
  pillPressedBackground: palette.gsMediumOlive,
  pillTextColor: palette.gsBeige,
  pillActiveBackground: palette.gsLightOlive,
  pillActiveTextColor: palette.gsVeryDarkGreen,

  headerBackgroundColor: palette.gsVeryDarkGreen,
  headerBorderColor: palette.gsDarkOlive,
  headerTextColor: palette.gsBeige,
  navBackgroundColor: palette.gsVeryDarkGreen,
  markArcColor: '#8FB35C',
  // The cream, not a darker green: `#334423` against this header is a mark
  // with a hole where the body of the G should be.
  markBodyColor: '#E6E5D5',
  glassBackgroundColor: 'rgba(31, 36, 24, 0.55)',
  glassFallbackColor: palette.gsVeryDarkGreen,
  glassBorderColor: 'rgba(216, 214, 191, 0.14)',
  glassBlur: 'blur(24px) saturate(200%)',
  navActiveColor: palette.gsAccentGreen,
  navInactiveColor: palette.gsMediumOlive,

  scoreboardBackground: palette.black,
  scoreboardTextColor: palette.gsBeige,
  scoreboardMutedTextColor: palette.gsAccentGreen,
  scoreboardAccentColor: palette.gsAccentGreen,

  // The watch path
  highlightRowBackground: palette.gsDarkOlive,
  highlightRowActiveBackground: palette.gsMediumOlive,
  scoringPlayColor: palette.gold,
  videoBackgroundColor: palette.black,
  gridGutterRem: 0.75,

  shadowColor: palette.black,
  buttonShadowColor: palette.blackOp35,
  backgroundGradientColors: [palette.gsVeryDarkGreen, palette.gsDarkOlive],
  backgroundGradientStart: { x: 0, y: 0 },
  backgroundGradientEnd: { x: 1, y: 1 },

  radiusSmallRem: 0.25,
  radiusRem: 0.5,
  radiusLargeRem: 1,
  radiusPill: 9999,

  spaceXsRem: 0.25,
  spaceSmRem: 0.5,
  spaceMdRem: 0.875,
  spaceLgRem: 1.25,
  spaceXlRem: 2,

  maxContentWidthRem: 60
}
