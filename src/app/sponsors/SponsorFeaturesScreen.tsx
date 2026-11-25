import React from 'react'
import { Text, View } from 'react-native'

import type { TeamStationClient } from '../../common/api'
import { ListCard, ListRow, Screen } from '../components'
import { cacheStyles, type Theme, useTheme } from '../theme/ThemeContext'
import { useLeagueAdmin } from './useLeagueAdmin'

export type SponsorScreenName =
  'sponsorReels' | 'sponsorLogos' | 'sponsorEventStream'

const ROWS: Array<{ name: SponsorScreenName; title: string; text: string }> = [
  {
    name: 'sponsorReels',
    title: 'Sponsor video reels',
    text: '10–15-second sponsor reels that play alongside game videos, before games and between innings.'
  },
  {
    name: 'sponsorLogos',
    title: 'Sponsor video logos',
    text: 'Place a league sponsor logo in the upper right of game videos.'
  },
  {
    name: 'sponsorEventStream',
    title: 'Sponsor in event stream',
    text: "Add sponsored rows to your league's Schedule. Each sponsored row has the sponsor's logo, a background image and a message, and opens the sponsor's website when tapped. You choose the date and time of each row."
  }
]

/** Sponsor Features: the menu of the three sponsor screens. */
export function SponsorFeaturesScreen({
  client,
  league,
  onOpen
}: {
  client: Pick<TeamStationClient, 'group'>
  league: string
  onOpen: (name: SponsorScreenName) => void
}): React.ReactElement {
  const theme = useTheme()
  const styles = getStyles(theme)
  const admin = useLeagueAdmin(client, league)
  return (
    <Screen>
      <View style={styles.page}>
        <Text accessibilityRole="header" style={styles.title}>
          Sponsor Features
        </Text>
        {admin === 'loading' ? (
          <Text style={styles.hint}>Loading…</Text>
        ) : admin !== 'admin' ? (
          <Text style={styles.hint}>
            Only a league administrator can set up sponsor features.
          </Text>
        ) : (
          <ListCard>
            {ROWS.map(row => (
              <ListRow
                key={row.name}
                testID={`sponsor-menu-${row.name}`}
                title={row.title}
                subtitle={row.text}
                subtitleNumberOfLines={0}
                onPress={() => {
                  onOpen(row.name)
                }}
              />
            ))}
          </ListCard>
        )}
      </View>
    </Screen>
  )
}

const getStyles = cacheStyles((theme: Theme) => ({
  page: { gap: theme.rem(1), paddingVertical: theme.rem(1) },
  title: {
    color: theme.primaryTextColor,
    fontFamily: theme.boldTextFont,
    fontSize: theme.rem(1.5)
  },
  hint: {
    color: theme.secondaryTextColor,
    fontFamily: theme.regularTextFont,
    fontSize: theme.rem(0.875)
  }
}))
