import React from 'react'
import { Text, View } from 'react-native'

import { localityLabel } from '../../common/locality'
import type { GroupDetail } from '../../common/publicGroups'
import { ROLE_FLAGS } from '../../common/roles'
import {
  Card,
  GameRow,
  ListCard,
  ScheduleRow,
  SectionHeader
} from '../components'
import { PersonRow } from '../components/PeopleList'
import { videoCountLabel } from '../locales/strings'
import { cacheStyles, type Theme, useTheme } from '../theme/ThemeContext'
import { shortDate, shortTime } from './format'
import { type GameListOpenOptions, gameListOptions } from './gameListOptions'

/**
 * A team for somebody not signed in: the already-public projection alone, and
 * no private collection loaded. Anybody signed in, member or not, gets the
 * team's own page instead, in the non-member view when not a member.
 */
export function PublicTeamContent({
  detail,
  tab,
  onOpenGame
}: {
  detail: GroupDetail
  tab: 'videos' | 'schedule' | 'team' | 'stats'
  onOpenGame?: (
    id: string,
    title: string,
    options?: GameListOpenOptions
  ) => void
}): React.ReactElement {
  const styles = getStyles(useTheme())
  if (tab === 'stats')
    return (
      <Text style={styles.hint}>
        Team membership is required to view statistics.
      </Text>
    )
  if (tab === 'videos') {
    const videos = detail.games.filter(game => (game.videoCount ?? 0) > 0)
    return (
      <View style={styles.section}>
        <SectionHeader
          title="Game video library"
          note={`${videos.length} with video`}
        />
        {videos.length === 0 && (
          <Text style={styles.hint}>No game has a video attached yet.</Text>
        )}
        {videos.map(game => (
          <Card key={game.id}>
            <GameRow
              first={game.awayTeam.name}
              second={`at ${game.homeTeam.name}`}
              detail={[
                shortDate(game.startAt),
                shortTime(game.startAt),
                videoCountLabel(game.videoCount ?? 0)
              ].join(' · ')}
              onPress={() =>
                onOpenGame?.(
                  game.id,
                  `${game.awayTeam.name} at ${game.homeTeam.name}`,
                  { tab: 'watch', autoPlay: false }
                )
              }
            />
          </Card>
        ))}
      </View>
    )
  }
  if (tab === 'schedule')
    return (
      <View style={styles.section}>
        <SectionHeader title="Schedule and results" />
        {detail.games.length === 0 && (
          <Text style={styles.hint}>No games scheduled.</Text>
        )}
        {detail.games.map(game => (
          <Card key={game.id} style={styles.card}>
            <ScheduleRow
              first={game.awayTeam.name}
              second={`at ${game.homeTeam.name}`}
              startAt={game.startAt}
              venue={game.venue}
              status={game.status}
              pendingApproval={game.pendingApproval}
              cancellationReason={game.cancellationReason}
              withdrawnByTeamName={game.withdrawnByTeamName}
              awayScore={game.awayScore}
              homeScore={game.homeScore}
              videoCount={game.videoCount ?? 0}
              onPress={
                gameListOptions(game, 'schedule', true) == null ||
                onOpenGame == null
                  ? undefined
                  : () => {
                      onOpenGame(
                        game.id,
                        `${game.awayTeam.name} at ${game.homeTeam.name}`,
                        gameListOptions(game, 'schedule', true)
                      )
                    }
              }
            />
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
      {(['admin', 'staff'] as const).map(section => {
        const people = detail.staff.filter(
          person => person.roles.includes('admin') === (section === 'admin')
        )
        if (people.length === 0) return null
        return (
          <View key={section} style={styles.section} testID="public-staff">
            <SectionHeader
              title={section === 'admin' ? 'Admins' : 'Staff'}
              note={String(people.length)}
            />
            <ListCard>
              {people.map((person, index) => (
                <PersonRow
                  key={index}
                  person={{
                    shortName: person.name,
                    section,
                    staffRoles: ROLE_FLAGS.filter(role =>
                      person.roles.includes(role)
                    ),
                    avatarUrl: person.avatarUrl,
                    inheritedFrom: person.inheritedFrom ?? null,
                    jersey: null,
                    positions: []
                  }}
                />
              ))}
            </ListCard>
          </View>
        )
      })}
      {detail.staff.length === 0 && (
        <Text style={styles.hint}>No public staff listed.</Text>
      )}
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
