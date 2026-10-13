import React from 'react'
import { Text, View } from 'react-native'

import type { PlayerRsvpCounts as Counts } from '../../common/eventInfo'
import { cacheStyles, type Theme, useTheme } from '../theme/ThemeContext'
import { RSVP_COLORS } from './eventRsvpPosition'

export function PlayerRsvpCounts({
  counts,
  diameter
}: {
  counts: Counts
  /** Optional visual diameter to match the schedule's outlined avatars. */
  diameter?: number
}): React.ReactElement {
  const styles = getStyles(useTheme())
  return (
    <View style={styles.row} testID="player-rsvp-counts">
      {(['yes', 'unknown', 'no'] as const).map((kind, index) =>
        counts[kind] === 0 ? null : (
          <View
            key={kind}
            style={[
              styles.pill,
              { backgroundColor: RSVP_COLORS[index] },
              diameter == null
                ? undefined
                : {
                    height: diameter,
                    minWidth: diameter,
                    paddingVertical: 0,
                    justifyContent: 'center'
                  }
            ]}
            testID={`player-rsvp-count-${kind}`}
            accessibilityLabel={`${counts[kind]} players: ${kind === 'unknown' ? 'Maybe or no reply' : kind === 'yes' ? 'Yes' : 'No'}`}
          >
            <Text style={styles.number}>{counts[kind]}</Text>
          </View>
        )
      )}
    </View>
  )
}
const getStyles = cacheStyles((theme: Theme) => ({
  row: { flexDirection: 'row', alignItems: 'center', gap: theme.rem(0.375) },
  pill: {
    borderRadius: theme.radiusPill,
    minWidth: theme.rem(1.75),
    paddingHorizontal: theme.rem(0.5),
    paddingVertical: theme.rem(0.1875),
    alignItems: 'center'
  },
  number: {
    color: '#ffffff',
    fontFamily: theme.semiBoldTextFont,
    fontSize: theme.rem(0.8125)
  }
}))
