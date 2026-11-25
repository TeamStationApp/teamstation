import React from 'react'
import { Text, View } from 'react-native'

import { Button } from '../components'
import { cacheStyles, type Theme, useTheme } from '../theme/ThemeContext'
import type { SponsorStore } from './sponsorStore'

/**
 * The quiet card at the foot of each sponsor screen: the data is a demo's,
 * and it can go back to the sample rows or to none at all.
 */
export function DemoDataBar({
  store,
  onReset
}: {
  store: Pick<SponsorStore, 'reset'>
  /** After either reset, so a screen can drop what it had pending. */
  onReset?: () => void
}): React.ReactElement {
  const theme = useTheme()
  const styles = getStyles(theme)
  const reset = (seed: 'sample' | 'empty'): void => {
    store
      .reset(seed)
      .then(() => onReset?.())
      .catch(() => undefined)
  }
  return (
    <View style={styles.bar} testID="sponsor-demo-data">
      <Text style={styles.text}>Demo data — nothing here is saved.</Text>
      <View style={styles.actions}>
        <Button
          kind="text"
          compact
          label="Reset to sample rows"
          onPress={() => {
            reset('sample')
          }}
        />
        <Button
          kind="text"
          compact
          label="Clear all rows"
          onPress={() => {
            reset('empty')
          }}
        />
      </View>
    </View>
  )
}

const getStyles = cacheStyles((theme: Theme) => ({
  bar: {
    gap: theme.rem(0.25),
    padding: theme.rem(0.75),
    borderRadius: theme.rem(0.75),
    backgroundColor: theme.containerBackgroundColor
  },
  text: {
    color: theme.secondaryTextColor,
    fontFamily: theme.regularTextFont,
    fontSize: theme.rem(0.875)
  },
  actions: { flexDirection: 'row', flexWrap: 'wrap', gap: theme.rem(0.5) }
}))
