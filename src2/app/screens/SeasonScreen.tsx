import React, { useEffect, useState } from 'react'
import { Text, View } from 'react-native'

import type {
  GameStationClient,
  SeasonGame,
  SeasonSummary,
  StandingsRow,
  TeamSummary
} from '../../common/api'
import {
  Badge,
  Card,
  ListRow,
  PillTabs,
  Screen,
  SectionHeader,
  StatGrid
} from '../components'
import { cacheStyles, type Theme, useTheme } from '../theme/ThemeContext'
import { shortDate, shortTime } from './format'

export interface SeasonScreenProps {
  client: GameStationClient
  season: SeasonSummary
  onOpenGame: (
    gameId: string,
    title: string,
    options?: { tab?: 'watch' | 'boxScore'; autoPlay?: boolean }
  ) => void
  onOpenTeam: (team: TeamSummary) => void
}

type TabId = 'schedule' | 'teams' | 'standings'
type When = 'past' | 'upcoming' | 'all'

const TABS = [
  { id: 'schedule' as const, label: 'Schedule' },
  { id: 'teams' as const, label: 'Teams' },
  { id: 'standings' as const, label: 'Standings' }
]

const WHEN_TABS = [
  { id: 'past' as const, label: 'Past games' },
  { id: 'upcoming' as const, label: 'Upcoming' },
  { id: 'all' as const, label: 'All' }
]

/**
 * A season: every game in it, who is in it, and where they stand.
 *
 * Standings is a third tab rather than a panel on the schedule. The design put
 * a league table nowhere at all, but the data has been sitting behind
 * `/seasons/:id/standings` since the ingest landed, and a table of who is
 * winning is the thing a league page is *for*.
 *
 * The schedule's own past/upcoming filter is the same `PillTabs`, one size
 * down. Two strips on one screen could be confusing, so the section header
 * sits between them and the lower one never carries the screen's own sections.
 */
export function SeasonScreen(props: SeasonScreenProps): React.ReactElement {
  const { client, season, onOpenGame, onOpenTeam } = props
  const styles = getStyles(useTheme())

  const [tab, setTab] = useState<TabId>('schedule')
  const [when, setWhen] = useState<When>('past')
  const [games, setGames] = useState<SeasonGame[]>([])
  const [teams, setTeams] = useState<TeamSummary[]>([])
  const [standings, setStandings] = useState<StandingsRow[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | undefined>(undefined)

  useEffect(() => {
    let cancelled = false
    const load = async (): Promise<void> => {
      const [loadedGames, loadedTeams, loadedStandings] = await Promise.all([
        client.seasonGames(season.id),
        client.seasonTeams(season.id),
        client.standings(season.id)
      ])
      if (cancelled) return
      setGames(loadedGames)
      setTeams(loadedTeams)
      setStandings(loadedStandings)
    }
    load()
      .catch((caught: unknown) => {
        if (!cancelled) {
          setError(caught instanceof Error ? caught.message : 'Cannot load')
        }
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [client, season.id])

  const played = games.filter(game => game.awayScore != null)
  const upcoming = games.filter(game => game.awayScore == null)
  const shown =
    when === 'past' ? played : when === 'upcoming' ? upcoming : games

  return (
    <Screen>
      <Card style={styles.identity}>
        <Text style={styles.seasonName}>{season.name}</Text>
        <Text style={styles.seasonMeta}>
          {season.year}
          {season.term == null ? '' : ` · ${season.term}`}
          {season.ageGroup == null ? '' : ` · ${season.ageGroup}`}
        </Text>
        <StatGrid
          columns={3}
          stats={[
            { label: 'Teams', value: String(season.teams) },
            { label: 'Games', value: String(season.games) },
            { label: 'Videos', value: String(season.videos) }
          ]}
        />
      </Card>

      <PillTabs
        tabs={TABS}
        selected={tab}
        onSelect={setTab}
        stretch
        accessibilityLabel="Season sections"
      />

      {error != null && <Text style={styles.error}>{error}</Text>}
      {loading && <Text style={styles.muted}>Loading…</Text>}

      {!loading && tab === 'schedule' && (
        <View style={styles.section}>
          <PillTabs
            tabs={WHEN_TABS}
            selected={when}
            onSelect={setWhen}
            stretch
          />
          <SectionHeader title="Schedule" note={`${shown.length} games`} />
          {shown.length === 0 ? (
            <Card>
              <Text style={styles.muted}>Nothing here yet.</Text>
            </Card>
          ) : (
            shown.map(game => (
              <Card key={game.id}>
                <ListRow
                  title={`${game.awayTeamName} at ${game.homeTeamName}`}
                  subtitle={`${shortDate(game.startAt)}${
                    game.venue == null ? '' : ` · ${game.venue}`
                  }`}
                  emblem="⚾"
                  badgeLabel={
                    game.awayScore == null
                      ? shortTime(game.startAt)
                      : `${game.awayScore}–${game.homeScore}`
                  }
                  badgeTone={game.awayScore == null ? 'neutral' : 'win'}
                  onPress={() => {
                    onOpenGame(
                      game.id,
                      `${game.awayTeamName} at ${game.homeTeamName}`
                    )
                  }}
                />
              </Card>
            ))
          )}
        </View>
      )}

      {!loading && tab === 'teams' && (
        <View style={styles.section}>
          <SectionHeader title="Teams" note={String(teams.length)} />
          <Card>
            {teams.map((team, index) => (
              <View key={team.id}>
                {index > 0 && <View style={styles.divider} />}
                <ListRow
                  title={team.name}
                  subtitle={team.shortName ?? undefined}
                  emblem="⚾"
                  onPress={() => {
                    onOpenTeam(team)
                  }}
                />
              </View>
            ))}
          </Card>
        </View>
      )}

      {!loading && tab === 'standings' && (
        <View style={styles.section}>
          <SectionHeader title="Standings" note={`${standings.length} teams`} />
          {standings.length === 0 ? (
            <Card>
              <Text style={styles.muted}>
                No games have been scored in this season yet.
              </Text>
            </Card>
          ) : (
            <Card flush>
              <View style={[styles.tableRow, styles.tableHead]}>
                <Text style={[styles.cellName, styles.cellHead]}>Team</Text>
                <Text style={[styles.cell, styles.cellHead]}>W</Text>
                <Text style={[styles.cell, styles.cellHead]}>L</Text>
                <Text style={[styles.cell, styles.cellHead]}>RF</Text>
                <Text style={[styles.cell, styles.cellHead]}>RA</Text>
                <Text style={[styles.cell, styles.cellHead]}>DIFF</Text>
              </View>
              {standings.map((row, index) => (
                <View key={row.teamId} style={styles.tableRow}>
                  <View style={styles.rank}>
                    <Text style={styles.rankText}>{index + 1}</Text>
                  </View>
                  <Text style={styles.cellName} numberOfLines={1}>
                    {row.teamName}
                  </Text>
                  <Text style={styles.cell}>{row.w}</Text>
                  <Text style={styles.cell}>{row.l}</Text>
                  <Text style={styles.cell}>{row.runsFor}</Text>
                  <Text style={styles.cell}>{row.runsAgainst}</Text>
                  <Text style={styles.cell}>
                    {row.runDifferential >= 0 ? '+' : ''}
                    {row.runDifferential}
                  </Text>
                </View>
              ))}
            </Card>
          )}
          {standings[0] != null && (
            <Badge label={`${standings[0].teamName} leads`} tone="honour" />
          )}
        </View>
      )}
    </Screen>
  )
}

const getStyles = cacheStyles((theme: Theme) => ({
  section: {
    gap: theme.rem(theme.spaceMdRem)
  },
  identity: {
    gap: theme.rem(theme.spaceMdRem)
  },
  seasonName: {
    fontFamily: theme.boldTextFont,
    fontSize: theme.rem(1.5),
    fontWeight: '700',
    letterSpacing: theme.rem(-0.02),
    color: theme.primaryTextColor
  },
  seasonMeta: {
    fontFamily: theme.regularTextFont,
    fontSize: theme.rem(0.875),
    color: theme.secondaryTextColor
  },
  divider: {
    height: 1,
    backgroundColor: theme.defaultBorderColor
  },
  tableRow: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: theme.rem(theme.spaceMdRem),
    paddingVertical: theme.rem(theme.spaceSmRem),
    gap: theme.rem(theme.spaceXsRem)
  },
  tableHead: {
    backgroundColor: theme.containerBackgroundColor
  },
  rank: {
    width: theme.rem(1.5),
    alignItems: 'center'
  },
  rankText: {
    fontFamily: theme.semiBoldTextFont,
    fontSize: theme.rem(0.75),
    fontWeight: '700',
    color: theme.secondaryTextColor
  },
  cellHead: {
    fontFamily: theme.semiBoldTextFont,
    fontSize: theme.rem(0.6875),
    fontWeight: '700',
    letterSpacing: theme.rem(0.05),
    color: theme.secondaryTextColor
  },
  cellName: {
    flex: 1,
    fontFamily: theme.regularTextFont,
    fontSize: theme.rem(0.875),
    color: theme.primaryTextColor
  },
  cell: {
    width: theme.rem(2.5),
    textAlign: 'right',
    fontFamily: theme.semiBoldTextFont,
    fontSize: theme.rem(0.875),
    fontWeight: '600',
    color: theme.primaryTextColor
  },
  muted: {
    fontFamily: theme.regularTextFont,
    fontSize: theme.rem(0.9375),
    color: theme.secondaryTextColor
  },
  error: {
    fontFamily: theme.regularTextFont,
    fontSize: theme.rem(0.875),
    color: theme.dangerColor
  }
}))
