import React, { useEffect, useState } from 'react'
import { Text, View } from 'react-native'

import type {
  GameStationClient,
  SeasonGame,
  SeasonSummary,
  TeamSummary
} from '../../common/api'
import {
  Button,
  Card,
  initialsOf,
  ListRow,
  Scoreboard,
  Screen,
  SectionHeader,
  VideoPoster
} from '../components'
import { cacheStyles, type Theme, useTheme } from '../theme/ThemeContext'
import { gameStatusLine, matchupLines, shortDate, winnerOf } from './format'

export interface HomeScreenProps {
  client: GameStationClient
  onOpenTeam: (team: TeamSummary) => void
  onOpenSeason: (season: SeasonSummary) => void
  onOpenGame: (gameId: string, title: string) => void
}

/**
 * The first screen: the last game played, the teams you belong to, and the
 * seasons you may watch.
 *
 * Teams above seasons, on Paul's instruction. Being *on* a team is a stronger
 * thing than being allowed to watch a season, and the person opening this app
 * is usually looking for one child's team — so the teams are the first thing
 * under the thumb, and the seasons are there for the wider wander.
 */
export function HomeScreen(props: HomeScreenProps): React.ReactElement {
  const { client, onOpenTeam, onOpenSeason, onOpenGame } = props
  const styles = getStyles(useTheme())

  const [teams, setTeams] = useState<TeamSummary[]>([])
  const [seasons, setSeasons] = useState<SeasonSummary[]>([])
  const [recent, setRecent] = useState<SeasonGame | undefined>(undefined)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | undefined>(undefined)

  useEffect(() => {
    let cancelled = false
    const load = async (): Promise<void> => {
      const [loadedTeams, loadedSeasons] = await Promise.all([
        client.teams(),
        client.seasons()
      ])
      if (cancelled) return
      setTeams(loadedTeams)
      setSeasons(loadedSeasons)

      // The most recently finished game across the seasons on offer. One extra
      // request, and only for the newest season: a parent opening the app
      // almost always wants the game that just happened.
      const newest = loadedSeasons[0]
      if (newest != null) {
        const games = await client.seasonGames(newest.id)
        if (cancelled) return
        setRecent(mostRecentlyPlayed(games))
      }
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
  }, [client])

  if (loading) {
    return (
      <Screen>
        <Text style={styles.muted}>Loading…</Text>
      </Screen>
    )
  }

  const nothing = teams.length === 0 && seasons.length === 0

  return (
    <Screen>
      {error != null && <Text style={styles.error}>{error}</Text>}

      {recent != null && (
        <View style={styles.section}>
          <SectionHeader title="Recent game" />
          <Card style={styles.gameCard}>
            <Text style={styles.gameMeta}>
              {shortDate(recent.startAt)}
              {recent.venue == null ? '' : ` · ${recent.venue}`}
            </Text>
            {recent.posterUrl != null ? (
              // The video's own frame, with the score over a gradient. A dark
              // panel says the same thing and shows nothing of the game.
              <VideoPoster
                uri={recent.posterUrl}
                size="hero"
                showPlay
                onPlay={() => {
                  onOpenGame(recent.id, matchup(recent))
                }}
              >
                <Text style={styles.posterTeams} numberOfLines={1}>
                  {`${recent.awayTeamName} ${recent.awayScore ?? ''}`.trim()}
                </Text>
                <Text style={styles.posterTeams} numberOfLines={1}>
                  {`${recent.homeTeamName} ${recent.homeScore ?? ''}`.trim()}
                </Text>
                <Text style={styles.posterStatus}>
                  {gameStatusLine(recent)}
                </Text>
              </VideoPoster>
            ) : (
              <Scoreboard
                awayName={recent.awayTeamName}
                homeName={recent.homeTeamName}
                awayScore={recent.awayScore}
                homeScore={recent.homeScore}
                status={gameStatusLine(recent)}
                winner={winnerOf(recent)}
              />
            )}
            {/*
              Two buttons, not one. There was no way to reach a box score from
              this screen at all: a game that was scored and never filmed had
              nothing to press.
            */}
            <View style={styles.actions}>
              {recent.videoCount > 0 && (
                <Button
                  label="Watch Replay"
                  icon="play_arrow"
                  style={styles.action}
                  onPress={() => {
                    onOpenGame(recent.id, matchup(recent))
                  }}
                />
              )}
              <Button
                label="Box Score"
                icon="format_list_bulleted"
                kind="secondary"
                style={styles.action}
                onPress={() => {
                  onOpenGame(recent.id, matchup(recent))
                }}
              />
            </View>
          </Card>
        </View>
      )}

      {teams.length > 0 && (
        <View style={styles.section}>
          <SectionHeader title="Your teams" note={String(teams.length)} />
          <Card>
            {teams.map((team, index) => (
              <View key={team.id}>
                {index > 0 && <View style={styles.divider} />}
                <ListRow
                  title={team.name}
                  subtitle={subtitleFor(team)}
                  emblem={initialsOf(team.name)}
                  emblemUri={team.logoUrl}
                  onPress={() => {
                    onOpenTeam(team)
                  }}
                />
              </View>
            ))}
          </Card>
        </View>
      )}

      {seasons.length > 0 && (
        <View style={styles.section}>
          <SectionHeader title="Seasons" note="Current & past" />
          <Card>
            {seasons.map((season, index) => (
              <View key={season.id}>
                {index > 0 && <View style={styles.divider} />}
                <ListRow
                  title={season.name}
                  subtitle={`${season.teams} teams · ${season.games} games · ${season.videos} videos`}
                  emblem="▦"
                  badgeLabel={season.term ?? undefined}
                  badgeTone="neutral"
                  onPress={() => {
                    onOpenSeason(season)
                  }}
                />
              </View>
            ))}
          </Card>
        </View>
      )}

      {nothing && (
        <Card>
          <Text style={styles.emptyTitle}>Nothing to watch yet</Text>
          <Text style={styles.muted}>
            Your account is not on a team or in a season yet. Ask your league
            administrator to add you, and this screen will fill in.
          </Text>
        </Card>
      )}
    </Screen>
  )
}

/** The newest game that has actually been played, by start time. */
function mostRecentlyPlayed(games: SeasonGame[]): SeasonGame | undefined {
  const played = games
    .filter(game => game.awayScore != null && game.startAt != null)
    .sort((a, b) => (a.startAt ?? '').localeCompare(b.startAt ?? ''))
  return played[played.length - 1]
}

/** `AAA Hawks @ Black Sox`, the way the row in a list reads. */
function matchup(game: SeasonGame): string {
  const lines = matchupLines(game)
  return `${lines.first} ${lines.second}`
}

/** `NPLL Spring 2026 · 12–3`, or whichever half of that we know. */
function subtitleFor(team: TeamSummary): string | undefined {
  const parts: string[] = []
  if (team.record?.seasonName != null) parts.push(team.record.seasonName)
  else if (team.shortName != null) parts.push(team.shortName)
  if (team.record != null) {
    const { w, l, t } = team.record
    // An en dash: it is a record, not a range of numbers, and the hyphen is
    // visibly too short beside the numerals at this weight.
    parts.push(t > 0 ? `${w}–${l}–${t}` : `${w}–${l}`)
  }
  return parts.length === 0 ? undefined : parts.join(' · ')
}

const getStyles = cacheStyles((theme: Theme) => ({
  section: {
    gap: theme.rem(theme.spaceMdRem)
  },
  gameCard: {
    gap: theme.rem(theme.spaceMdRem)
  },
  posterTeams: {
    color: '#ffffff',
    fontFamily: theme.semiBoldTextFont,
    fontSize: theme.rem(1),
    fontWeight: '700'
  },
  posterStatus: {
    color: '#ffffff',
    fontFamily: theme.semiBoldTextFont,
    fontSize: theme.rem(0.75),
    letterSpacing: theme.rem(0.04),
    opacity: 0.85
  },
  actions: {
    flexDirection: 'row',
    gap: theme.rem(theme.spaceSmRem)
  },
  action: {
    flex: 1
  },
  gameMeta: {
    fontFamily: theme.semiBoldTextFont,
    fontSize: theme.rem(0.75),
    fontWeight: '700',
    letterSpacing: theme.rem(0.04),
    color: theme.secondaryTextColor
  },
  divider: {
    height: 1,
    backgroundColor: theme.defaultBorderColor
  },
  muted: {
    fontFamily: theme.regularTextFont,
    fontSize: theme.rem(0.9375),
    color: theme.secondaryTextColor
  },
  emptyTitle: {
    fontFamily: theme.semiBoldTextFont,
    fontSize: theme.rem(1.125),
    fontWeight: '600',
    color: theme.primaryTextColor,
    marginBottom: theme.rem(theme.spaceSmRem)
  },
  error: {
    fontFamily: theme.regularTextFont,
    fontSize: theme.rem(0.875),
    color: theme.dangerColor
  }
}))
