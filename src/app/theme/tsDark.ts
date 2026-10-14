import { fonts } from './fonts'
import { scoringSurface } from './scoringSurface'
import type { Theme } from './types'

/**
 * TeamStation's dark theme, carried over from the v1 scoreboard and dashboard
 * (`src/client/themes/tsDark.ts` at 25f9496e) so the new app looks like the one Paul
 * already uses. The palette is the same; what is new are the component names
 * the watch path needs.
 *
 * Nothing outside this file names a colour.
 */
const palette = {
  selectorGray: '#575D54',
  blue: '#90CAF9',
  white: '#FFFFFF',
  black: '#000000',
  transparent: '#00000000',

  // From the TeamStation logo
  tsBeige: '#E8E4D8',
  tsLightOlive: '#7A9860',
  tsMediumOlive: '#6B8E4E',
  tsDarkOlive: '#3D4E2F',
  tsVeryDarkGreen: '#1F2418',
  tsAccentGreen: '#88A870',
  tsPaleGreen: '#C4D4B8',

  emeraldGreen: '#22c55e',
  coralRed: '#ef4444',
  amber: '#ffa500',
  gold: '#DAA520',
  scoreBlue: '#1D4ED8',
  djPurple: '#5B21B6',

  blackOp30: 'rgba(0, 0, 0, .3)',
  blackOp35: 'rgba(0, 0, 0, .35)',
  blackOp70: 'rgba(0, 0, 0, .7)',

  inter: fonts.inter,
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

export const tsDark: Theme = {
  scoringSurface,
  chatAttentionBackgroundColor: '#0065D1',
  chatAttentionTextColor: '#FFFFFF',
  rem,
  isDark: true,

  defaultBorderColor: palette.tsPaleGreen,

  backgroundColor: palette.tsVeryDarkGreen,
  cardBackgroundColor: palette.tsBeige,
  cardBackgroundDark: palette.tsDarkOlive,
  containerBackgroundColor: palette.tsVeryDarkGreen,
  inactiveBackgroundColor: palette.tsDarkOlive,
  overlayBackgroundColor: palette.blackOp70,

  primaryTextFont: palette.quicksandBold,
  primaryTextFontSizeRem: 1.25,
  primaryTextColor: palette.tsBeige,
  secondaryTextColor: palette.tsVeryDarkGreen,
  tertiaryTextColor: palette.tsDarkOlive,
  placeholderTextColor: palette.tsMediumOlive,
  secondaryTextFont: palette.inter,
  regularTextFont: palette.quicksandRegular,
  boldTextFont: palette.quicksandBold,
  semiBoldTextFont: palette.quicksandSemiBold,

  primaryButtonColor: palette.tsMediumOlive,
  primaryButtonPressedColor: palette.tsDarkOlive,
  secondaryButtonColor: palette.tsLightOlive,
  secondaryButtonPressedColor: palette.tsDarkOlive,
  secondaryButtonTextColor: palette.tsVeryDarkGreen,
  buttonGrayColor: palette.tsAccentGreen,
  clearButtonColor: palette.tsPaleGreen,
  clearIconBackgroundColor: palette.tsMediumOlive,
  clearIconColor: palette.white,
  buttonTextColor: palette.tsBeige,
  scoreActionColor: palette.scoreBlue,
  djActionColor: palette.djPurple,

  inputBackgroundColor: palette.white,
  inputBorderColor: palette.tsMediumOlive,
  inputFocusBorderColor: palette.tsAccentGreen,
  inputTextColor: palette.tsVeryDarkGreen,

  activeColor: palette.coralRed,
  scoringInstructionBackground: '#665016',
  scoringInstructionBorder: '#c5a13c',
  scoringStatusText: '#665016',
  scoringInstructionText: '#ffffff',
  scoringCountdownColor: '#f1cf55',
  scoringSafeColor: '#24713d',
  scoringMenuActiveBackground: '#24713d',
  scoringMenuActiveText: '#ffffff',
  scoringSafeIdleColor: '#a9d7b5',
  scoringOutColor: '#a83535',
  scoringOutIdleColor: '#e8aaa5',
  scoringDecisionText: '#ffffff',
  successColor: palette.tsLightOlive,
  warningColor: palette.amber,
  dangerColor: palette.coralRed,
  addEventCardColor: palette.blue,
  addEventCardTextColor: '#000000',
  linkTextColor: palette.blue,
  liveColor: palette.coralRed,
  scheduledColor: palette.tsMediumOlive,

  winBadgeBackground: palette.tsDarkOlive,
  winBadgeTextColor: palette.tsPaleGreen,
  lossBadgeBackground: palette.tsDarkOlive,
  lossBadgeTextColor: palette.amber,
  honourBadgeBackground: palette.tsDarkOlive,
  honourBadgeTextColor: palette.gold,
  neutralBadgeBackground: palette.tsDarkOlive,
  neutralBadgeTextColor: palette.tsPaleGreen,

  pillBackground: palette.tsDarkOlive,
  sliderTrackBackground: palette.tsDarkOlive,
  pillPressedBackground: palette.tsMediumOlive,
  pillTextColor: palette.tsBeige,
  pillActiveBackground: palette.tsLightOlive,
  pillActiveTextColor: palette.tsVeryDarkGreen,

  headerBackgroundColor: palette.tsVeryDarkGreen,
  headerBorderColor: palette.tsDarkOlive,
  headerTextColor: palette.tsBeige,
  navBackgroundColor: palette.tsVeryDarkGreen,
  markGradientStart: '#8FB35C',
  // The cream, not the dark green: `#182e16` against this header is half a
  // mark.
  markGradientEnd: '#E6E5D5',
  glassBackgroundColor: 'rgba(31, 36, 24, 0.55)',
  glassFallbackColor: palette.tsVeryDarkGreen,
  glassBorderColor: 'rgba(216, 214, 191, 0.14)',
  glassBlur: 'blur(24px) saturate(200%)',
  navActiveColor: palette.tsAccentGreen,
  navInactiveColor: palette.tsMediumOlive,

  scoreboardBackground: palette.black,
  scoreboardTextColor: palette.tsBeige,
  scoreboardMutedTextColor: palette.tsAccentGreen,
  scoreboardAccentColor: palette.tsAccentGreen,

  // The watch path
  highlightRowBackground: palette.tsDarkOlive,
  highlightRowActiveBackground: palette.tsMediumOlive,
  scoringControlBackground: palette.tsBeige,
  scoringControlText: palette.tsVeryDarkGreen,
  scoringPlayColor: palette.gold,
  videoBackgroundColor: palette.black,
  gridGutterRem: 0.75,

  shadowColor: palette.black,
  scoringSelectorIdle: palette.selectorGray,
  buttonShadowColor: palette.blackOp35,
  backgroundGradientColors: [palette.tsVeryDarkGreen, palette.tsDarkOlive],
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
  cardContentInsetRem: 1,

  maxContentWidthRem: 60
}
