import { type Theme, useTheme } from '../theme/ThemeContext'

const sheetThemes = new WeakMap<Theme, Theme>()

/** Derive a sheet theme once per global theme, also for parent-owned styles. */
export function scoringSheetTheme(theme: Theme): Theme {
  if (theme.scoringSheet === true) return theme
  const cached = sheetThemes.get(theme)
  if (cached != null) return cached
  const surface = theme.scoringSurface
  const derived: Theme = {
    ...theme,
    isDark: true,
    scoringSheet: true,
    backgroundColor: surface.canvas,
    cardBackgroundColor: surface.idle,
    containerBackgroundColor: surface.canvas,
    inactiveBackgroundColor: surface.idle,
    primaryTextColor: surface.text,
    secondaryTextColor: surface.secondaryText,
    tertiaryTextColor: surface.mutedText,
    placeholderTextColor: surface.secondaryText,
    inputBackgroundColor: surface.input,
    inputBorderColor: surface.inputBorder,
    inputFocusBorderColor: surface.accent,
    inputTextColor: surface.text,
    defaultBorderColor: surface.border,
    primaryButtonColor: surface.active,
    primaryButtonPressedColor: surface.activeEnd,
    buttonTextColor: surface.activeText,
    secondaryButtonColor: surface.idle,
    secondaryButtonPressedColor: surface.active,
    secondaryButtonTextColor: surface.text,
    scoringSelectorIdle: surface.idle,
    scoringMenuActiveBackground: surface.active,
    scoringMenuActiveText: surface.activeText,
    pillBackground: surface.badges.green.background,
    pillTextColor: surface.badges.green.text,
    pillActiveBackground: surface.active,
    pillActiveTextColor: surface.activeText,
    successColor: surface.accent,
    activeColor: surface.accent,
    dangerColor: surface.danger
  }
  sheetThemes.set(theme, derived)
  return derived
}

export function useScoringSheetTheme(): Theme {
  return scoringSheetTheme(useTheme())
}
