import { fonts } from './fonts'
import { scoringSurface } from './scoringSurface'
import type { Theme } from './types'

/**
 * Organic Ballpark Classic — the light theme the designs are drawn in.
 *
 * The palette is taken from the Alta Hawks team hub, which Paul picked as the
 * one to standardise on. The design set was not consistent with itself: the
 * sign-in screen carried a nine-step green ramp, the league hub a third set,
 * and the written spec a fourth whose canvas was a mint `#f4fcea` rather than
 * the bone `#F5F7F1` every screen actually used. Where they disagreed, the
 * team hub wins.
 *
 * Every colour is named for what it *is* here, and named for where it is
 * *used* below. That is the rule in THEMES.md and it is the reason a screen can
 * never spell a hex code: change `forest` once and every primary button,
 * active pill and header follows.
 */
const palette = {
  selectorGray: '#D9DDD6',
  white: '#FFFFFF',
  transparent: '#00000000',

  // The greens, dark to light. `forest` is the brand: buttons, active pills,
  // the scoreboard panel. `sage` is the lighter partner used for accents that
  // must not read as a call to action.
  forest: '#2B4221',
  forestPressed: '#1E2D18',
  sage: '#4B6B38',
  sageBright: '#587A46',
  mint: '#93C47D',

  // Surfaces, warm rather than grey, so white cards read as raised.
  bone: '#F5F7F1',
  cream: '#EDF2E7',
  creamPressed: '#E2E7DB',
  fieldLine: '#E3EBD9',
  stone: '#D3DCCB',

  // Text, warm charcoal rather than black.
  bark: '#1A2116',
  moss: '#5C6B55',
  ash: '#788272',

  // Status. Clay is the active indicator, gold the honours, and live is red —
  // the one colour a parent glancing at a screen reads without being taught it.
  clay: '#BC4A24',
  liveRed: '#D22B2B',
  gold: '#D4A017',
  amberPale: '#FDF6E3',
  amberInk: '#8A6100',
  winPale: '#E6F4E2',
  winInk: '#385E26',
  crimson: '#BA1A1A',
  scoreBlue: '#1D4ED8',
  crimsonPale: '#FFDAD6',

  shadow: 'rgba(28, 35, 24, 0.10)',
  buttonShadow: 'rgba(28, 35, 24, 0.24)',
  scrim: 'rgba(26, 33, 22, 0.55)',

  /**
   * One family throughout. The designs used three — Plus Jakarta Sans, Inter
   * and Space Grotesk — and Paul chose the one on the sign-in screen. Its
   * numerals are near-monospaced, which is what makes a column of innings line
   * up without setting a second font for scores.
   *
   * Named by `fonts`, not spelled out here: a browser wants a stack and a
   * phone wants one family, and only one of the two can be a literal.
   */
  spaceGrotesk: fonts.spaceGrotesk
}

/** 16 logical pixels is one comfortable line, as on the web generally. */
const rem = (size: number): number => size * 16

export const tsBallpark: Theme = {
  scoringSurface,
  rem,
  isDark: false,

  defaultBorderColor: palette.fieldLine,

  // Backgrounds
  backgroundColor: palette.bone,
  cardBackgroundColor: palette.white,
  cardBackgroundDark: palette.forest,
  containerBackgroundColor: palette.cream,
  inactiveBackgroundColor: palette.cream,
  overlayBackgroundColor: palette.scrim,

  // Text
  primaryTextFont: palette.spaceGrotesk,
  primaryTextFontSizeRem: 1,
  primaryTextColor: palette.bark,
  secondaryTextColor: palette.moss,
  tertiaryTextColor: palette.ash,
  placeholderTextColor: palette.ash,
  secondaryTextFont: palette.spaceGrotesk,
  regularTextFont: palette.spaceGrotesk,
  boldTextFont: palette.spaceGrotesk,
  semiBoldTextFont: palette.spaceGrotesk,

  // Buttons
  primaryButtonColor: palette.forest,
  primaryButtonPressedColor: palette.forestPressed,
  secondaryButtonColor: palette.cream,
  secondaryButtonPressedColor: palette.creamPressed,
  secondaryButtonTextColor: palette.bark,
  buttonGrayColor: palette.stone,
  clearButtonColor: palette.transparent,
  clearIconBackgroundColor: palette.ash,
  clearIconColor: palette.white,
  buttonTextColor: palette.white,
  scoreActionColor: palette.scoreBlue,

  // Inputs
  inputBackgroundColor: palette.white,
  inputBorderColor: palette.stone,
  inputFocusBorderColor: palette.forest,
  inputTextColor: palette.bark,

  // Status
  activeColor: palette.forest,
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
  successColor: palette.winInk,
  warningColor: palette.gold,
  dangerColor: palette.crimson,
  liveColor: palette.liveRed,
  scheduledColor: palette.ash,

  // Badges: a win, a loss, and an honour such as 1st place.
  winBadgeBackground: palette.winPale,
  winBadgeTextColor: palette.winInk,
  lossBadgeBackground: palette.amberPale,
  lossBadgeTextColor: palette.amberInk,
  honourBadgeBackground: palette.winPale,
  honourBadgeTextColor: palette.forest,
  neutralBadgeBackground: palette.cream,
  neutralBadgeTextColor: palette.moss,

  // Pills — the tab strip that repeats on nearly every screen.
  pillBackground: palette.cream,
  // Well under the cream, so a slider's rail shows plainly on the bone page.
  sliderTrackBackground: '#CDD5C2',
  pillPressedBackground: palette.creamPressed,
  pillTextColor: palette.bark,
  pillActiveBackground: palette.forest,
  pillActiveTextColor: palette.white,

  // The header, and the navigation that becomes a sidebar on a wide screen.
  headerBackgroundColor: palette.white,
  headerBorderColor: palette.fieldLine,
  headerTextColor: palette.bark,
  navBackgroundColor: palette.white,
  markGradientStart: '#5e8f32',
  markGradientEnd: '#182e16',
  glassBackgroundColor: 'rgba(255, 255, 255, 0.55)',
  glassFallbackColor: palette.white,
  glassBorderColor: 'rgba(43, 45, 38, 0.10)',
  glassBlur: 'blur(24px) saturate(200%)',
  navActiveColor: palette.forest,
  navInactiveColor: palette.moss,

  // The scoreboard panel: dark, so the numerals carry.
  scoreboardBackground: palette.forest,
  scoreboardTextColor: palette.white,
  scoreboardMutedTextColor: palette.mint,
  scoreboardAccentColor: palette.mint,

  // The watch path's own names
  highlightRowBackground: palette.white,
  highlightRowActiveBackground: palette.cream,
  scoringControlBackground: palette.cream,
  scoringControlText: palette.forest,
  scoringPlayColor: palette.sage,
  videoBackgroundColor: palette.bark,
  gridGutterRem: 1,

  shadowColor: palette.shadow,
  scoringSelectorIdle: palette.selectorGray,
  buttonShadowColor: palette.buttonShadow,
  backgroundGradientColors: [palette.bone, palette.bone],
  backgroundGradientStart: { x: 0, y: 0 },
  backgroundGradientEnd: { x: 0, y: 1 },

  // Shape and rhythm, so a radius or a gap is never a bare number in a screen.
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

  // The container never grows past this, however wide the window. 60rem is
  // 960px: wide enough for a box score to breathe, narrow enough that a list
  // row does not put a team's name and its chevron a screen apart. Tried at 75
  // first, and that is exactly what it did.
  maxContentWidthRem: 60
}
