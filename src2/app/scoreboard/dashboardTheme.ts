import { Dimensions } from 'react-native'

import { fonts } from '../theme/fonts'

/**
 * 1.0's dark GameStation theme, `src/client/themes/gsDark.ts`, exactly, for
 * the override dashboard alone.
 *
 * The dashboard is 1.0's, and so are its colours: the summer greens of the
 * GameStation logo, with the count, the bases and the inning arrows in the
 * colours an operator already knows. It draws in these whatever the app's
 * own theme is, so it is not a `Theme` and does not come from `useTheme`.
 */
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
  emeraldGreen: '#22c55e',

  // Reds and Oranges
  coralRed: '#ef4444',
  crimsonRed: '#801010',
  amber: '#ffa500',

  // Opacity variants
  blackOp70: 'rgba(0, 0, 0, .7)'
}

/**
 * 1.0's `src/client/themes/scaling.ts`: sizes grow with the window's height,
 * measured once, against a 568-point phone.
 */
const guidelineBaseHeight = 568
const scale = (size: number, factor: number = 0.3): number => {
  const { height } = Dimensions.get('window')
  const ratioVertical = (height - guidelineBaseHeight) / guidelineBaseHeight
  return size + size * factor * ratioVertical
}
const remSize = scale(16)

export const dashboardTheme = {
  rem: (size: number): number => Math.round(remSize * size),

  // Backgrounds
  backgroundColor: palette.gsVeryDarkGreen,
  cardBackgroundDark: palette.gsDarkOlive,
  containerBackgroundColor: palette.gsVeryDarkGreen,
  inactiveBackgroundColor: palette.gsDarkOlive,
  overlayBackgroundColor: palette.blackOp70,

  // Text
  primaryTextColor: palette.gsBeige,
  secondaryTextFont: fonts.helveticaNeue,

  // Buttons
  secondaryButtonColor: palette.gsLightOlive,
  buttonGrayColor: palette.gsAccentGreen,
  clearButtonColor: palette.gsPaleGreen,

  // Bases and inning arrows
  activeColor: palette.coralRed,

  // Dashboard specific
  dashboardOverrideBackground: palette.gsMediumOlive,
  dashboardCircleGreen: palette.emeraldGreen,
  dashboardCircleOrange: palette.amber,
  dashboardCircleRed: palette.coralRed,
  dashboardInactiveColor: palette.gsDarkOlive,
  dashboardBaseFill: palette.gsVeryDarkGreen,
  dashboardOutlineGray: palette.gsAccentGreen,
  dashboardSuperscript: palette.gsPaleGreen,
  dashboardDarkBaseRed: palette.crimsonRed,

  // The C and Reset lettering
  scoreboardScoreText: palette.black,

  // Shadows
  shadowColor: palette.black
}

export type DashboardTheme = typeof dashboardTheme
