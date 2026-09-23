import React, { useCallback, useEffect, useRef, useState } from 'react'
import { FlatList, Platform, Text, View } from 'react-native'

import type {
  DjBatter,
  DjGame,
  DjSide,
  GameStationClient
} from '../../common/api'
import type { GameSocketEvent } from '../../common/gameSocket'
import type { WalkUpSong } from '../../common/walkUpSong'
import {
  Button,
  FLOATING_BOTTOM_REM,
  NAV_CLEARANCE_REM,
  Screen
} from '../components'
import { navClearanceAboveInset } from '../components/navClearance'
import { lstrings, sprintf } from '../locales/strings'
import { useInsets } from '../platform/safeArea'
import { RosterSelector } from '../scoring/RosterSelector'
import { shortDate } from '../screens/format'
import { cacheStyles, type Theme, useTheme } from '../theme/ThemeContext'
import { DjLineupRow, type RowSong } from './DjLineupRow'
import { useSongPlayer } from './useSongPlayer'
import type { WalkUpMusic } from './walkUpMusicTypes'

export type DjTeamSide = 'away' | 'home'

/** The part of the app's `GameSocket` DJ Game listens on. */
export interface DjSocket {
  readonly connected: boolean
  onStatus: (listener: (connected: boolean) => void) => () => void
  subscribe: (
    gameId: string,
    listener: (event: GameSocketEvent) => void
  ) => () => void
}

export interface DjGameScreenProps {
  client: GameStationClient
  gameId: string
  /** The app's one game socket; without one the screen only polls. */
  socket?: DjSocket
  music: WalkUpMusic
  /** Whether an Apple Music clip fades on the phone's volume. */
  fadeAppleMusic?: boolean
  /** Finds a song on this phone, as a handle `music` plays, or null. */
  resolve?: (
    song: WalkUpSong,
    owner: { teamId: string; userId: string }
  ) => Promise<string | null>
  /** Opens the song picker for one batter on one team. */
  onEditSong?: (
    teamId: string,
    batter: { userId: number; name: string },
    song: WalkUpSong | null
  ) => void
  /**
   * The side showing, when the screen is coming back to one (from the song
   * picker); otherwise it opens on the side the viewer keeps songs for.
   */
  side?: DjTeamSide
  /** Tells the shell which side is showing, so coming back keeps it. */
  onSide?: (side: DjTeamSide) => void
  /** How often to read the game while the socket is down. 10 s. */
  pollMs?: number
}

const POLL_MS = 10_000

/**
 * DJ Game: each team's batters in order, with their walk-up songs one tap
 * away, on a phone.
 *
 * The roster editor's team pill picks the side — the away team's name on the
 * left, the home team's on the right, "Away" and "Home" above them — and the
 * list below is that side's batting order: the game's own lineup as it stands
 * (a pinch hitter the moment the scorer sends him in), the team's default
 * before the game has one, or its players by jersey, each of the last two
 * with a line saying so.
 *
 * It keeps itself current from the game socket: a change to the plays or the
 * lineups reads the list again, a song change patches its row, and a
 * reconnect reads it again in case something was missed. While the socket is
 * down, or the server has failed to subscribe the game and the socket is
 * asking again, it reads every ten seconds instead. An update that arrives while a
 * finger is on the list waits until it lifts, so a row never moves under a
 * tap.
 *
 * One clip plays at a time. Switching sides leaves it playing — the next
 * batter may be on the other team's list — and leaving the screen stops it.
 */
export function DjGameScreen(props: DjGameScreenProps): React.ReactElement {
  const {
    client,
    gameId,
    socket,
    music,
    fadeAppleMusic = true,
    resolve,
    onEditSong,
    onSide,
    pollMs = POLL_MS
  } = props
  const theme = useTheme()
  const styles = getStyles(theme)
  const player = useSongPlayer(music, fadeAppleMusic)
  // The list runs under the floating tabs, and ends clear of them.
  const clearance =
    navClearanceAboveInset(
      Platform.OS,
      theme.rem(NAV_CLEARANCE_REM),
      theme.rem(FLOATING_BOTTOM_REM)
    ) + useInsets().bottom

  const [shown, setShown] = useState<DjGame | undefined>(undefined)
  const [error, setError] = useState(false)
  const [side, setSide] = useState<DjTeamSide | undefined>(props.side)
  const [date, setDate] = useState<string | null>(null)
  const [connected, setConnected] = useState(socket?.connected ?? false)
  /**
   * Set when the server failed to subscribe the game (`internal`): the socket
   * is up but hears nothing for it, so the screen polls until the socket's
   * own retry is answered `subscribed`, and then reads the list once more.
   */
  const [refused, setRefused] = useState(false)
  const [toast, setToast] = useState<string | null>(null)

  /** The newest answer, shown at once unless a finger is down. */
  const latest = useRef<DjGame | undefined>(undefined)
  const touching = useRef(false)
  const live = useRef(true)
  const publish = useCallback((next: DjGame) => {
    latest.current = next
    if (!touching.current) setShown(next)
  }, [])

  const load = useCallback(async (): Promise<void> => {
    try {
      const read = await client.djGame(gameId)
      if (!live.current) return
      setError(false)
      publish(read)
    } catch {
      // A failure with a list showing keeps the list; the next change, poll
      // or reconnect reads it again.
      if (live.current && latest.current == null) setError(true)
    }
  }, [client, gameId, publish])

  // In view: read it, and hear its changes until it goes.
  useEffect(() => {
    live.current = true
    load().catch(() => undefined)
    client
      .game(gameId)
      .then(game => {
        if (live.current) setDate(game.startAt)
      })
      .catch(() => undefined)
    if (socket == null) return
    setConnected(socket.connected)
    setRefused(false)
    // Whether the last answer was a refusal: its polls may all have failed,
    // or missed a change since the last one, so the answer that ends it
    // reads the list once.
    let wasRefused = false
    const stopStatus = socket.onStatus(setConnected)
    const unsubscribe = socket.subscribe(gameId, event => {
      if (event.type === 'error') {
        if (event.code === 'internal') {
          wasRefused = true
          setRefused(true)
        }
        return
      }
      if (event.type === 'subscribed') {
        setRefused(false)
        if (wasRefused) {
          wasRefused = false
          load().catch(() => undefined)
        }
        return
      }
      if (event.type === 'resync') {
        load().catch(() => undefined)
        return
      }
      if (event.type !== 'change') return
      if (event.kind === 'plays' || event.kind === 'lineups') {
        load().catch(() => undefined)
        return
      }
      if (event.kind === 'walkUpSong') {
        const current = latest.current
        if (current == null) return
        const { teamId, userId, song } = event.data
        publish(patchSong(current, teamId, userId, song))
      }
    })
    return () => {
      live.current = false
      stopStatus()
      unsubscribe()
    }
  }, [client, gameId, socket, load, publish])

  // Polls only while the socket is down, or not subscribed after a failure.
  useEffect(() => {
    if (connected && !refused) return
    const timer = setInterval(() => {
      load().catch(() => undefined)
    }, pollMs)
    return () => {
      clearInterval(timer)
    }
  }, [connected, refused, load, pollMs])

  // The toast goes by itself.
  useEffect(() => {
    if (toast == null) return
    const timer = setTimeout(() => {
      setToast(null)
    }, 2500)
    return () => {
      clearTimeout(timer)
    }
  }, [toast])

  // Where each song is on this phone, looked for once per song.
  const [found, setFound] = useState<Record<string, RowSong>>({})
  const asked = useRef(new Set<string>())
  useEffect(() => {
    if (shown == null || !music.available) return
    for (const which of ['away', 'home'] as const) {
      const team = shown[which]
      for (const batter of team.batters) {
        const tune = batter.walkUpSong
        if (tune == null || batter.userId == null) continue
        const key = songKey(team.teamId, batter.userId, tune)
        if (asked.current.has(key)) continue
        asked.current.add(key)
        if (resolve == null) {
          setFound(held => ({ ...held, [key]: 'missing' }))
          continue
        }
        resolve(tune, { teamId: team.teamId, userId: String(batter.userId) })
          .then(handle => {
            setFound(held => ({
              ...held,
              [key]: handle == null ? 'missing' : { handle }
            }))
          })
          .catch(() => {
            setFound(held => ({ ...held, [key]: 'missing' }))
          })
      }
    }
  }, [shown, music.available, resolve])

  const release = (): void => {
    touching.current = false
    if (latest.current != null && latest.current !== shown) {
      setShown(latest.current)
    }
  }

  if (shown == null) {
    return (
      <Screen>
        <View style={styles.centre}>
          {error ? (
            <>
              <Text style={styles.error}>{lstrings.dj_cannot_load}</Text>
              <Button
                label={lstrings.dj_retry}
                onPress={() => {
                  setError(false)
                  load().catch(() => undefined)
                }}
              />
            </>
          ) : (
            <Text style={styles.muted}>{lstrings.player_loading}</Text>
          )}
        </View>
      </Screen>
    )
  }

  const showing: DjTeamSide = side ?? startingSide(shown)
  const team: DjSide = shown[showing]
  const note =
    team.source === 'default'
      ? lstrings.dj_note_default
      : team.source === 'roster'
        ? lstrings.dj_note_roster
        : null

  const header = (
    <View style={styles.header}>
      <Text style={styles.matchup} numberOfLines={1}>
        {sprintf(lstrings.dj_matchup, shown.away.teamName, shown.home.teamName)}
      </Text>
      {date != null && <Text style={styles.muted}>{shortDate(date)}</Text>}
      <RosterSelector
        labels={[shown.away.teamName, shown.home.teamName]}
        captions={['Away', 'Home']}
        accessibilityLabels={['Away Team', 'Home Team']}
        value={showing === 'away' ? 0 : 1}
        onChange={index => {
          const next = index === 0 ? 'away' : 'home'
          setSide(next)
          onSide?.(next)
        }}
      />
      {note != null && (
        <Text style={styles.muted} testID="DJ source note">
          {note}
        </Text>
      )}
    </View>
  )

  return (
    <Screen scroll={false} contentStyle={styles.column}>
      <View
        testID="DJ list"
        style={styles.fill}
        onTouchStart={() => {
          touching.current = true
        }}
        onTouchEnd={release}
        onTouchCancel={release}
      >
        <FlatList
          data={team.batters}
          keyExtractor={(batter, index) =>
            `${showing}:${index}:${batter.userId ?? batter.name}`
          }
          ListHeaderComponent={header}
          ListEmptyComponent={
            <Text style={styles.muted}>{lstrings.dj_empty}</Text>
          }
          ItemSeparatorComponent={Gap}
          contentContainerStyle={[styles.list, { paddingBottom: clearance }]}
          renderItem={({ item: batter }) => {
            const tune = batter.walkUpSong
            const key =
              tune == null || batter.userId == null
                ? ''
                : songKey(team.teamId, batter.userId, tune)
            const rowKey = `${team.teamId}:${batter.userId ?? batter.name}`
            const userId = batter.userId
            return (
              <DjLineupRow
                batter={batter}
                song={found[key] ?? (resolve == null ? 'missing' : 'resolving')}
                playing={player.playing === rowKey}
                onEdit={
                  team.canEditWalkUp && userId != null && onEditSong != null
                    ? () => {
                        onEditSong(
                          team.teamId,
                          { userId, name: batter.name },
                          tune
                        )
                      }
                    : undefined
                }
                onPlay={() => {
                  const where = found[key]
                  if (
                    tune == null ||
                    where == null ||
                    typeof where !== 'object'
                  )
                    return
                  player.toggle({
                    key: rowKey,
                    handle: where.handle,
                    provider: tune.provider,
                    startMs: tune.startMs,
                    endMs: tune.endMs
                  })
                }}
                onMissing={() => {
                  if (tune != null)
                    setToast(sprintf(lstrings.dj_not_here, tune.title))
                }}
              />
            )
          }}
        />
      </View>
      {toast != null && (
        <View
          style={[styles.toast, { bottom: clearance + 8 }]}
          pointerEvents="none"
          testID="DJ toast"
        >
          <Text style={styles.toastText}>{toast}</Text>
        </View>
      )}
    </Screen>
  )
}

function Gap(): React.ReactElement {
  return <View style={{ height: 8 }} />
}

/** The side the viewer keeps songs for, and Home for both or neither. */
function startingSide(game: DjGame): DjTeamSide {
  return game.away.canEditWalkUp && !game.home.canEditWalkUp ? 'away' : 'home'
}

function songKey(teamId: string, userId: number, song: WalkUpSong): string {
  return `${teamId}:${userId}:${song.provider}:${song.providerId}`
}

/** The game with one player's song on one team changed, or removed. */
function patchSong(
  game: DjGame,
  teamId: string,
  userId: number,
  song: WalkUpSong | null
): DjGame {
  const side = (team: DjSide): DjSide =>
    team.teamId !== teamId
      ? team
      : {
          ...team,
          batters: team.batters.map((batter): DjBatter =>
            batter.userId === userId ? { ...batter, walkUpSong: song } : batter
          )
        }
  return { away: side(game.away), home: side(game.home) }
}

const getStyles = cacheStyles((theme: Theme) => ({
  // The list runs to the column's edges and keeps its own 16 px gutters, so
  // the rows' shadows are not clipped by the scroll view at the sides.
  column: {
    flex: 1,
    paddingLeft: 0,
    paddingRight: 0,
    paddingTop: 0,
    paddingBottom: 0
  },
  fill: {
    flex: 1
  },
  list: {
    paddingHorizontal: 16,
    paddingTop: 12
  },
  header: {
    gap: 8,
    paddingTop: 8,
    paddingBottom: 12
  },
  matchup: {
    fontFamily: theme.semiBoldTextFont,
    fontWeight: '600',
    fontSize: theme.rem(1.25),
    color: theme.primaryTextColor
  },
  muted: {
    fontFamily: theme.regularTextFont,
    fontSize: theme.rem(0.875),
    color: theme.secondaryTextColor
  },
  error: {
    fontFamily: theme.regularTextFont,
    fontSize: theme.rem(0.9375),
    color: theme.dangerColor
  },
  centre: {
    alignItems: 'center',
    gap: 12,
    paddingTop: 24
  },
  toast: {
    position: 'absolute',
    left: 16,
    right: 16,
    borderRadius: 12,
    paddingVertical: 10,
    paddingHorizontal: 16,
    backgroundColor: theme.primaryTextColor
  },
  toastText: {
    fontFamily: theme.regularTextFont,
    fontSize: theme.rem(0.875),
    color: theme.backgroundColor
  }
}))
