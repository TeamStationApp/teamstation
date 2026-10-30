import React, { memo, useCallback } from 'react'
import { ActivityIndicator, Text, View } from 'react-native'

import type { GamesPageQuery, TeamStationClient } from '../../common/api'
import { localityLabel } from '../../common/locality'
import type { GroupDetail, PublicGame } from '../../common/publicGroups'
import { ROLE_FLAGS } from '../../common/roles'
import {
  Button,
  Card,
  GameRow,
  ListCard,
  ScheduleRow,
  SectionHeader
} from '../components'
import { PagedList } from '../components/PagedList'
import { PagedListEnd } from '../components/PagedListEnd'
import { PersonRow } from '../components/PeopleList'
import { useForegroundRefresh } from '../hooks/useForegroundRefresh'
import { type PagedRows, usePagedList } from '../hooks/usePagedList'
import { lstrings, videoCountLabel } from '../locales/strings'
import { cacheStyles, type Theme, useTheme } from '../theme/ThemeContext'
import { shortDate, shortTime } from './format'
import { type GameListOpenOptions, gameListOptions } from './gameListOptions'

type OpenGame = (
  id: string,
  title: string,
  options?: GameListOpenOptions
) => void

/** A row's height before it has been measured, as each list draws them. */
const ROW_HEIGHT = { schedule: 150, videos: 110 }

/** The order `publicGames` lists a team's games in. */
const SCHEDULE_QUERY: GamesPageQuery = { order: 'asc' }
const VIDEOS_QUERY: GamesPageQuery = { order: 'asc', hasVideo: true }

const gameId = (game: PublicGame): string => game.id
const matchup = (game: PublicGame): string =>
  `${game.awayTeam.name} at ${game.homeTeam.name}`

/**
 * A team for somebody not signed in: the already-public projection alone, and
 * no private collection loaded. Anybody signed in, member or not, gets the
 * team's own page instead, in the non-member view when not a member.
 */
export function PublicTeamContent({
  client,
  detail,
  tab,
  membershipAccess,
  onOpenGame
}: {
  client: TeamStationClient
  detail: GroupDetail
  membershipAccess?: React.ReactNode
  tab: 'videos' | 'schedule' | 'team' | 'stats'
  onOpenGame?: OpenGame
}): React.ReactElement {
  const styles = getStyles(useTheme())
  if (tab === 'stats')
    return (
      <>
        {membershipAccess ?? (
          <Text style={styles.hint}>
            Team membership is required to view statistics.
          </Text>
        )}
      </>
    )
  if (tab === 'videos')
    return (
      <PublicVideos
        client={client}
        teamId={detail.group.id}
        onOpenGame={onOpenGame}
      />
    )
  if (tab === 'schedule')
    return (
      <PublicSchedule
        client={client}
        teamId={detail.group.id}
        onOpenGame={onOpenGame}
      />
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

/** A list of the team's public games, read while it is on show. */
function usePublicGames(
  client: TeamStationClient,
  teamId: string,
  query: GamesPageQuery
): PagedRows<PublicGame> {
  const list = usePagedList<PublicGame>({
    listKey: `${teamId}:${query.hasVideo === true ? 'videos' : 'schedule'}`,
    auto: false,
    keyOf: gameId,
    read: async cursor =>
      await client.publicGamesPage(
        'team',
        teamId,
        cursor == null ? query : { ...query, cursor }
      )
  })
  useForegroundRefresh(list.refresh)
  return list
}

/** Where a list's rows would be: a spinner, why not, or that there are none. */
function NoRows(props: {
  list: PagedRows<PublicGame>
  none: string
}): React.ReactElement | null {
  const { loading, empty, error, refresh } = props.list
  const styles = getStyles(useTheme())
  if (loading) return <ActivityIndicator accessibilityLabel="Loading games" />
  if (error != null)
    return (
      <>
        <Text accessibilityRole="alert" style={styles.error}>
          {error instanceof Error ? error.message : 'Cannot load games'}
        </Text>
        <Button
          label={lstrings.paged_list_retry}
          kind="secondary"
          onPress={() => {
            refresh().catch(() => undefined)
          }}
        />
      </>
    )
  return empty ? <Text style={styles.hint}>{props.none}</Text> : null
}

/** Every game of the team's with a video, a list of its own. */
function PublicVideos(props: {
  client: TeamStationClient
  teamId: string
  onOpenGame?: OpenGame
}): React.ReactElement {
  const { client, teamId, onOpenGame } = props
  const list = usePublicGames(client, teamId, VIDEOS_QUERY)
  const { rows, counts, loadMore } = list
  const styles = getStyles(useTheme())
  const renderRow = useCallback(
    (game: PublicGame) => (
      <View style={styles.row} testID={`public-game-${game.id}`}>
        <PublicVideoRow game={game} onOpenGame={onOpenGame} />
      </View>
    ),
    [onOpenGame, styles.row]
  )
  return (
    <View style={styles.section}>
      <SectionHeader
        title="Game video library"
        note={counts == null ? undefined : `${counts.withVideo} with video`}
      />
      <PagedList
        data={rows}
        keyOf={gameId}
        renderItem={renderRow}
        estimatedItemSize={ROW_HEIGHT.videos}
        empty={<NoRows list={list} none="No game has a video attached yet." />}
        footer={<PagedListEnd list={list} />}
        onEndReached={() => {
          loadMore().catch(() => undefined)
        }}
      />
    </View>
  )
}

/** The team's games in the order they are played. */
function PublicSchedule(props: {
  client: TeamStationClient
  teamId: string
  onOpenGame?: OpenGame
}): React.ReactElement {
  const { client, teamId, onOpenGame } = props
  const list = usePublicGames(client, teamId, SCHEDULE_QUERY)
  const { rows, loadMore } = list
  const styles = getStyles(useTheme())
  const renderRow = useCallback(
    (game: PublicGame) => (
      <View style={styles.row} testID={`public-game-${game.id}`}>
        <PublicScheduleRow game={game} onOpenGame={onOpenGame} />
      </View>
    ),
    [onOpenGame, styles.row]
  )
  return (
    <View style={styles.section}>
      <SectionHeader title="Schedule and results" />
      <PagedList
        data={rows}
        keyOf={gameId}
        renderItem={renderRow}
        estimatedItemSize={ROW_HEIGHT.schedule}
        empty={<NoRows list={list} none="No games scheduled." />}
        footer={<PagedListEnd list={list} />}
        onEndReached={() => {
          loadMore().catch(() => undefined)
        }}
      />
    </View>
  )
}

const PublicVideoRow = memo(function PublicVideoRow(props: {
  game: PublicGame
  onOpenGame?: OpenGame
}): React.ReactElement {
  const { game, onOpenGame } = props
  return (
    <Card>
      <GameRow
        first={game.awayTeam.name}
        second={`at ${game.homeTeam.name}`}
        detail={[
          shortDate(game.startAt),
          shortTime(game.startAt),
          videoCountLabel(game.videoCount ?? 0)
        ].join(' · ')}
        onPress={() =>
          onOpenGame?.(game.id, matchup(game), {
            tab: 'watch',
            autoPlay: false
          })
        }
      />
    </Card>
  )
})

const PublicScheduleRow = memo(function PublicScheduleRow(props: {
  game: PublicGame
  onOpenGame?: OpenGame
}): React.ReactElement {
  const { game, onOpenGame } = props
  const styles = getStyles(useTheme())
  const options = gameListOptions(game, 'schedule', true)
  return (
    <Card style={styles.card}>
      <ScheduleRow
        first={game.awayTeam.name}
        second={`at ${game.homeTeam.name}`}
        startAt={game.startAt}
        isGameLive={game.isGameLive}
        isUmpire={game.isUmpire}
        venue={game.venue}
        status={game.status}
        pendingApproval={game.pendingApproval}
        cancellationReason={game.cancellationReason}
        withdrawnByTeamName={game.withdrawnByTeamName}
        awayScore={game.awayScore}
        homeScore={game.homeScore}
        videoCount={game.videoCount ?? 0}
        onPress={
          options == null || onOpenGame == null
            ? undefined
            : () => {
                onOpenGame(game.id, matchup(game), options)
              }
        }
      />
    </Card>
  )
})

const getStyles = cacheStyles((theme: Theme) => ({
  section: { gap: theme.rem(0.75) },
  card: { gap: theme.rem(0.5) },
  // A list's rows are placed one by one, so its gap is on each of them.
  row: { paddingBottom: theme.rem(0.75) },
  error: {
    color: theme.dangerColor,
    fontFamily: theme.regularTextFont,
    fontSize: theme.rem(0.875)
  },
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
