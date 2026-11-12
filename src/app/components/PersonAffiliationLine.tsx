import React from 'react'

import { UndoTicker } from '../scoring/UndoTicker'
import { cacheStyles, type Theme, useTheme } from '../theme/ThemeContext'

/**
 * The quieter line under a person's name in a list: `Guardian of …`,
 * `Guardians: …` and their teams, joined by ` · `, as the server answers it
 * for the reader (`affiliations`). It pans when it overflows its row, and
 * draws nothing for an empty line.
 */
export function PersonAffiliationLine({
  affiliations,
  color,
  testID
}: {
  affiliations: string | undefined
  /** In place of the theme's secondary colour, on a surface of its own. */
  color?: string
  testID?: string
}): React.ReactElement | null {
  const styles = getStyles(useTheme())
  if (affiliations == null || affiliations === '') return null
  return (
    <UndoTicker
      text={affiliations}
      style={color == null ? styles.line : [styles.line, { color }]}
      enabled
      testID={testID}
    />
  )
}

const getStyles = cacheStyles((theme: Theme) => ({
  line: {
    fontFamily: theme.regularTextFont,
    fontSize: theme.rem(0.875),
    color: theme.secondaryTextColor
  }
}))
