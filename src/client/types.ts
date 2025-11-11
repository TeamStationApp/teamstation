export type ImageProp = { uri: string } | number

export interface GradientCoords {
  x: number
  y: number
}

export interface ThemeGradientParams {
  colors: string[]
  start: GradientCoords
  end: GradientCoords
}

export interface ThemeShadowParams {
  shadowColor: string
  shadowOffset: { width: number; height: number }
  shadowOpacity: number
  shadowRadius: number
}

export interface TextShadowParams {
  shadowColor: string
  shadowOffset: { width: number; height: number }
  shadowOpacity: number
  shadowRadius: number
}

export interface Theme {
  // The app scaling factor, which is the height of "normal" text:
  rem: (size: number) => number

  // Used to control the OS status bar, modal blur,
  // and other binary light / dark choices:
  isDark: boolean

  // Common border
  defaultBorderColor: string

  // Backgrounds
  backgroundColor: string
  cardBackgroundColor: string
  cardBackgroundDark: string
  containerBackgroundColor: string
  inactiveBackgroundColor: string
  overlayBackgroundColor: string

  // Primary text
  primaryTextFont: string
  primaryTextFontSizeRem: number
  primaryTextColor: string
  secondaryTextColor: string
  tertiaryTextColor: string
  placeholderTextColor: string

  // Secondary fonts
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

  // Status colors
  activeColor: string
  successColor: string
  warningColor: string
  dangerColor: string

  // Dashboard specific
  dashboardOverrideBackground: string
  dashboardCircleGreen: string
  dashboardCircleOrange: string
  dashboardCircleRed: string
  dashboardInactiveColor: string
  dashboardBaseFill: string
  dashboardOutlineGray: string
  dashboardSuperscript: string
  dashboardDarkBaseRed: string

  // Scoreboard specific
  scoreboardBackground: string
  scoreboardBorderColor: string
  scoreboardSeparatorColor: string
  scoreboardBaseFill: string
  scoreboardOutlineGray: string
  scoreboardTeamAwayGradient: string[]
  scoreboardTeamHomeGradient: string[]
  scoreboardScoreBackground: string
  scoreboardScoreText: string

  // Shadows
  shadowColor: string

  // Gradients (kept for compatibility)
  backgroundGradientColors: string[]
  backgroundGradientStart: { x: number; y: number }
  backgroundGradientEnd: { x: number; y: number }
}

export const themeNoShadow: ThemeShadowParams = {
  shadowColor: '#000000',
  shadowOffset: {
    width: 0,
    height: 0
  },
  shadowOpacity: 0,
  shadowRadius: 0
}

export const textNoShadow: TextShadowParams = {
  shadowColor: '#000000',
  shadowOffset: {
    width: 0,
    height: 0
  },
  shadowOpacity: 0,
  shadowRadius: 0
}
