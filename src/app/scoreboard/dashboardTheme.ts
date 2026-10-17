import { Dimensions } from 'react-native'

import { fonts } from '../theme/fonts'

/**
 * 1.0's dark TeamStation theme, `src/client/themes/tsDark.ts` at 25f9496e, exactly, for
 * the override dashboard alone.
 *
 * The dashboard is 1.0's, and so are its colours: the summer greens of the
 * TeamStation logo, with the count, the bases and the inning arrows in the
 * colours an operator already knows. It draws in these whatever the app's
 * own theme is, so it is not a `Theme` and does not come from `useTheme`.
 */
const palette = {
  white: '#FFFFFF',
  black: '#000000',
  transparent: '#00000000',

  // Logo colours, sampled from 1.0's logo raster
  tsBeige: '#E8E4D8',
  tsLightOlive: '#7A9860',
  tsMediumOlive: '#6B8E4E',
  tsDarkOlive: '#3D4E2F',
  tsVeryDarkGreen: '#1F2418',
  tsAccentGreen: '#88A870',
  tsPaleGreen: '#C4D4B8',

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
 * 1.0's `src/client/themes/scaling.ts` at 25f9496e: sizes grow with the window's height,
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
  backgroundColor: palette.tsVeryDarkGreen,
  cardBackgroundDark: palette.tsDarkOlive,
  containerBackgroundColor: palette.tsVeryDarkGreen,
  inactiveBackgroundColor: palette.tsDarkOlive,
  overlayBackgroundColor: palette.blackOp70,

  // Text
  primaryTextColor: palette.tsBeige,
  secondaryTextFont: fonts.inter,

  // Buttons
  secondaryButtonColor: palette.tsLightOlive,
  buttonGrayColor: palette.tsAccentGreen,
  clearButtonColor: palette.tsPaleGreen,

  // Bases and inning arrows
  activeColor: palette.coralRed,

  // Dashboard specific
  dashboardOverrideBackground: palette.tsMediumOlive,
  dashboardCircleGreen: palette.emeraldGreen,
  dashboardCircleOrange: palette.amber,
  dashboardCircleRed: palette.coralRed,
  dashboardInactiveColor: palette.tsDarkOlive,
  dashboardBaseFill: palette.tsVeryDarkGreen,
  dashboardOutlineGray: palette.tsAccentGreen,
  dashboardSuperscript: palette.tsPaleGreen,
  dashboardDarkBaseRed: palette.crimsonRed,

  // The C and Reset lettering
  scoreboardScoreText: palette.black,

  // Shadows
  shadowColor: palette.black
}

export type DashboardTheme = typeof dashboardTheme
