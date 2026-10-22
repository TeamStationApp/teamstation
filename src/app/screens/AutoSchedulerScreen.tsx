import React from 'react'
import { Text, View } from 'react-native'

import { ListCard, ListRow, Screen } from '../components'
import { cacheStyles, type Theme, useTheme } from '../theme/ThemeContext'

/**
 * A league's Auto-Scheduler: where its admins set up the venues and fields
 * the league plays on, and build its seasons' schedules.
 */
export function AutoSchedulerScreen({
  leagueName,
  onFieldManager
}: {
  leagueName?: string
  onFieldManager: () => void
}): React.ReactElement {
  const styles = getStyles(useTheme())
  return (
    <Screen>
      <View style={styles.page}>
        <Text accessibilityRole="header" style={styles.title}>
          Auto-Scheduler
        </Text>
        {leagueName != null && <Text style={styles.meta}>{leagueName}</Text>}
        <ListCard>
          <ListRow
            title="Field Manager"
            subtitle="Find, claim and set up the venues and fields your league plays on"
            emblemIcon="stadium"
            onPress={onFieldManager}
          />
        </ListCard>
      </View>
    </Screen>
  )
}

export const getStyles = cacheStyles((theme: Theme) => ({
  page: { gap: theme.rem(1), paddingBottom: theme.rem(6) },
  title: {
    fontFamily: theme.primaryTextFont,
    fontSize: theme.rem(1.75),
    color: theme.primaryTextColor
  },
  meta: {
    fontFamily: theme.regularTextFont,
    fontSize: theme.rem(0.9375),
    color: theme.secondaryTextColor
  }
}))
