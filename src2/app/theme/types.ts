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
  secondaryButtonColor: string
  buttonGrayColor: string
  clearButtonColor: string
  buttonTextColor: string

  // Inputs
  inputBackgroundColor: string
  inputBorderColor: string
  inputTextColor: string

  // Status
  activeColor: string
  successColor: string
  warningColor: string
  dangerColor: string

  // The watch path's own names
  highlightRowBackground: string
  highlightRowActiveBackground: string
  scoringPlayColor: string
  videoBackgroundColor: string
  gridGutterRem: number

  shadowColor: string
  backgroundGradientColors: string[]
  backgroundGradientStart: ThemeGradientPoint
  backgroundGradientEnd: ThemeGradientPoint
}
