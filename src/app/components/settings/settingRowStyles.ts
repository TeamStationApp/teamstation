import { cacheStyles, type Theme } from '../../theme/ThemeContext'

/** How faint a row is while it cannot be changed. */
export const GATED_OPACITY = 0.4

/**
 * What the settings rows share: at least 48 points high, the card's inset,
 * and a title over an optional quieter line.
 */
export const settingRowStyles = cacheStyles((theme: Theme) => ({
  row: {
    flexDirection: 'row' as const,
    alignItems: 'center' as const,
    gap: theme.rem(theme.spaceMdRem),
    minHeight: theme.rem(3),
    paddingHorizontal: theme.rem(theme.cardContentInsetRem),
    paddingVertical: theme.rem(0.5)
  },
  stacked: {
    gap: theme.rem(0.5),
    minHeight: theme.rem(3),
    paddingHorizontal: theme.rem(theme.cardContentInsetRem),
    paddingVertical: theme.rem(0.75)
  },
  gated: { opacity: GATED_OPACITY },
  text: { flex: 1, gap: theme.rem(0.125) },
  title: {
    fontFamily: theme.semiBoldTextFont,
    fontSize: theme.rem(1),
    fontWeight: '600' as const,
    color: theme.primaryTextColor
  },
  subtitle: {
    fontFamily: theme.regularTextFont,
    fontSize: theme.rem(0.875),
    color: theme.secondaryTextColor
  }
}))
