import React, { useEffect, useRef, useState } from 'react'
import { Text, View } from 'react-native'

import type { GameStationClient } from '../../common/api'
import { formatClip, type WalkUpSong } from '../../common/walkUpSong'
import { Button, Card, Emblem } from '../components'
import { lstrings, sprintf } from '../locales/strings'
import { cacheStyles, type Theme, useTheme } from '../theme/ThemeContext'
import { clipFade } from './useSongPlayer'
import type { WalkUpMusic } from './walkUpMusicTypes'

export interface WalkUpTabProps {
  client: GameStationClient
  /** The team the page was opened for: whose walk-up song this is. */
  teamId: string
  userId: string
  /** The phone's music, or the web's adapter, which has none. */
  music: WalkUpMusic
  /**
   * Finds the song on this phone, as a handle `music` can play, or null
   * when it is not here. Without it nothing is ever found, and Preview says
   * so.
   */
  resolve?: (song: WalkUpSong) => Promise<string | null>
  /** Opens the song picker, on the song there is now, if any. */
  onPick?: (song: WalkUpSong | null) => void
  /**
   * Whether an Apple Music preview fades, on the phone's volume (the Account
   * screen's setting); files always fade. On by default.
   */
  fadeAppleMusic?: boolean
}

/**
 * A player's walk-up song on one team, for a songkeeper of that team.
 *
 * The song is the artwork — or a music note for a file, which has none that
 * travels — its title, artist and the part of it that plays, and where it
 * comes from. It is read from the team's roster, like the Settings tab's
 * values, so the page opened from a link needs nothing handed to it.
 *
 * Songs are chosen and played on a phone, because that is where the music
 * is. On a phone the tab offers Set or Change, Preview and Remove; on the
 * web it shows the song and says where to change it, and offers nothing
 * that would fail.
 */
export function WalkUpTab(props: WalkUpTabProps): React.ReactElement {
  const {
    client,
    teamId,
    userId,
    music,
    resolve,
    onPick,
    fadeAppleMusic = true
  } = props
  const theme = useTheme()
  const styles = getStyles(theme)
  const onPhone = music.available

  /** Undefined while the roster is being read. */
  const [song, setSong] = useState<WalkUpSong | null | undefined>(undefined)
  const [loadError, setLoadError] = useState<string | undefined>(undefined)
  const [error, setError] = useState<string | undefined>(undefined)
  const [busy, setBusy] = useState(false)
  const [armed, setArmed] = useState(false)
  /** The handle Preview plays, null when the song is not on this phone. */
  const [handle, setHandle] = useState<string | null | undefined>(undefined)
  const [playing, setPlaying] = useState(false)
  const playingRef = useRef(false)

  useEffect(() => {
    let cancelled = false
    setSong(undefined)
    setLoadError(undefined)
    client
      .roster(teamId)
      .then(roster => {
        if (cancelled) return
        const entry = roster.find(
          row => String(row.userId) === userId && row.isPlayer
        )
        if (entry == null) {
          setLoadError(lstrings.player_settings_not_on_team)
          return
        }
        setSong(entry.walkUpSong)
      })
      .catch(() => {
        if (!cancelled) setLoadError(lstrings.player_walkup_cannot_load)
      })
    return () => {
      cancelled = true
    }
  }, [client, teamId, userId])

  // Where the song is on this phone, asked again whenever the song changes.
  // A failed search is the same answer as an empty one: not here.
  useEffect(() => {
    setHandle(undefined)
    if (!onPhone || song == null) return
    if (resolve == null) {
      setHandle(null)
      return
    }
    let cancelled = false
    resolve(song)
      .then(found => {
        if (!cancelled) setHandle(found)
      })
      .catch(() => {
        if (!cancelled) setHandle(null)
      })
    return () => {
      cancelled = true
    }
  }, [onPhone, resolve, song])

  // The clip stops on its own at its end, and reports it; and leaving the
  // page stops it, because a song still playing from a page nobody can see
  // has no button left to stop it with.
  useEffect(() => {
    if (!onPhone) return
    const unsubscribe = music.onState(state => {
      if (state.kind === 'playing') return
      playingRef.current = false
      setPlaying(false)
      if (state.kind === 'error') setError(state.message)
    })
    return () => {
      unsubscribe()
      if (playingRef.current) music.stop(0).catch(() => undefined)
    }
  }, [music, onPhone])

  if (loadError != null) {
    return (
      <Card>
        <Text style={styles.error}>{loadError}</Text>
      </Card>
    )
  }
  if (song === undefined) {
    return (
      <Card>
        <Text style={styles.muted}>{lstrings.player_loading}</Text>
      </Card>
    )
  }

  const preview = (): void => {
    if (song == null || handle == null) return
    setError(undefined)
    if (playing) {
      playingRef.current = false
      setPlaying(false)
      music.stop(0).catch(() => undefined)
      return
    }
    playingRef.current = true
    setPlaying(true)
    music
      .play(
        handle,
        song.startMs,
        song.endMs,
        clipFade(song.provider, fadeAppleMusic, song.startMs)
      )
      .catch((caught: unknown) => {
        playingRef.current = false
        setPlaying(false)
        setError(caught instanceof Error ? caught.message : String(caught))
      })
  }

  const remove = (): void => {
    if (!armed) {
      setArmed(true)
      return
    }
    setArmed(false)
    setBusy(true)
    setError(undefined)
    client
      .clearWalkUpSong(teamId, userId)
      .then(() => {
        setSong(null)
      })
      .catch((caught: unknown) => {
        setError(
          caught instanceof Error && caught.message !== ''
            ? caught.message
            : lstrings.player_walkup_cannot_remove
        )
      })
      .finally(() => {
        setBusy(false)
      })
  }

  return (
    <Card style={styles.card}>
      {song == null ? (
        <Text style={styles.muted}>{lstrings.player_walkup_none}</Text>
      ) : (
        <View style={styles.song}>
          <Emblem
            uri={song.provider === 'appleMusic' ? song.artworkUrl : null}
            fallback=""
            icon="music_note"
            size={4}
          />
          <View style={styles.songText}>
            <Text style={styles.title} numberOfLines={2}>
              {song.title}
            </Text>
            <Text style={styles.meta} numberOfLines={1}>
              {song.artist}
            </Text>
            <Text style={styles.meta}>
              {sprintf(lstrings.player_walkup_clip, formatClip(song))}
            </Text>
            <Text style={styles.provider}>
              {song.provider === 'appleMusic'
                ? lstrings.player_walkup_apple_music
                : lstrings.player_walkup_local_file}
            </Text>
          </View>
        </View>
      )}

      {!onPhone && (
        <Text style={styles.muted}>{lstrings.player_walkup_web_note}</Text>
      )}

      {onPhone && (
        <View style={styles.actions}>
          {onPick != null && (
            <Button
              label={
                song == null
                  ? lstrings.player_walkup_set
                  : lstrings.player_walkup_change
              }
              disabled={busy}
              onPress={() => {
                onPick(song)
              }}
            />
          )}
          {song != null && (
            <Button
              label={
                handle === null
                  ? lstrings.player_walkup_not_here
                  : playing
                    ? lstrings.player_walkup_stop
                    : lstrings.player_walkup_preview
              }
              accessibilityLabel={
                handle === null
                  ? `${lstrings.player_walkup_preview}: ${lstrings.player_walkup_not_here}`
                  : undefined
              }
              kind="secondary"
              disabled={handle == null}
              onPress={preview}
            />
          )}
          {song != null && (
            <Button
              label={
                armed
                  ? lstrings.player_walkup_remove_confirm
                  : lstrings.player_walkup_remove
              }
              kind="secondary"
              disabled={busy}
              onPress={remove}
            />
          )}
        </View>
      )}

      {error != null && <Text style={styles.error}>{error}</Text>}
    </Card>
  )
}

const getStyles = cacheStyles((theme: Theme) => ({
  card: {
    gap: theme.rem(theme.spaceMdRem)
  },
  song: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: theme.rem(theme.spaceMdRem)
  },
  songText: {
    flex: 1,
    gap: theme.rem(0.125)
  },
  title: {
    fontFamily: theme.semiBoldTextFont,
    fontSize: theme.rem(1.0625),
    fontWeight: '600',
    color: theme.primaryTextColor
  },
  meta: {
    fontFamily: theme.regularTextFont,
    fontSize: theme.rem(0.875),
    color: theme.secondaryTextColor
  },
  provider: {
    fontFamily: theme.regularTextFont,
    fontSize: theme.rem(0.75),
    color: theme.tertiaryTextColor
  },
  actions: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: theme.rem(theme.spaceSmRem)
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
