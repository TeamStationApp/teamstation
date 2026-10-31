import React from 'react'

import { Button } from '../components/Button'
import { pillPadding } from '../theme/pill'
import { cacheStyles, type Theme, useTheme } from '../theme/ThemeContext'

export interface StreamPillProps {
  label: string
  onPress: () => void
  disabled?: boolean
  busy?: boolean
  testID?: string
}

/**
 * The blue pill of the Videos tab's camera setup: Record Video, Request access
 * and Done. A little taller than the 36 points of the tab pills above it, with
 * the finger's full 48.
 */
export function StreamPill(props: StreamPillProps): React.ReactElement {
  const theme = useTheme()
  const styles = getStyles(theme)
  return (
    <Button
      {...props}
      color={theme.streamActionColor}
      textColor={theme.streamActionTextColor}
      style={styles.pill}
      hitSlop={(theme.rem(3) - theme.rem(PILL_HEIGHT_REM)) / 2}
    />
  )
}

const PILL_HEIGHT_REM = 2.75

const getStyles = cacheStyles((theme: Theme) => ({
  pill: {
    alignSelf: 'center',
    minHeight: theme.rem(PILL_HEIGHT_REM),
    height: theme.rem(PILL_HEIGHT_REM),
    borderRadius: theme.rem(PILL_HEIGHT_REM) / 2,
    paddingHorizontal: pillPadding(theme.rem(PILL_HEIGHT_REM))
  }
}))
