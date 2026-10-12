import React from 'react'
import { Text, View } from 'react-native'

import { localityLabel } from '../../common/locality'
import type { GroupDetail } from '../../common/publicGroups'
import { Card, SectionHeader } from '../components'
import { cacheStyles, type Theme, useTheme } from '../theme/ThemeContext'

/**
 * A team for somebody not signed in: the already-public projection alone, and
 * no private collection loaded. Anybody signed in, member or not, gets the
 * team's own page instead, in the non-member view when not a member.
 */
export function PublicTeamContent({
  detail,
  tab
}: {
  detail: GroupDetail
  tab: 'videos' | 'schedule' | 'team' | 'stats'
}): React.ReactElement {
  const styles = getStyles(useTheme())
  if (tab === 'videos' || tab === 'stats')
    return (
      <Text style={styles.hint}>
        Team membership is required to view{' '}
        {tab === 'videos' ? 'videos' : 'statistics'}.
      </Text>
    )
  if (tab === 'schedule')
    return (
      <View style={styles.section}>
        <SectionHeader title="Schedule and results" />
        {detail.games.length === 0 && (
          <Text style={styles.hint}>No games scheduled.</Text>
        )}
        {detail.games.map(game => (
          <Card key={game.id} style={styles.card}>
            <Text style={styles.name}>
              {game.awayTeam.name} at {game.homeTeam.name}
            </Text>
            <Text style={styles.hint}>
              {new Date(game.startAt).toLocaleString()}
              {game.venue == null ? '' : ` · ${game.venue}`}
            </Text>
            <Text style={styles.hint}>
              {game.pendingApproval
                ? 'Pending approval'
                : game.status === 'cancelled'
                  ? game.cancellationReason === 'withdrawal'
                    ? `Canceled — ${game.withdrawnByTeamName ?? 'A team'} withdrew`
                    : 'Canceled'
                  : game.status}
              {!game.pendingApproval &&
              game.status !== 'cancelled' &&
              game.homeScore != null &&
              game.awayScore != null
                ? ` · ${game.awayScore}–${game.homeScore}`
                : ''}
            </Text>
          </Card>
        ))}
      </View>
    )
  return (
    <View style={styles.section}>
      <SectionHeader title="Team information" />
      <Text style={styles.hint}>
        {detail.group.locality == null
          ? 'Location not set'
          : localityLabel(detail.group.locality)}
      </Text>
      {detail.group.external && (
        <Text style={styles.hint}>Placeholder team</Text>
      )}
      {detail.parents.length === 0 && !detail.group.external && (
        <Text style={styles.hint}>Standalone team</Text>
      )}
      {detail.parents.map(parent => (
        <Text key={`${parent.kind}:${parent.id}`} style={styles.hint}>
          Parent {parent.kind}: {parent.name}
        </Text>
      ))}
      {detail.custodian != null && (
        <Text style={styles.hint}>Managed by {detail.custodian.name}</Text>
      )}
      {detail.participatingSeasons.map(season => (
        <Text key={season.id} style={styles.hint}>
          Participating season: {season.name}
        </Text>
      ))}
      <SectionHeader title="Staff and coaches" />
      {detail.staff.length === 0 && (
        <Text style={styles.hint}>No public staff listed.</Text>
      )}
      {detail.staff.map((staff, index) => (
        <View key={index}>
          <Text style={styles.name}>{staff.name}</Text>
          <Text style={styles.hint}>{staff.roles.join(', ')}</Text>
        </View>
      ))}
    </View>
  )
}
const getStyles = cacheStyles((theme: Theme) => ({
  section: { gap: theme.rem(0.75) },
  card: { gap: theme.rem(0.5) },
  name: {
    color: theme.primaryTextColor,
    fontFamily: theme.semiBoldTextFont,
    fontSize: theme.rem(1)
  },
  hint: {
    color: theme.secondaryTextColor,
    fontFamily: theme.regularTextFont,
    fontSize: theme.rem(0.875)
  }
}))
