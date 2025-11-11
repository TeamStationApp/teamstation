import type { Theme } from '../types'
import { scale } from './scaling'

const palette = {
  white: '#FFFFFF',
  black: '#000000',
  transparent: '#00000000',

  // GS Logo Colors - from gs_logo.png
  gsBeige: '#E8E4D8',
  gsLightOlive: '#7A9860',
  gsMediumOlive: '#6B8E4E',
  gsDarkOlive: '#3D4E2F',
  gsVeryDarkGreen: '#1F2418',
  gsAccentGreen: '#88A870',
  gsPaleGreen: '#C4D4B8',

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
  quicksandLight: 'Quicksand, -apple-system, BlinkMacSystemFont, sans-serif',
  quicksandRegular: 'Quicksand, -apple-system, BlinkMacSystemFont, sans-serif',
  quicksandMedium: 'Quicksand, -apple-system, BlinkMacSystemFont, sans-serif',
  quicksandSemiBold: 'Quicksand, -apple-system, BlinkMacSystemFont, sans-serif',
  quicksandBold: 'Quicksand, -apple-system, BlinkMacSystemFont, sans-serif'
}

const rem = (size: number): number => {
  return Math.round(scale(16) * size)
}

export const gsDark: Theme = {
  rem,
  isDark: true,

  // Common border
  defaultBorderColor: palette.gsPaleGreen,

  // Backgrounds
  backgroundColor: palette.gsVeryDarkGreen,
  cardBackgroundColor: palette.gsBeige,
  cardBackgroundDark: palette.gsDarkOlive,
  containerBackgroundColor: palette.gsVeryDarkGreen,
  inactiveBackgroundColor: palette.gsDarkOlive,
  overlayBackgroundColor: palette.blackOp70,

  // Primary text
  primaryTextFont: palette.quicksandBold,
  primaryTextFontSizeRem: 1.25,
  primaryTextColor: palette.gsBeige,
  secondaryTextColor: palette.gsVeryDarkGreen,
  tertiaryTextColor: palette.gsDarkOlive,
  placeholderTextColor: palette.gsMediumOlive,

  // Secondary fonts
  secondaryTextFont: palette.helveticaNeue,
  regularTextFont: palette.quicksandRegular,
  boldTextFont: palette.quicksandBold,
  semiBoldTextFont: palette.quicksandSemiBold,

  // Buttons
  primaryButtonColor: palette.gsMediumOlive,
  secondaryButtonColor: palette.gsLightOlive,
  buttonGrayColor: palette.gsAccentGreen,
  clearButtonColor: palette.gsPaleGreen,
  buttonTextColor: palette.gsBeige,

  // Inputs
  inputBackgroundColor: palette.white,
  inputBorderColor: palette.gsMediumOlive,
  inputTextColor: palette.gsVeryDarkGreen,

  // Status colors
  activeColor: palette.coralRed, // PRESERVED - used for bases and inning arrows
  successColor: palette.gsLightOlive,
  warningColor: palette.amber,
  dangerColor: palette.coralRed,

  // Dashboard specific
  dashboardOverrideBackground: palette.gsMediumOlive,
  dashboardCircleGreen: palette.emeraldGreen, // PRESERVED - balls color
  dashboardCircleOrange: palette.amber, // PRESERVED - strikes color
  dashboardCircleRed: palette.coralRed, // PRESERVED - outs color
  dashboardInactiveColor: palette.gsDarkOlive,
  dashboardBaseFill: palette.gsVeryDarkGreen,
  dashboardOutlineGray: palette.gsAccentGreen,
  dashboardSuperscript: palette.gsPaleGreen,
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
  backgroundGradientColors: [palette.gsVeryDarkGreen, palette.gsDarkOlive],
  backgroundGradientStart: { x: 0, y: 0 },
  backgroundGradientEnd: { x: 1, y: 1 }
}
