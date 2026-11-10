import { cacheStyles, type Theme } from '../../theme/ThemeContext'

/** How faint a row is while it cannot be changed. */
export const GATED_OPACITY = 0.4

/**
 * The least width, in rem, a row's name keeps beside its control: 120
 * points, whole words in two lines for the settings' names. Narrower, the
 * control takes its own line under the name.
 */
export const SETTING_NAME_MIN_REM = 7.5

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
  // A row whose control moves under its name when the name would keep less
  // than `SETTING_NAME_MIN_REM`, still at the right, rather than break the
  // name's words.
  wrapping: { flexWrap: 'wrap' as const, justifyContent: 'flex-end' as const },
  // The plain text column's `flex: 1` would leave the name no width of its
  // own to keep.
  wrappingText: {
    gap: theme.rem(0.125),
    flexGrow: 1,
    flexShrink: 1,
    flexBasis: theme.rem(SETTING_NAME_MIN_REM)
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
