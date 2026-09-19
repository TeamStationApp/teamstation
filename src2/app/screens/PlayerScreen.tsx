import React, { useEffect, useMemo, useRef, useState } from 'react'
import { Text, View } from 'react-native'

import type {
  GameStationClient,
  PlayerDetail,
  PlayerHighlight,
  PlayerStats
} from '../../common/api'
import {
  Button,
  Card,
  Emblem,
  GameRow,
  HandoffView,
  initialsOf,
  PillTabs,
  Screen,
  type Stat,
  type StatFilter,
  StatFilterModal,
  StatGrid,
  useHandoff,
  useHeaderHandoff,
  useHeaderSlot
} from '../components'
import { lstrings, sprintf } from '../locales/strings'
import { cacheStyles, type Theme, useTheme } from '../theme/ThemeContext'
import { battingLine, exactDateTime } from './format'
import { average } from './GameScreen'

export interface PlayerScreenProps {
  client: GameStationClient
  userId: string
  /** The name the row that was tapped showed, so the header has one at once. */
  title?: string
  /** Which tab to open on, from the address. */
  initialTab?: 'videos' | 'stats'
  onTab?: (tab: 'videos' | 'stats', correcting?: boolean) => void
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

const TABS = [
  { id: 'videos' as const, label: lstrings.player_videos },
  { id: 'stats' as const, label: lstrings.player_stats }
]

/**
 * One player: their face, their name, how they bat and throw, and then what
 * they have actually done.
 *
 * Shaped like a team's page, deliberately — an identity card and a strip of
 * tabs — because they are the same kind of thing and a reader who has learned
 * one has learned the other. The photograph is a circle rather than the team's
 * rounded badge: a face is a circle everywhere else in this app already.
 *
 * The name is whichever one the viewer is entitled to. The server decides and
 * sends one; this screen never has both to choose between.
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
    onOpenMoment
  } = props
  const theme = useTheme()
  const styles = getStyles(theme)

  const [player, setPlayer] = useState<PlayerDetail | undefined>(undefined)
  const [tab, setTab] = useState<'videos' | 'stats'>(initialTab ?? 'videos')
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
        tabs={TABS}
        selected={tab}
        onSelect={next => {
          setTab(next)
          onTab?.(next)
        }}
        size="compact"
        accessibilityLabel={lstrings.player_sections}
      />

      {error != null && <Text style={styles.error}>{error}</Text>}

      {tab === 'videos' && (
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

      {tab === 'stats' && (
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
              <StatGrid stats={battingStats(stats.batting)} columns={4} />
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
              <StatGrid stats={pitchingStats(stats.pitching)} columns={4} />
            </Card>
          )}

          {stats?.pitching == null && stats?.batting != null && (
            <Card>
              <Text style={styles.cardTitle}>{lstrings.player_pitching}</Text>
              <Text style={styles.muted}>{lstrings.player_no_pitching}</Text>
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

/**
 * A batting line as a block of figures.
 *
 * The four that a reader looks for first — average, on-base, slugging, OPS —
 * and then the counts they are made of, so the rate and its workings are on the
 * same card.
 */
function battingStats(line: NonNullable<PlayerStats['batting']>): Stat[] {
  return [
    { label: lstrings.stats_average, value: average(line.rates.avg) },
    { label: lstrings.stats_on_base, value: average(line.rates.obp) },
    { label: lstrings.stats_slugging, value: average(line.rates.slg) },
    { label: lstrings.stats_ops, value: average(line.rates.ops) },
    { label: lstrings.stats_plate_appearances, value: String(line.pa) },
    { label: lstrings.stats_at_bats, value: String(line.ab) },
    { label: lstrings.stats_hits, value: String(line.h) },
    { label: lstrings.stats_home_runs, value: String(line.hr) },
    { label: lstrings.stats_runs, value: String(line.r) },
    { label: lstrings.stats_runs_batted_in, value: String(line.rbi) },
    { label: lstrings.stats_walks, value: String(line.bb) },
    { label: lstrings.stats_strikeouts, value: String(line.k) },
    { label: lstrings.stats_stolen_bases, value: String(line.sb) }
  ]
}

/**
 * And a pitching line.
 *
 * The ERA is missing rather than zero where nobody has worked out how long a
 * game in that league runs — it is earned runs per game, and a figure divided by
 * a guess is worse than no figure.
 */
function pitchingStats(line: NonNullable<PlayerStats['pitching']>): Stat[] {
  return [
    {
      label: lstrings.stats_era,
      value:
        line.rates.era == null
          ? lstrings.stats_no_average
          : line.rates.era.toFixed(2)
    },
    { label: lstrings.stats_innings, value: line.ip },
    { label: lstrings.stats_earned_runs, value: String(line.er) },
    {
      label: lstrings.stats_whip,
      value:
        line.rates.whip == null
          ? lstrings.stats_no_average
          : line.rates.whip.toFixed(2)
    },
    { label: lstrings.stats_games, value: String(line.g) },
    { label: lstrings.stats_hits, value: String(line.h) },
    { label: lstrings.stats_runs, value: String(line.r) },
    { label: lstrings.stats_walks, value: String(line.bb) },
    { label: lstrings.stats_strikeouts, value: String(line.k) },
    { label: lstrings.stats_home_runs, value: String(line.hr) }
  ]
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
