import type { Theme } from '../types'
import { scale } from './scaling'

const palette = {
  white: '#FFFFFF',
  black: '#000000',
  transparent: '#00000000',

  // Blues and Greens
  indigoBlue: '#667eea',
  emeraldGreen: '#22c55e',
  forestGreen: '#116234',
  navyBlue: '#003087',
  skyBlue: '#3266ad',

  // Reds and Oranges
  coralRed: '#ef4444',
  crimsonRed: '#801010',
  amber: '#ffa500',
  gold: '#DAA520',

  // Browns
  saddleBrown: '#8B4513',

  // Grays (light to dark)
  almostWhite: '#f9f9f9',
  veryLightGray: '#ddd',
  lightGray: '#aaa',
  mediumLightGray: '#999',
  mediumGray: '#666',
  steel: '#606060',
  slateGray: '#555',
  darkSlate: '#4d4d4d',
  charcoal: '#3d3d3d',
  darkCharcoal: '#383838',
  darkerGray: '#2d2d2d',
  nearBlack: '#1a1a1a',
  darkGray: '#333',
  ash: '#4a4a4a',

  // Opacity variants
  blackOp10: 'rgba(0, 0, 0, .1)',
  blackOp30: 'rgba(0, 0, 0, .3)',
  blackOp50: 'rgba(0, 0, 0, .5)',
  blackOp70: 'rgba(0, 0, 0, .7)',

  // Fonts
  helveticaNeue: 'Helvetica Neue, Arial, sans-serif',
  quicksandBold: 'Quicksand-Bold',
  quicksandSemiBold: 'Quicksand-SemiBold',
  quicksandMedium: 'Quicksand-Medium',
  quicksandRegular: 'Quicksand-Regular',
  quicksandLight: 'Quicksand-Light'
}

const rem = (size: number): number => {
  return Math.round(scale(16) * size)
}

export const gsDark: Theme = {
  rem,
  isDark: true,

  // Common border
  defaultBorderColor: palette.veryLightGray,

  // Backgrounds
  backgroundColor: palette.nearBlack,
  cardBackgroundColor: palette.white,
  cardBackgroundDark: palette.darkerGray,
  containerBackgroundColor: palette.charcoal,
  inactiveBackgroundColor: palette.ash,
  overlayBackgroundColor: palette.blackOp70,

  // Primary text
  primaryTextFont: palette.quicksandBold,
  primaryTextFontSizeRem: 1.25,
  primaryTextColor: palette.white,
  secondaryTextColor: palette.darkGray,
  tertiaryTextColor: palette.mediumGray,
  placeholderTextColor: palette.mediumLightGray,

  // Secondary fonts
  secondaryTextFont: palette.helveticaNeue,
  boldTextFont: palette.quicksandBold,
  semiBoldTextFont: palette.quicksandSemiBold,

  // Buttons
  primaryButtonColor: palette.indigoBlue,
  secondaryButtonColor: palette.emeraldGreen,
  buttonGrayColor: palette.mediumGray,
  clearButtonColor: palette.mediumLightGray,
  buttonTextColor: palette.white,

  // Inputs
  inputBackgroundColor: palette.almostWhite,
  inputBorderColor: palette.veryLightGray,
  inputTextColor: palette.darkGray,

  // Status colors
  activeColor: palette.coralRed,
  successColor: palette.emeraldGreen,
  warningColor: palette.amber,
  dangerColor: palette.coralRed,

  // Dashboard specific
  dashboardOverrideBackground: palette.forestGreen,
  dashboardCircleGreen: palette.emeraldGreen,
  dashboardCircleOrange: palette.amber,
  dashboardCircleRed: palette.coralRed,
  dashboardInactiveColor: palette.ash,
  dashboardBaseFill: palette.darkCharcoal,
  dashboardOutlineGray: palette.steel,
  dashboardSuperscript: palette.lightGray,
  dashboardDarkBaseRed: palette.crimsonRed,

  // Scoreboard specific
  scoreboardBackground: palette.darkerGray,
  scoreboardBorderColor: palette.darkSlate,
  scoreboardSeparatorColor: palette.slateGray,
  scoreboardBaseFill: palette.darkCharcoal,
  scoreboardOutlineGray: palette.steel,
  scoreboardTeamAwayGradient: [palette.navyBlue, palette.skyBlue],
  scoreboardTeamHomeGradient: [palette.saddleBrown, palette.gold],
  scoreboardScoreBackground: palette.white,
  scoreboardScoreText: palette.black,

  // Shadows
  shadowColor: palette.black,

  // Gradients (kept for compatibility)
  backgroundGradientColors: [palette.nearBlack, palette.nearBlack],
  backgroundGradientStart: { x: 0, y: 0 },
  backgroundGradientEnd: { x: 1, y: 1 }
}
