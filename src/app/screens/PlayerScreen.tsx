import React, { useEffect, useMemo, useRef, useState } from 'react'
import { Text, View } from 'react-native'

import type {
  PlayerDetail,
  PlayerHighlight,
  PlayerStats,
  TeamStationClient
} from '../../common/api'
import type { WalkUpSong } from '../../common/walkUpSong'
import {
  Button,
  Card,
  Emblem,
  GameRow,
  HandoffView,
  initialsOf,
  PillTabs,
  Screen,
  type StatFilter,
  StatFilterModal,
  StatGrid,
  useHandoff,
  useHeaderHandoff,
  useHeaderSlot
} from '../components'
import { lstrings, sprintf } from '../locales/strings'
import { cacheStyles, type Theme, useTheme } from '../theme/ThemeContext'
import webMusic, { type WalkUpMusic } from '../walkup/walkUpMusic'
import { WalkUpTab } from '../walkup/WalkUpTab'
import { battingLine, exactDateTime } from './format'
import { PlayerSettingsTab } from './PlayerSettingsTab'
import { battingColumns, pitchingColumns, playerStats } from './statColumns'

export interface PlayerScreenProps {
  client: TeamStationClient
  userId: string
  /** The name the row that was tapped showed, so the header has one at once. */
  title?: string
  /** Which tab to open on, from the address. */
  initialTab?: PlayerTab
  onTab?: (tab: PlayerTab, correcting?: boolean) => void
  /**
   * The team the page was opened for, the address's `onTeam`: the roster
   * row or the box-score side that was tapped. The Settings tab edits the
   * player on it. The Stats filter is a different thing and never changes
   * it.
   */
  forTeam?: string
  /**
   * Whether the viewer coaches `forTeam`, from `GET /me/roles`. Undefined
   * while that is still being asked, so an address that opens on Settings is
   * not sent back to Videos before the answer is in.
   */
  canCoach?: boolean
  /**
   * The Walk-up tab. `canEdit` is whether the viewer keeps `forTeam`'s
   * walk-up songs — a songkeeper of it or its admin — from `GET /me/roles`,
   * and undefined while that is still being asked, as `canCoach` is. The song
   * itself is read from `forTeam`'s roster by the tab.
   */
  walkUp?: {
    canEdit?: boolean
    /** Finds the song on this phone, for Preview. */
    resolve?: (song: WalkUpSong) => Promise<string | null>
    /**
     * Opens the song picker, titled with the player's name: the loaded
     * player's, which an address opened from a link has no other way to know.
     */
    onPick?: (song: WalkUpSong | null, playerName: string) => void
    /** Whether Preview fades Apple Music on the phone's volume. */
    fadeAppleMusic?: boolean
  }
  /** The phone's music; the web's adapter, which has none, by default. */
  music?: WalkUpMusic
  /**
   * What the Stats tab opens narrowed to, from the address.
   *
   * A reader who tapped a name in a box score is asking about that season, not
   * about a career, so the game they came from sets this. From anywhere with no
   * game behind it, nothing is set and the answer is a career.
   */
  initialFilter?: StatFilter
  /** So the address follows the filter, and a link can be sent. */
  onFilter?: (filter: StatFilter) => void
  /** Opens the game's video at the moment of one of their highlights. */
  onOpenMoment?: (
    gameId: string,
    videoId: string,
    atSec: number,
    title: string
  ) => void
}

export type PlayerTab = 'videos' | 'stats' | 'settings' | 'walkup'

const TABS: Array<{ id: PlayerTab; label: string }> = [
  { id: 'videos', label: lstrings.player_videos },
  { id: 'stats', label: lstrings.player_stats }
]
const WALKUP_TAB = {
  id: 'walkup' as const,
  label: lstrings.player_walkup
}
const SETTINGS_TAB = {
  id: 'settings' as const,
  label: lstrings.player_settings
}

/**
 * One player: their face, their name, how they bat and throw, and then what
 * they have actually done.
 *
 * Shaped like a team's page, deliberately — an identity card and a strip of
 * tabs — because they are the same kind of thing and a reader who has learned
 * one has learned the other. The photograph is a circle rather than the team's
 * rounded badge: a face is a circle everywhere else in this app already.
 *
 * The title is the short name, for everybody. The whole name sits under it
 * only when the server sent one, which it does for a coach or an
 * administrator of the player's team, a parent, the player and a site
 * administrator; this screen never decides that for itself.
 */
export function PlayerScreen(props: PlayerScreenProps): React.ReactElement {
  const {
    client,
    userId,
    title,
    initialTab,
    initialFilter,
    onTab,
    onFilter,
    onOpenMoment,
    forTeam,
    canCoach,
    walkUp,
    music = webMusic
  } = props
  const theme = useTheme()
  const styles = getStyles(theme)

  const [player, setPlayer] = useState<PlayerDetail | undefined>(undefined)
  const [tab, setTab] = useState<PlayerTab>(initialTab ?? 'videos')
  /**
   * The address is allowed to change this, not only to start it.
   *
   * Seeded once, the two disagreed the moment anything but a tap moved the
   * address: Back from the box score wrote `/games/g1` and left the box score
   * on the screen — on a phone, where Back is how people leave things, a
   * button that does nothing reads as a hang. Both ends of the app gain the
   * same thing, because it is the same code.
   *
   * The default is repeated rather than guarded against: an address that names
   * no half means the first one.
   */
  useEffect(() => {
    setTab(initialTab ?? 'videos')
  }, [initialTab])

  // Settings is offered to a coach of the team the page was opened for, and
  // Walk-up to a keeper of its songs, on the web and on a phone alike, and
  // to nobody else. An address that asks for either without that right opens
  // on Videos, and says so, once the answer to "do they hold it?" is in.
  const canKeepSongs = walkUp?.canEdit
  const settingsShown = forTeam != null && canCoach === true
  const walkUpShown = forTeam != null && canKeepSongs === true
  const tabs = [
    ...TABS,
    ...(walkUpShown ? [WALKUP_TAB] : []),
    ...(settingsShown ? [SETTINGS_TAB] : [])
  ]
  const refused =
    forTeam != null &&
    ((tab === 'settings' && canCoach === false) ||
      (tab === 'walkup' && canKeepSongs === false))
  useEffect(() => {
    if (!refused) return
    setTab('videos')
    onTab?.('videos', true)
  }, [refused, onTab])
  const shownTab =
    (tab === 'settings' && !settingsShown) || (tab === 'walkup' && !walkUpShown)
      ? 'videos'
      : tab

  const [error, setError] = useState<string | undefined>(undefined)
  const [highlights, setHighlights] = useState<PlayerHighlight[]>([])
  const [nextBefore, setNextBefore] = useState<string | undefined>(undefined)
  const [withoutVideo, setWithoutVideo] = useState(0)
  const [loadingVideos, setLoadingVideos] = useState(true)
  /** The page being asked for. Undefined is the first one. */
  const [before, setBefore] = useState<string | undefined>(undefined)
  const [stats, setStats] = useState<PlayerStats | undefined>(undefined)
  const [filter, setFilter] = useState<StatFilter>(initialFilter ?? {})
  const narrowed =
    filter.seasonId != null || filter.teamId != null || filter.year != null
  const [filtering, setFiltering] = useState(false)
  const [loadingStats, setLoadingStats] = useState(true)

  // The name slides up into the header as the card goes under it, the way a
  // team's does. Until the request lands, the name the tapped row showed is
  // what goes up there: it is the same name, and a header that appears half a
  // second late reads as the page having jumped.
  const shown = player?.name ?? title ?? ''
  const { headerHeight } = useHeaderSlot()
  const handoff = useHandoff(headerHeight)
  const progress = handoff.progress
  const avatarUrl = player?.avatarUrl
  useHeaderHandoff(
    useMemo(
      () => (
        <HandoffView progress={progress} style={styles.headerHandoff}>
          <Emblem
            uri={avatarUrl}
            fallback={initialsOf(shown)}
            shape="circle"
            size={1.75}
          />
          <Text style={styles.headerName} numberOfLines={1}>
            {shown}
          </Text>
        </HandoffView>
      ),
      [progress, styles.headerHandoff, styles.headerName, avatarUrl, shown]
    )
  )

  // A screen re-used for a second player must not keep the first one's pages,
  // or the first one's filter: a season the new player never played in is not
  // a narrowing anybody asked for. The stack unmounts between two players
  // today, so this has nothing to undo — and a list that silently appended
  // somebody else's highlights would be very hard to see and impossible to
  // explain.
  //
  // On the first render there is nothing to forget, and clearing then would
  // throw away the filter the address arrived with.
  const showing = useRef(userId)
  useEffect(() => {
    if (showing.current === userId) return
    showing.current = userId
    setPlayer(undefined)
    setHighlights([])
    setNextBefore(undefined)
    setWithoutVideo(0)
    setBefore(undefined)
    setStats(undefined)
    setError(undefined)
    setFilter({})
  }, [userId])

  useEffect(() => {
    let cancelled = false
    client
      .player(userId)
      .then(loaded => {
        if (!cancelled) setPlayer(loaded)
      })
      .catch((caught: unknown) => {
        if (!cancelled) {
          setError(
            caught instanceof Error
              ? caught.message
              : lstrings.player_cannot_load
          )
        }
      })
    return () => {
      cancelled = true
    }
  }, [client, userId])

  // Their highlights, a page at a time. Every play they are credited on,
  // across every game and every team — the Videos tab is never filtered.
  useEffect(() => {
    let cancelled = false
    setLoadingVideos(true)
    client
      .playerHighlights(userId, { before })
      .then(page => {
        if (cancelled) return
        // Appended rather than replaced: `Show more` is another page of the
        // same list, not a new one.
        setHighlights(held =>
          before == null ? page.highlights : [...held, ...page.highlights]
        )
        setNextBefore(page.nextBefore ?? undefined)
        setWithoutVideo(held => (before == null ? 0 : held) + page.withoutVideo)
      })
      .catch(() => {
        // The hero card and the stats are still worth showing without them.
        if (!cancelled) setNextBefore(undefined)
      })
      .finally(() => {
        if (!cancelled) setLoadingVideos(false)
      })
    return () => {
      cancelled = true
    }
  }, [client, userId, before])

  // Their figures, for whichever games the filter is on. Asked for again when
  // the filter changes rather than added up here: the arithmetic has one home,
  // and it is the one that was measured against published box scores.
  useEffect(() => {
    let cancelled = false
    setLoadingStats(true)
    client
      .playerStats(userId, filter)
      .then(loaded => {
        if (!cancelled) setStats(loaded)
      })
      .catch(() => {
        if (!cancelled) setStats(undefined)
      })
      .finally(() => {
        if (!cancelled) setLoadingStats(false)
      })
    return () => {
      cancelled = true
    }
  }, [client, userId, filter])

  const handedness = player == null ? undefined : battingLine(player)

  return (
    <Screen onScroll={handoff.handleScroll}>
      <Card style={styles.identity} ref={handoff.ref}>
        <View style={styles.identityTop}>
          <Emblem
            uri={player?.avatarUrl}
            fallback={initialsOf(shown)}
            shape="circle"
            size={3.5}
          />
          <View style={styles.identityText}>
            <Text style={styles.playerName}>{shown}</Text>
            {/*
              Only when there is something to say. `B: —` claims we looked and
              found nothing; a missing line claims nothing at all, which is
              what an empty column actually means.
            */}
            {handedness != null && (
              <Text style={styles.playerMeta}>{handedness}</Text>
            )}
          </View>
        </View>
      </Card>

      <PillTabs
        tabs={tabs}
        selected={shownTab}
        onSelect={next => {
          setTab(next)
          onTab?.(next)
        }}
        size="compact"
        accessibilityLabel={lstrings.player_sections}
      />

      {error != null && <Text style={styles.error}>{error}</Text>}

      {shownTab === 'videos' && (
        <View style={styles.section}>
          {loadingVideos && highlights.length === 0 && (
            <Card>
              <Text style={styles.muted}>{lstrings.player_loading}</Text>
            </Card>
          )}
          {!loadingVideos && highlights.length === 0 && (
            <Card>
              <Text style={styles.muted}>
                {withoutVideo > 0
                  ? lstrings.player_videos_none_recorded
                  : lstrings.player_videos_empty}
              </Text>
            </Card>
          )}
          {highlights.map(highlight => (
            <Card key={`${highlight.eventId} ${highlight.videoId}`}>
              <GameRow
                first={highlight.teamName ?? ''}
                second={highlight.outcome}
                detail={exactDateTime(highlight.playAt)}
                posterUrl={highlight.stillUrl}
                onPress={() => {
                  onOpenMoment?.(
                    highlight.gameId,
                    highlight.videoId,
                    highlight.startOffsetSec,
                    highlight.outcome
                  )
                }}
              />
            </Card>
          ))}
          {nextBefore != null && (
            <Button
              label={lstrings.player_show_more}
              kind="secondary"
              onPress={() => {
                setBefore(nextBefore)
              }}
            />
          )}
        </View>
      )}

      {shownTab === 'walkup' && forTeam != null && (
        <View style={styles.section}>
          <WalkUpTab
            client={client}
            teamId={forTeam}
            userId={userId}
            music={music}
            resolve={walkUp?.resolve}
            onPick={
              walkUp?.onPick == null
                ? undefined
                : song => {
                    walkUp.onPick?.(song, shown)
                  }
            }
            fadeAppleMusic={walkUp?.fadeAppleMusic}
          />
        </View>
      )}

      {shownTab === 'settings' && forTeam != null && (
        <View style={styles.section}>
          <PlayerSettingsTab
            client={client}
            teamId={forTeam}
            userId={userId}
            onSaved={entry => {
              // How they bat and throw is on the card above; keep it true.
              setPlayer(held =>
                held == null
                  ? held
                  : { ...held, bats: entry.bats, throws: entry.throws }
              )
            }}
          />
        </View>
      )}

      {shownTab === 'stats' && (
        <View style={styles.section}>
          <View style={styles.filterRow}>
            <Text style={styles.scope}>{scopeOf(stats, filter)}</Text>
            <Button
              label={lstrings.player_filter}
              kind="secondary"
              onPress={() => {
                setFiltering(true)
              }}
            />
          </View>

          {loadingStats && stats == null && (
            <Card>
              <Text style={styles.muted}>{lstrings.player_loading}</Text>
            </Card>
          )}

          {stats != null && stats.batting == null && stats.pitching == null && (
            <Card>
              {/*
                Two different silences. "Nothing under this filter" is a
                narrowing the reader chose and can undo; "no stats yet" is
                about the player. Saying the second when the first is true
                reads as a boy with twelve games having none.
              */}
              <Text style={styles.muted}>
                {narrowed
                  ? lstrings.player_filter_empty
                  : lstrings.player_stats_empty}
              </Text>
              {narrowed && (
                <Button
                  label={lstrings.player_filter_clear}
                  kind="secondary"
                  onPress={() => {
                    setFilter({})
                    onFilter?.({})
                  }}
                />
              )}
            </Card>
          )}

          {stats?.batting != null && (
            <Card>
              <Text style={styles.cardTitle}>{lstrings.player_batting}</Text>
              <StatGrid
                stats={playerStats(stats.batting, battingColumns)}
                columns={4}
              />
            </Card>
          )}

          {/*
            A card that says why it is empty, rather than one that is not
            there: a pitcher with no plate appearances and a pitcher we have
            no figures for look identical when the card is simply dropped.
          */}
          {stats?.batting == null && stats?.pitching != null && (
            <Card>
              <Text style={styles.cardTitle}>{lstrings.player_batting}</Text>
              <Text style={styles.muted}>{lstrings.player_no_batting}</Text>
            </Card>
          )}

          {stats?.pitching != null && (
            <Card>
              <Text style={styles.cardTitle}>{lstrings.player_pitching}</Text>
              <StatGrid
                stats={playerStats(stats.pitching, pitchingColumns)}
                columns={4}
              />
            </Card>
          )}
        </View>
      )}

      {filtering && stats != null && (
        <StatFilterModal
          options={stats.options}
          filter={filter}
          onApply={next => {
            setFiltering(false)
            setFilter(next)
            onFilter?.(next)
          }}
          onClose={() => {
            setFiltering(false)
          }}
        />
      )}
    </Screen>
  )
}

/** `12 games · Spring 2026`, or just the games for a career. */
function scopeOf(stats: PlayerStats | undefined, filter: StatFilter): string {
  const games =
    stats == null
      ? ''
      : stats.games === 1
        ? lstrings.player_one_game
        : sprintf(lstrings.player_games, String(stats.games))
  // A season renamed or re-imported since the link was sent is a filter with
  // no name left. Saying so beats `12 games · ` with nothing after it.
  const named =
    filter.seasonId != null
      ? (stats?.options.seasons.find(
          season => season.seasonId === filter.seasonId
        )?.name ?? lstrings.player_filter_unknown)
      : filter.teamId != null
        ? (stats?.options.teams.find(team => team.teamId === filter.teamId)
            ?.name ?? lstrings.player_filter_unknown)
        : filter.year != null
          ? String(filter.year)
          : lstrings.player_filter_career
  if (games === '') return named
  return sprintf(lstrings.player_stats_scope, games, named)
}

const getStyles = cacheStyles((theme: Theme) => ({
  filterRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: theme.rem(theme.spaceSmRem)
  },
  scope: {
    flex: 1,
    fontFamily: theme.regularTextFont,
    fontSize: theme.rem(0.875),
    color: theme.secondaryTextColor
  },
  cardTitle: {
    fontFamily: theme.semiBoldTextFont,
    fontSize: theme.rem(1),
    fontWeight: '600',
    color: theme.primaryTextColor,
    marginBottom: theme.rem(theme.spaceSmRem)
  },
  headerHandoff: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: theme.rem(theme.spaceXsRem)
  },
  headerName: {
    fontFamily: theme.boldTextFont,
    fontSize: theme.rem(1.0625),
    fontWeight: '700',
    color: theme.headerTextColor,
    textAlign: 'center'
  },
  section: {
    gap: theme.rem(theme.spaceMdRem)
  },
  identity: {
    gap: theme.rem(theme.spaceMdRem)
  },
  identityTop: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: theme.rem(theme.spaceMdRem)
  },
  identityText: {
    flex: 1,
    gap: theme.rem(0.125)
  },
  playerName: {
    fontFamily: theme.boldTextFont,
    fontSize: theme.rem(1.5),
    fontWeight: '700',
    letterSpacing: theme.rem(-0.02),
    color: theme.primaryTextColor
  },
  playerMeta: {
    fontFamily: theme.regularTextFont,
    fontSize: theme.rem(0.875),
    color: theme.secondaryTextColor
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
