import React, { useEffect, useMemo, useState } from 'react'
import { Text, View } from 'react-native'

import type {
  GameStationClient,
  PlayerDetail,
  PlayerHighlight
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
  useHandoff,
  useHeaderHandoff,
  useHeaderSlot
} from '../components'
import { lstrings } from '../locales/strings'
import { cacheStyles, type Theme, useTheme } from '../theme/ThemeContext'
import { battingLine, exactDateTime } from './format'

export interface PlayerScreenProps {
  client: GameStationClient
  userId: string
  /** The name the row that was tapped showed, so the header has one at once. */
  title?: string
  /** Which tab to open on, from the address. */
  initialTab?: 'videos' | 'stats'
  onTab?: (tab: 'videos' | 'stats', correcting?: boolean) => void
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
  const { client, userId, title, initialTab, onTab, onOpenMoment } = props
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
        <Card>
          <Text style={styles.muted}>{lstrings.player_stats_empty}</Text>
        </Card>
      )}
    </Screen>
  )
}

const getStyles = cacheStyles((theme: Theme) => ({
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
