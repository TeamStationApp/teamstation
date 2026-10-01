import React, { useEffect, useRef, useState } from 'react'
import { Text, View } from 'react-native'

import type {
  GameStationClient,
  LiveNow,
  SeasonGame,
  SeasonSummary,
  TeamSummary
} from '../../common/api'
import {
  Button,
  Card,
  GameHeroCard,
  initialsOf,
  ListRow,
  LivePill,
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
  onOpenGame: (
    gameId: string,
    title: string,
    options?: { tab?: 'watch' | 'boxScore'; autoPlay?: boolean }
  ) => void
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
  const [live, setLive] = useState<LiveNow[]>([])
  const [liveUrl, setLiveUrl] = useState<string | undefined>(undefined)
  /** Which game `liveUrl` belongs to, so it is not asked for twice. */
  const playing = useRef<string | undefined>(undefined)
  const [recentUrl, setRecentUrl] = useState<string | undefined>(undefined)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | undefined>(undefined)

  /**
   * The recent game's own video, so the card moves rather than sitting there.
   *
   * Two extra requests, and both are cheap: the game to find a playable
   * recording, then its signed URL. It is deliberately *after* the screen has
   * drawn — the poster is already showing, so this only ever improves what is
   * on screen and never delays it.
   */
  useEffect(() => {
    if (recent == null || recent.videoCount < 1) return
    let cancelled = false
    const find = async (): Promise<void> => {
      const detail = await client.game(recent.id)
      const playable = detail.videos.find(
        item => item.status === 'ready' || item.status === 'live'
      )
      if (cancelled || playable == null) return
      const playback = await client.playback(playable.id)
      if (cancelled || playback.url == null) return
      setRecentUrl(playback.url)
    }
    // A card that does not move is the whole of the failure, and the poster
    // already says what the game was.
    find().catch(() => undefined)
    return () => {
      cancelled = true
    }
  }, [client, recent])

  /**
   * What is on right now, asked for every time this screen opens.
   *
   * Nothing is live on almost every day of the year, and the answer then is an
   * empty list and an empty block. It is asked first all the same: a game that
   * is happening is the only thing on this screen that will not still be true
   * in an hour.
   */
  useEffect(() => {
    let cancelled = false
    const look = async (): Promise<void> => {
      const now = await client.liveNow()
      if (cancelled) return
      setLive(now)
      const first = now[0]
      if (first == null) {
        playing.current = undefined
        setLiveUrl(undefined)
        return
      }
      // The URL carries a token minted for this request, so asking again for
      // the game already playing would hand the player a different address for
      // the same stream — and it would tear the stream down and start it
      // again, every half minute, in front of somebody watching.
      if (playing.current === first.videoId) return
      const playback = await client.playback(first.videoId)
      if (cancelled || playback.url == null) return
      playing.current = first.videoId
      setLiveUrl(playback.url)
    }
    look().catch(() => undefined)
    // A game starts while somebody has the page open — which is the whole
    // point of a live block — so it is looked at again on a slow timer rather
    // than only when the screen is opened.
    const timer = setInterval(() => {
      look().catch(() => undefined)
    }, 30_000)
    return () => {
      cancelled = true
      clearInterval(timer)
    }
  }, [client])

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

      // The most recently played game anywhere this person can see. It used
      // to look inside the first season it was handed, which showed a game
      // from June while there were games in September.
      const newest = await client.recentGame()
      if (cancelled) return
      setRecent(newest ?? undefined)
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

      {live.length > 0 && (
        <View style={styles.section}>
          <SectionHeader title="Live now" />
          <Card style={styles.gameCard}>
            <View style={styles.livePoster}>
              <LivePill />
              <VideoPoster
                size="hero"
                videoUrl={liveUrl}
                onVideoGone={() => {
                  // The player has given up on that address. Forgetting which
                  // game it belonged to is all it takes: the next look asks
                  // for a fresh one, which is what a server restarted mid-game
                  // leaves everybody needing.
                  playing.current = undefined
                  setLiveUrl(undefined)
                }}
              />
            </View>
            <Text style={styles.gameMeta}>
              {live[0].awayTeamName} at {live[0].homeTeamName}
              {live[0].startedAt == null
                ? ''
                : ` · started ${startedAtLabel(live[0].startedAt)}`}
              {live[0].angles > 1 ? ` · ${live[0].angles} cameras` : ''}
            </Text>
            <Button
              label="Watch live"
              icon="play_arrow"
              onPress={() => {
                onOpenGame(live[0].gameId, liveTitle(live[0]), {
                  autoPlay: true
                })
              }}
            />
          </Card>

          {/*
            Two games at once is rare and it does happen — a family with a
            child on each of two teams, on a Saturday. The first plays in the
            card; the rest are rows, because two streams playing at once on one
            screen is nobody's idea of a home page.
          */}
          {live.slice(1).map(game => (
            <Card key={game.videoId}>
              <ListRow
                title={liveTitle(game)}
                subtitle={[
                  game.startedAt == null
                    ? undefined
                    : `started ${startedAtLabel(game.startedAt)}`,
                  game.angles > 1 ? `${game.angles} cameras` : undefined
                ]
                  .filter(part => part != null)
                  .join(' · ')}
                emblem={initialsOf(game.homeTeamName)}
                badgeLabel="live"
                badgeTone="live"
                onPress={() => {
                  onOpenGame(game.gameId, liveTitle(game), { autoPlay: true })
                }}
              />
            </Card>
          ))}
        </View>
      )}

      {recent != null && (
        <View style={styles.section}>
          <SectionHeader title="Recent game" />
          <Card style={styles.gameCard}>
            <Text style={styles.gameMeta}>
              {shortDate(recent.startAt)}
              {recent.venue == null ? '' : ` · ${recent.venue}`}
            </Text>
            <GameHeroCard
              awayName={recent.awayTeamName}
              homeName={recent.homeTeamName}
              awayScore={recent.awayScore}
              homeScore={recent.homeScore}
              status={gameStatusLine(recent)}
              winner={winnerOf(recent)}
              awayTeamId={recent.awayTeamId}
              homeTeamId={recent.homeTeamId}
              posterUrl={recent.posterUrl}
              videoUrl={recentUrl}
            />
            {/*
              Two buttons, not one. There was no way to reach a box score from
              this screen at all: a game that was scored and never filmed had
              nothing to press.
            */}
            <View style={styles.actions}>
              {recent.videoCount > 0 && (
                <Button
                  label="Watch"
                  icon="play_arrow"
                  style={styles.action}
                  onPress={() => {
                    onOpenGame(recent.id, matchup(recent), { autoPlay: true })
                  }}
                />
              )}
              <Button
                label="Box Score"
                icon="format_list_bulleted"
                kind="secondary"
                style={styles.action}
                onPress={() => {
                  onOpenGame(recent.id, matchup(recent), { tab: 'boxScore' })
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
                  emblemIcon="event"
                  emblemUri={season.logoUrl}
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

/** `AAA Hawks @ Black Sox`, for the screen a live game opens on. */
function liveTitle(game: LiveNow): string {
  return `${game.awayTeamName} @ ${game.homeTeamName}`
}

/** `3:18 pm`, in the reader's own clock. */
function startedAtLabel(startedAt: string): string {
  return new Date(startedAt)
    .toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })
    .toLowerCase()
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
  livePoster: {
    position: 'relative'
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
