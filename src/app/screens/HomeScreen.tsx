import React, { useEffect, useRef, useState } from 'react'
import { Text, View } from 'react-native'

import type {
  LiveNow,
  SeasonGame,
  SeasonSummary,
  TeamStationClient,
  TeamSummary,
  UserMatch
} from '../../common/api'
import type { GroupKind, GroupRef } from '../../common/groupCreation'
import { localityLabel } from '../../common/locality'
import type { PublicGroup } from '../../common/publicGroups'
import { seasonPeriodLabel } from '../../common/seasonTimeFrames'
import { creationIcons } from '../assets'
import type { ChatLink } from '../chat/ChatLinks'
import {
  Button,
  Card,
  GameHeroCard,
  initialsOf,
  ListCard,
  ListRow,
  LivePill,
  Screen,
  SectionHeader,
  VideoPoster
} from '../components'
import { CreationCard } from '../components/CreationCard'
import { cacheStyles, type Theme, useTheme } from '../theme/ThemeContext'
import { gameStatusLine, matchupLines, shortDate, winnerOf } from './format'
import type { GameListOpenOptions } from './gameListOptions'

export interface HomeScreenProps {
  client: TeamStationClient
  onOpenTeam: (team: TeamSummary) => void
  onOpenSeason: (season: SeasonSummary) => void
  onOpenGame: (
    gameId: string,
    title: string,
    options?: GameListOpenOptions
  ) => void
  onCreateGroup?: (kind: GroupKind) => void
  onOpenGroup?: (ref: GroupRef) => void
  /**
   * A player the person is a guardian of, opened with no team: their whole
   * career rather than one team's part of it.
   */
  onOpenPlayer?: (userId: number, title: string) => void
  /**
   * The leagues whose Org chat the person is in. A league has no page of
   * its own, so its card opens its chat.
   */
  leagueChats?: Array<ChatLink & { league: string }>
  onOpenChat?: (chat: ChatLink) => void
}

/**
 * The first screen: the last game played, the players you are a guardian of,
 * the teams you belong to, and the seasons you may watch.
 *
 * Teams above seasons, on Paul's instruction. Being *on* a team is a stronger
 * thing than being allowed to watch a season, and the person opening this app
 * is usually looking for one child's team — so the teams are the first thing
 * under the thumb, and the seasons are there for the wider wander. That
 * child, for a guardian, is "Your Players", just above the teams.
 */
export function HomeScreen(props: HomeScreenProps): React.ReactElement {
  const { client, onOpenTeam, onOpenSeason, onOpenGame } = props
  const styles = getStyles(useTheme())

  const [players, setPlayers] = useState<UserMatch[]>([])
  const [teams, setTeams] = useState<TeamSummary[]>([])
  const [groups, setGroups] = useState<PublicGroup[]>([])
  const [followed, setFollowed] = useState<PublicGroup[]>([])
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

  // Whether Home can open a player at all, not which function opens one: the
  // shell hands over a new one whenever it renders, and that is no reason to
  // read everything again.
  const opensPlayers = props.onOpenPlayer != null
  useEffect(() => {
    let cancelled = false
    const load = async (): Promise<void> => {
      const [loadedTeams, loadedSeasons, ownGroups, follows, guarded] =
        await Promise.all([
          client.teams(),
          client.seasons(),
          props.onOpenGroup == null ? Promise.resolve([]) : client.ownGroups(),
          // Following is a nicety: Home still opens when it cannot be read.
          props.onOpenGroup == null
            ? Promise.resolve([])
            : client.follows().catch(() => []),
          // So is the list of the players one guards: Home opens without it.
          opensPlayers
            ? client.guardedPlayers().catch(() => [])
            : Promise.resolve([])
        ])
      if (cancelled) return
      setPlayers(guarded)
      setTeams(loadedTeams)
      setSeasons(loadedSeasons)
      setGroups(ownGroups)
      setFollowed(follows)

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
  }, [client, props.onOpenGroup, opensPlayers])

  if (loading) {
    return (
      <Screen>
        <Text style={styles.muted}>Loading…</Text>
      </Screen>
    )
  }

  const leagues = groups.filter(group => group.kind === 'league')
  // recentGame asks for played rows, so pending revisions here retain an
  // approved score/recording. A projected unapproved event has neither.
  const recentPublished =
    recent != null &&
    (!recent.pendingApproval ||
      recent.videoCount > 0 ||
      recent.homeScore != null ||
      recent.awayScore != null)

  // Followed groups sit in the same sections, after the person's own, and
  // never twice.
  const followedOf = (kind: GroupKind, own: Set<string>): PublicGroup[] =>
    followed.filter(group => group.kind === kind && !own.has(group.id))
  const followedTeams = followedOf('team', new Set(teams.map(team => team.id)))
  const followedSeasons = followedOf(
    'season',
    new Set(seasons.map(season => season.id))
  )
  const followedLeagues = followedOf(
    'league',
    new Set(leagues.map(league => league.id))
  )
  const counts = {
    league: leagues.length + followedLeagues.length,
    season: seasons.length + followedSeasons.length,
    team: teams.length + followedTeams.length
  }
  const missingKinds = (['league', 'season', 'team'] as const).filter(
    kind => counts[kind] === 0
  )
  const canCreate = props.onCreateGroup != null && error == null
  const titleOf = (kind: GroupKind): string =>
    `${kind[0].toUpperCase()}${kind.slice(1)}`
  /**
   * `Create Team` beside a section's title. Finding a group to follow is the
   * Search tab's job, so Home only creates.
   */
  const sectionActions = (
    kind: GroupKind
  ): Array<{
    label: string
    accessibilityLabel: string
    onPress: () => void
  }> =>
    canCreate
      ? [
          {
            label: `Create ${titleOf(kind)}`,
            accessibilityLabel: `Create ${titleOf(kind)}`,
            onPress: () => props.onCreateGroup?.(kind)
          }
        ]
      : []
  const followedRow = (group: PublicGroup): React.ReactElement => (
    <ListRow
      title={group.name}
      subtitle={
        group.kind === 'season'
          ? seasonPeriodLabel(group.startsOn, group.endsOn)
          : (group.parentNames[0] ??
            (group.locality == null
              ? undefined
              : localityLabel(group.locality)))
      }
      emblem={initialsOf(group.name)}
      emblemUri={group.imageUrl}
      badgeLabel="Following"
      badgeTone="neutral"
      onPress={() => {
        props.onOpenGroup?.({ kind: group.kind, id: group.id })
      }}
    />
  )
  // Nothing at all: the cards lead. Otherwise each kind still missing has
  // its card below everything the person already has.
  const showEmptyHero = canCreate && missingKinds.length === 3
  const descriptions: Record<GroupKind, string> = {
    league:
      'Create an organization that runs multiple seasons or tournaments. Leagues represent a longstanding organization that runs repeated seasons with new or recurring teams.',
    season:
      'Create a season or tournament with a game schedule for selected teams. A season is a time-scoped duration of games such as Spring 2027, Fall 2026, or 2026 Labor Day Classic. Seasons can be standalone or managed by a league.',
    team: 'A team is a collection of coaches, staff, and players that can stand alone, be added to a season, and be managed by staff of the team, its parent seasons, or its parent league.'
  }
  const creationCards = (kinds: readonly GroupKind[]): React.ReactElement => (
    <View
      style={{
        flexDirection: 'row',
        flexWrap: 'wrap',
        gap: 16,
        marginBottom: 20
      }}
    >
      {kinds.map(kind => (
        <CreationCard
          key={kind}
          title={`Create ${kind[0].toUpperCase()}${kind.slice(1)}`}
          icon={creationIcons[kind]}
          description={descriptions[kind]}
          onPress={() => props.onCreateGroup?.(kind)}
        />
      ))}
    </View>
  )
  return (
    <Screen>
      {error != null && <Text style={styles.error}>{error}</Text>}
      {showEmptyHero && creationCards(missingKinds)}
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
            <ListCard key={game.videoId}>
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
            </ListCard>
          ))}
        </View>
      )}

      {recent != null && (
        <View style={styles.section}>
          <SectionHeader title="Recent game" />
          <Card style={styles.gameCard}>
            {/*
              Over a picture the card has no line of its own for the date, so
              it sits above; drawn plainly, the card carries it, with the
              status on the same line at the right.
            */}
            {recent.posterUrl != null && recent.posterUrl !== '' && (
              <Text style={styles.gameMeta}>
                {shortDate(recent.startAt)}
                {recent.venue == null ? '' : ` · ${recent.venue}`}
              </Text>
            )}
            <GameHeroCard
              awayName={recent.awayTeamName}
              homeName={recent.homeTeamName}
              awayScore={recent.awayScore}
              homeScore={recent.homeScore}
              status={gameStatusLine(recent)}
              pendingApproval={recent.pendingApproval}
              live={recent.status === 'inProgress'}
              date={shortDate(recent.startAt)}
              venue={recent.venue ?? undefined}
              winner={winnerOf(recent)}
              awayTeamId={recent.awayTeamId}
              homeTeamId={recent.homeTeamId}
              awayLogoUrl={recent.awayLogoUrl}
              homeLogoUrl={recent.homeLogoUrl}
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
              {recentPublished && (
                <Button
                  label="Box Score"
                  icon="format_list_bulleted"
                  kind="secondary"
                  style={styles.action}
                  onPress={() => {
                    onOpenGame(recent.id, matchup(recent), { tab: 'boxScore' })
                  }}
                />
              )}
              {recent.pendingApproval && recent.pendingRequestId != null && (
                <Button
                  label="Open game proposal"
                  kind="secondary"
                  style={styles.action}
                  onPress={() => {
                    onOpenGame(recent.id, matchup(recent), {
                      pendingRequestId: recent.pendingRequestId
                    })
                  }}
                />
              )}
            </View>
          </Card>
        </View>
      )}

      {players.length > 0 && (
        <View style={styles.section}>
          <SectionHeader title="Your Players" />
          <ListCard>
            {players.map(player => {
              const name = player.shortName ?? String(player.userId)
              return (
                <ListRow
                  key={player.userId}
                  title={name}
                  emblem={initialsOf(name)}
                  emblemUri={player.avatarUrl}
                  onPress={() => {
                    props.onOpenPlayer?.(player.userId, name)
                  }}
                />
              )
            })}
          </ListCard>
        </View>
      )}

      {counts.team > 0 && (
        <View style={styles.section}>
          <SectionHeader title="Your teams" actions={sectionActions('team')} />
          <ListCard>
            {teams.map(team => (
              <ListRow
                key={team.id}
                title={team.name}
                subtitle={subtitleFor(team)}
                emblem={initialsOf(team.name)}
                emblemUri={team.logoUrl}
                onPress={() => {
                  onOpenTeam(team)
                }}
              />
            ))}
            {followedTeams.map(group => (
              <View key={group.id}>{followedRow(group)}</View>
            ))}
          </ListCard>
        </View>
      )}

      {counts.season > 0 && (
        <View style={styles.section}>
          <SectionHeader title="Seasons" actions={sectionActions('season')} />
          <ListCard>
            {seasons.map(season => (
              <ListRow
                key={season.id}
                title={season.name}
                subtitle={`${season.teams} teams · ${season.games} games · ${season.videos} videos`}
                emblemIcon="event"
                emblemUri={season.logoUrl}
                badgeLabel={season.term ?? undefined}
                badgeTone="neutral"
                onPress={() => {
                  props.onOpenGroup == null
                    ? onOpenSeason(season)
                    : props.onOpenGroup({ kind: 'season', id: season.id })
                }}
              />
            ))}
            {followedSeasons.map(group => (
              <View key={group.id}>{followedRow(group)}</View>
            ))}
          </ListCard>
        </View>
      {props.leagueChats != null &&
        props.leagueChats.length > 0 &&
        props.onOpenChat != null && (
          <View style={styles.section}>
            <SectionHeader title="Leagues" />
            <Card>
              {props.leagueChats.map((chat, index) => (
                <View key={chat.id}>
                  {index > 0 && <View style={styles.divider} />}
                  <ListRow
                    title={chat.league}
                    subtitle={chat.title}
                    emblemIcon="chat"
                    onPress={() => {
                      props.onOpenChat?.(chat)
                    }}
                  />
                </View>
              ))}
            </Card>
          </View>
        )}

      )}
      {counts.league > 0 && (
        <View style={styles.section}>
          <SectionHeader
            title="Your leagues"
            actions={sectionActions('league')}
          />
          <ListCard>
            {leagues.map(league => (
              <ListRow
                key={league.id}
                title={league.name}
                emblem={initialsOf(league.name)}
                emblemUri={league.imageUrl}
                onPress={() => {
                  props.onOpenGroup?.({ kind: 'league', id: league.id })
                }}
              />
            ))}
            {followedLeagues.map(group => (
              <View key={group.id}>{followedRow(group)}</View>
            ))}
          </ListCard>
        </View>
      )}
      {canCreate &&
        !showEmptyHero &&
        missingKinds.length > 0 &&
        creationCards(missingKinds)}
    </Screen>
  )
}

/** `Alta Hawks @ Bay Stars`, for the screen a live game opens on. */
function liveTitle(game: LiveNow): string {
  return `${game.awayTeamName} @ ${game.homeTeamName}`
}

/** `3:18 pm`, in the reader's own clock. */
function startedAtLabel(startedAt: string): string {
  return new Date(startedAt)
    .toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })
    .toLowerCase()
}

/** `Alta Hawks @ Bay Stars`, the way the row in a list reads. */
function matchup(game: SeasonGame): string {
  const lines = matchupLines(game)
  return `${lines.first} ${lines.second}`
}

/** `QPLL Spring 2026 · 12–3`, or whichever half of that we know. */
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
