/**
 * The shape every theme fills in.
 *
 * Structured the way edge-react-gui does it: a theme file declares a private
 * `palette` of raw colours, then maps **component-level names** onto it. A
 * screen therefore asks for `theme.cardBackgroundColor`, never for a hex code
 * and never for `palette.gsBeige`, so a colour can be changed in one place and
 * a second theme is a second mapping rather than a second app.
 */
export interface ThemeGradientPoint {
  x: number
  y: number
}

export interface Theme {
  /** Scales a size against the device, so 1 rem is one comfortable line. */
  rem: (size: number) => number
  isDark: boolean

  defaultBorderColor: string

  // Backgrounds
  backgroundColor: string
  cardBackgroundColor: string
  cardBackgroundDark: string
  containerBackgroundColor: string
  inactiveBackgroundColor: string
  overlayBackgroundColor: string

  // Text
  primaryTextFont: string
  primaryTextFontSizeRem: number
  primaryTextColor: string
  secondaryTextColor: string
  tertiaryTextColor: string
  placeholderTextColor: string
  secondaryTextFont: string
  regularTextFont: string
  boldTextFont: string
  semiBoldTextFont: string

  // Buttons
  primaryButtonColor: string
  primaryButtonPressedColor: string
  secondaryButtonColor: string
  secondaryButtonPressedColor: string
  secondaryButtonTextColor: string
  buttonGrayColor: string
  clearButtonColor: string
  /** The disc behind the × that empties a field, and the × itself. */
  clearIconBackgroundColor: string
  clearIconColor: string
  buttonTextColor: string

  // Inputs
  inputBackgroundColor: string
  inputBorderColor: string
  inputFocusBorderColor: string
  inputTextColor: string

  // Scoring instruction and decision surfaces
  scoringInstructionBackground: string
  scoringInstructionBorder: string
  scoringInstructionText: string
  scoringCountdownColor: string
  scoringMenuActiveBackground: string
  scoringMenuActiveText: string
  scoringSafeColor: string
  scoringSafeIdleColor: string
  scoringOutColor: string
  scoringOutIdleColor: string
  scoringDecisionText: string

  // Status
  activeColor: string
  successColor: string
  warningColor: string
  dangerColor: string
  liveColor: string
  scheduledColor: string

  /**
   * Badges. A result badge is read at a glance down a list of games, so a win
   * and a loss differ in hue and not only in wording.
   */
  winBadgeBackground: string
  winBadgeTextColor: string
  lossBadgeBackground: string
  lossBadgeTextColor: string
  honourBadgeBackground: string
  honourBadgeTextColor: string
  neutralBadgeBackground: string
  neutralBadgeTextColor: string

  /** The pill tab strip, which repeats on nearly every screen. */
  pillBackground: string
  pillPressedBackground: string
  pillTextColor: string
  pillActiveBackground: string
  pillActiveTextColor: string

  // The header, and the navigation that becomes a sidebar on a wide screen.
  headerBackgroundColor: string
  headerBorderColor: string
  headerTextColor: string
  navBackgroundColor: string
  /**
   * The glass: a translucent fill with the content blurred behind it.
   *
   * Three tokens rather than a colour, because the fallback where a browser
   * cannot blur has to be a different, opaque colour — a tint that reads well
   * over a blur is unreadable over a photograph.
   */
  /** The mark's two fills: the ring and blade, and the body of the G. */
  markArcColor: string
  markBodyColor: string
  glassBackgroundColor: string
  glassFallbackColor: string
  glassBorderColor: string
  glassBlur: string
  navActiveColor: string
  navInactiveColor: string

  /** The dark scoreboard panel a game's score is set on. */
  scoreboardBackground: string
  scoreboardTextColor: string
  scoreboardMutedTextColor: string
  scoreboardAccentColor: string

  // The watch path's own names
  highlightRowBackground: string
  highlightRowActiveBackground: string
  scoringPlayColor: string
  videoBackgroundColor: string
  gridGutterRem: number

  shadowColor: string
  /**
   * The lift under a button or a pill. Stronger than `shadowColor`, which is
   * for large surfaces: the same 10% that reads on a card the width of the
   * screen is invisible under something three centimetres wide.
   */
  buttonShadowColor: string
  backgroundGradientColors: string[]
  backgroundGradientStart: ThemeGradientPoint
  backgroundGradientEnd: ThemeGradientPoint

  // Shape and rhythm. Kept here for the same reason as the colours: a corner
  // radius repeated as a number in twelve screens is twelve places to miss.
  radiusSmallRem: number
  radiusRem: number
  radiusLargeRem: number
  /** Fully round, for tabs and status badges. Not a rem — it is a sentinel. */
  radiusPill: number

  spaceXsRem: number
  spaceSmRem: number
  spaceMdRem: number
  spaceLgRem: number
  spaceXlRem: number

  /**
   * How wide the content may grow. The designs are all drawn at phone width;
   * on a desktop a line of text that runs the full window is unreadable, so
   * the container stops here and centres.
   */
  maxContentWidthRem: number
}
