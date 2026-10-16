import React from 'react'
import { Text, View } from 'react-native'

import type { TeamStationClient } from '../../common/api'
import type { PublicGroup } from '../../common/publicGroups'
import { SectionHeader } from '../components'
import { cacheStyles, type Theme, useTheme } from '../theme/ThemeContext'
import { participationExplanation } from './participationExplanation'
import { ParticipationList } from './ParticipationList'

export { participationExplanation } from './participationExplanation'

/** Competition membership is independent of the team's management parents. */
export function SeasonParticipations({
  client,
  teamId,
  seasons,
  disabled = false,
  onLeft
}: {
  client: TeamStationClient
  teamId: string
  seasons: PublicGroup[]
  disabled?: boolean
  onLeft: () => void
}): React.ReactElement | null {
  const styles = getStyles(useTheme())
  if (seasons.length === 0) return null
  return (
    <View style={styles.section} testID="season-participations">
      <SectionHeader title="Season Participations" />
      <Text style={styles.hint}>{participationExplanation}</Text>
      <ParticipationList
        client={client}
        owner={{ kind: 'team', id: teamId, name: '' }}
        groups={seasons}
        disabled={disabled}
        onLeft={onLeft}
      />
    </View>
  )
}
const getStyles = cacheStyles((theme: Theme) => ({
  section: { gap: theme.rem(0.75) },
  hint: {
    fontSize: theme.rem(0.875),
    lineHeight: theme.rem(1.35),
    color: theme.secondaryTextColor
  }
}))
