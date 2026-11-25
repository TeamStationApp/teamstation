import React from 'react'
import { View } from 'react-native'

import { ListCard, ListRow, SectionHeader } from '../components'
import { cacheStyles, type Theme, useTheme } from '../theme/ThemeContext'
import { PremiumPill } from './PremiumPill'

/**
 * League Settings' Sponsor features row, with the Premium pill in its
 * upper-right. The row opens the Sponsor features menu.
 */
export function SponsorFeaturesCard({
  onOpen
}: {
  onOpen: () => void
}): React.ReactElement {
  const theme = useTheme()
  const styles = getStyles(theme)
  return (
    <View style={styles.section}>
      <SectionHeader title="Sponsors" />
      <View style={styles.wrap}>
        <ListCard>
          <ListRow
            testID="sponsor-features-row"
            title="Sponsor features"
            subtitle="Video logos, video reels and sponsored Schedule rows"
            subtitleNumberOfLines={0}
            emblemIcon="star"
            onPress={onOpen}
          />
        </ListCard>
        <View style={styles.pill}>
          <PremiumPill />
        </View>
      </View>
    </View>
  )
}

const getStyles = cacheStyles((theme: Theme) => ({
  section: { gap: theme.rem(0.75) },
  wrap: { position: 'relative' },
  // In the row's upper-right corner, as far from the top as from the
  // right, and clear above the chevron.
  pill: {
    position: 'absolute',
    top: theme.rem(0.375),
    right: theme.rem(0.375)
  }
}))
