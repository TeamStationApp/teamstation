import React, { useEffect, useRef, useState } from 'react'
import {
  AppState,
  type GestureResponderEvent,
  Linking,
  Platform,
  Pressable,
  Text,
  View
} from 'react-native'

import type { TeamStationClient } from '../../common/api'
import type { WalkUpSong } from '../../common/walkUpSong'
import {
  Button,
  Card,
  Emblem,
  Icon,
  ListRow,
  Screen,
  TextField
} from '../components'
import { useBackOverride } from '../components/headerSlot'
import { lstrings } from '../locales/strings'
import { cacheStyles, type Theme, useTheme } from '../theme/ThemeContext'
import { AppleGlyph } from './AppleGlyph'
import {
  type Clip,
  clipValid,
  defaultClip,
  fitClip,
  formatLength,
  formatTenths,
  msAt,
  placeClip
} from './clipModel'
import { JogWheel } from './JogWheel'
import { type DeviceLinks, deviceLinks } from './resolveSong'
import { type ClipRequest, useSongPlayer } from './useSongPlayer'
import { useSongSearch } from './useSongSearch'
import type {
  MusicAccess,
  SongCandidate,
  WalkUpMusic
} from './walkUpMusicTypes'

export interface WalkUpSongScreenProps {
  client: TeamStationClient
  music: WalkUpMusic
  teamId: string
  userId: string
  /** The song there is now: Change opens on its clip. */
  song: WalkUpSong | null
  /** Finds the song there is now on this phone, to preview it. */
  resolve: (song: WalkUpSong) => Promise<string | null>
  /** Apple Music fades on the phone's volume only while this is on. */
  fadeAppleMusic?: boolean
  links?: DeviceLinks
  openSettings?: () => void
  /** After a save: the stored song. */
  onSaved: (song: WalkUpSong) => void
}

/** The song being clipped: what will be stored, and how to play it here. */
interface Chosen {
  song: Omit<WalkUpSong, 'startMs' | 'endMs'>
  /** Null when it is not on this phone; undefined while that is asked. */
  handle: string | null | undefined
  /** An Android file, whose content address is kept as the device link. */
  onDevice: boolean
}

type Access = MusicAccess | 'checking'

/**
 * Choosing a player's walk-up song, on a phone, in two steps.
 *
 * **Search** Apple Music and the library on an iPhone, the music files on an
 * Android phone — which also offers **Choose a file…**, the system picker,
 * for music the search cannot see. Refused access says so and offers the
 * phone's Settings, and the answer is asked again on the way back.
 *
 * **Clip**: fifteen seconds of the song, on a timeline, with its Start and
 * End and the Play button above it, where a thumb on the timeline cannot
 * cover them. The window slides as one piece, and the jog wheel under the
 * timeline slides it a quarter as fast, for setting it finely. Play starts at the window and runs to its end, with the
 * same fades as a walk-up in a game, and Stop is that same button until
 * the clip ends. Dragging the window while it plays starts again from the
 * new place on release. Save stores it for the player on this team, keeps
 * an Android file's address on this phone, and goes back; a failed save
 * stays, and says why. Pick another song returns here on the header's back.
 */
export function WalkUpSongScreen(
  props: WalkUpSongScreenProps
): React.ReactElement {
  const {
    client,
    music,
    teamId,
    userId,
    song,
    resolve,
    fadeAppleMusic = true,
    links = deviceLinks,
    openSettings = () => {
      Linking.openSettings().catch(() => undefined)
    },
    onSaved
  } = props
  const theme = useTheme()
  const styles = getStyles(theme)
  const android = Platform.OS === 'android'

  const [access, setAccess] = useState<Access>('checking')
  const [chosen, setChosen] = useState<Chosen | null>(
    song == null
      ? null
      : {
          song: withoutClip(song),
          handle: undefined,
          onDevice: false
        }
  )
  const [timelineWidth, setTimelineWidth] = useState(0)
  const [clip, setClip] = useState<Clip | null>(
    song == null ? null : fitClip(song, song.durationMs)
  )
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const search = useSongSearch(music, access === 'authorized')
  const player = useSongPlayer(music, fadeAppleMusic)
  const stopPlayer = player.stop
  const playing = player.playing
  const playingRef = useRef(playing)
  playingRef.current = playing
  // The clip we left to search for a different song. The header's back
  // returns to it; a back with nothing held leaves the screen.
  const held = useRef<{ chosen: Chosen; clip: Clip } | null>(null)
  useBackOverride(chosen == null && held.current != null, () => {
    const previous = held.current
    if (previous == null) return
    held.current = null
    setError(null)
    setChosen(previous.chosen)
    setClip(previous.clip)
  })

  // Access is asked on arrival, and again whenever the app comes back to the
  // front, which is how an answer changed in Settings arrives.
  useEffect(() => {
    let live = true
    const ask = (): void => {
      music
        .access()
        .then(answer => {
          if (live) setAccess(answer)
        })
        .catch(() => {
          if (live) setAccess('unavailable')
        })
    }
    ask()
    const subscription = AppState.addEventListener('change', state => {
      if (state === 'active') ask()
    })
    return () => {
      live = false
      subscription.remove()
    }
  }, [music])

  // The song there is now is found on this phone, to preview it: once per
  // song, whatever function the parent hands in on each render.
  const resolveRef = useRef(resolve)
  resolveRef.current = resolve
  useEffect(() => {
    if (song == null) return
    let live = true
    resolveRef
      .current(song)
      .catch(() => null)
      .then(handle => {
        if (!live) return
        setChosen(current =>
          current?.song.providerId === song.providerId &&
          current.handle === undefined
            ? { ...current, handle }
            : current
        )
      })
      .catch(() => undefined)
    return () => {
      live = false
    }
  }, [song])

  const choose = (candidate: SongCandidate): void => {
    held.current = null
    stopPlayer(0)
    setError(null)
    setChosen({
      song: withoutClip(candidate),
      handle: candidate.handle,
      onDevice: candidate.source === 'device'
    })
    setClip(defaultClip(candidate.durationMs))
  }

  const pickFile = (): void => {
    setError(null)
    music
      .pickFile()
      .then(picked => {
        if (picked != null) choose(picked)
      })
      .catch((caught: unknown) => {
        setError(messageOf(caught, lstrings.walkup_unavailable))
      })
  }

  const save = (): void => {
    if (chosen == null || clip == null) return
    stopPlayer(0)
    setSaving(true)
    setError(null)
    const next: WalkUpSong = { ...chosen.song, ...clip }
    client
      .setWalkUpSong(teamId, userId, next)
      .then(async saved => {
        if (chosen.onDevice && chosen.handle != null) {
          await links
            .write({ teamId, userId }, saved.providerId, chosen.handle)
            .catch(() => undefined)
        }
        onSaved(saved)
      })
      .catch((caught: unknown) => {
        setSaving(false)
        setError(messageOf(caught, lstrings.walkup_cannot_save))
      })
  }

  if (chosen != null && clip != null) {
    const durationMs = chosen.song.durationMs
    const request = (key: string, part: Clip): ClipRequest | null =>
      chosen.handle == null
        ? null
        : {
            key,
            handle: chosen.handle,
            provider: chosen.song.provider,
            ...part
          }
    const clipPlaying = playing === 'clip'
    // Moving the window while it plays starts it again from the new place,
    // whether the timeline or the wheel moved it.
    const commit = (next: Clip): void => {
      if (playingRef.current == null || chosen.handle == null) return
      player.play({
        key: 'clip',
        handle: chosen.handle,
        provider: chosen.song.provider,
        ...next
      })
    }
    return (
      <Screen>
        <Card style={styles.card}>
          <View style={styles.song}>
            <Emblem
              uri={chosen.song.artworkUrl}
              fallback=""
              icon="music_note"
              size={4}
            />
            <View style={styles.songText}>
              <Text style={styles.title} numberOfLines={2}>
                {chosen.song.title}
              </Text>
              <Text style={styles.meta} numberOfLines={1}>
                {byline(chosen.song)}
              </Text>
              <Text style={styles.meta}>{formatLength(durationMs)}</Text>
            </View>
          </View>

          <View style={styles.times}>
            <View style={styles.readouts}>
              {(['start', 'end'] as const).map(handle => (
                <View key={handle} style={styles.readoutRow}>
                  <Text style={styles.readoutLabel}>
                    {handle === 'start'
                      ? lstrings.walkup_start
                      : lstrings.walkup_end}
                  </Text>
                  <Text style={styles.readout} testID={`walkup-${handle}`}>
                    {formatTenths(
                      handle === 'start' ? clip.startMs : clip.endMs
                    )}
                  </Text>
                </View>
              ))}
            </View>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={
                chosen.handle === null
                  ? lstrings.player_walkup_not_here
                  : clipPlaying
                    ? lstrings.player_walkup_stop
                    : lstrings.walkup_play
              }
              accessibilityState={{ disabled: chosen.handle == null }}
              disabled={chosen.handle == null}
              style={[styles.play, chosen.handle == null && styles.playDimmed]}
              onPress={() => {
                if (chosen.handle == null) return
                if (clipPlaying) {
                  player.stop(0)
                  return
                }
                const next = request('clip', clip)
                if (next != null) player.play(next)
              }}
            >
              <TransportMark
                playing={clipPlaying}
                color={theme.primaryTextColor}
              />
            </Pressable>
          </View>
          <Timeline
            clip={clip}
            durationMs={durationMs}
            onChange={setClip}
            onCommit={commit}
            onWidth={setTimelineWidth}
            styles={styles}
          />

          <JogWheel
            clip={clip}
            durationMs={durationMs}
            timelineWidth={timelineWidth}
            onChange={setClip}
            onCommit={commit}
          />

          {player.error != null && (
            <Text style={styles.error}>{player.error}</Text>
          )}

          <Button
            label={lstrings.walkup_save}
            block
            busy={saving}
            disabled={!clipValid(clip, durationMs)}
            onPress={save}
          />
          {error != null && <Text style={styles.error}>{error}</Text>}
          <Button
            label={lstrings.walkup_pick_another}
            kind="text"
            onPress={() => {
              held.current = { chosen, clip }
              stopPlayer(0)
              setError(null)
              setChosen(null)
              setClip(null)
            }}
          />
        </Card>
      </Screen>
    )
  }

  return (
    <Screen>
      {access === 'checking' ? (
        <Card>
          <Text style={styles.meta}>{lstrings.walkup_checking}</Text>
        </Card>
      ) : access !== 'authorized' ? (
        <Card style={styles.card}>
          <Text style={styles.title}>
            {access === 'unavailable'
              ? lstrings.walkup_unavailable
              : access === 'restricted'
                ? lstrings.walkup_restricted
                : lstrings.walkup_denied}
          </Text>
          {access === 'denied' && (
            <Text style={styles.meta}>
              {android
                ? lstrings.walkup_denied_android
                : lstrings.walkup_denied_ios}
            </Text>
          )}
          {access !== 'unavailable' && (
            <Button
              label={lstrings.walkup_open_settings}
              block
              onPress={openSettings}
            />
          )}
        </Card>
      ) : (
        <Card style={styles.card}>
          <TextField
            label={lstrings.walkup_search}
            value={search.term}
            onChangeText={text => {
              search.setTerm(text)
            }}
            placeholder={
              android
                ? lstrings.walkup_search_device
                : lstrings.walkup_search_apple
            }
          />
          <Text style={styles.licence}>{lstrings.walkup_licence}</Text>
          {android && (
            <ListRow
              title={lstrings.walkup_choose_file}
              emblemIcon="music_note"
              onPress={pickFile}
            />
          )}
          {error != null && <Text style={styles.error}>{error}</Text>}
          {search.status === 'searching' && (
            <Text style={styles.meta}>{lstrings.walkup_searching}</Text>
          )}
          {search.status === 'done' && search.results.length === 0 && (
            <Text style={styles.meta}>{lstrings.walkup_no_match}</Text>
          )}
          {search.status === 'error' && (
            <View style={styles.card}>
              <Text style={styles.error}>{search.error}</Text>
              <Button
                label={lstrings.walkup_retry}
                kind="secondary"
                onPress={() => {
                  search.retry()
                }}
              />
            </View>
          )}
          {search.status === 'done' &&
            search.results.map(candidate => (
              <ListRow
                key={`${candidate.source}:${candidate.handle}`}
                title={candidate.title}
                subtitle={byline(candidate)}
                emblemIcon="music_note"
                emblemUri={candidate.artworkUrl}
                end={<SongSource source={candidate.source} />}
                onPress={() => {
                  choose(candidate)
                }}
              />
            ))}
        </Card>
      )}
    </Screen>
  )
}

interface TimelineProps {
  clip: Clip
  durationMs: number
  onChange: (clip: Clip) => void
  /** After the finger lifts, when a drag actually moved the window. */
  onCommit?: (clip: Clip) => void
  /** Its laid-out width, which the jog wheel's rate is a quarter of. */
  onWidth?: (width: number) => void
  styles: ReturnType<typeof getStyles>
}

/**
 * The song's length, full width, with a fifteen-second window on it.
 * Dragging slides that whole window. The ends stay a fixed distance apart.
 */
function Timeline(props: TimelineProps): React.ReactElement {
  const { clip, durationMs, onChange, onCommit, onWidth, styles } = props
  const width = useRef(0)
  const origin = useRef({ startMs: 0, at: 0 })
  const latest = useRef(clip)
  latest.current = clip
  const commitRef = useRef(onCommit)
  commitRef.current = onCommit

  const at = (event: GestureResponderEvent): number =>
    msAt(event.nativeEvent.locationX, width.current, durationMs)
  const placed = (event: GestureResponderEvent): Clip =>
    placeClip(
      origin.current.startMs + (at(event) - origin.current.at),
      durationMs
    )
  const left = `${(100 * clip.startMs) / durationMs}%` as const
  const right = `${100 - (100 * clip.endMs) / durationMs}%` as const

  return (
    <View
      style={styles.timeline}
      testID="walkup-timeline"
      onLayout={event => {
        width.current = event.nativeEvent.layout.width
        onWidth?.(width.current)
      }}
      onStartShouldSetResponder={() => true}
      onMoveShouldSetResponder={() => true}
      onResponderTerminationRequest={() => false}
      onResponderGrant={event => {
        origin.current = { startMs: latest.current.startMs, at: at(event) }
      }}
      onResponderMove={event => {
        onChange(placed(event))
      }}
      onResponderRelease={event => {
        const next = placed(event)
        onChange(next)
        commitRef.current?.(next)
      }}
    >
      <View style={styles.track} pointerEvents="none" />
      <View style={[styles.range, { left, right }]} pointerEvents="none" />
      <View style={[styles.handle, { left }]} pointerEvents="none" />
      <View style={[styles.handle, { right }]} pointerEvents="none" />
    </View>
  )
}

function withoutClip(
  song: WalkUpSong | SongCandidate
): Omit<WalkUpSong, 'startMs' | 'endMs'> {
  return {
    provider: song.provider,
    providerId: song.providerId,
    isrc: song.isrc,
    title: song.title,
    artist: song.artist,
    album: song.album,
    artworkUrl: song.artworkUrl,
    durationMs: song.durationMs
  }
}

function byline(song: { artist: string; album: string | null }): string {
  return song.album == null ? song.artist : `${song.artist} · ${song.album}`
}

/** A play triangle, or a stop square, with no button around it. */
function TransportMark(props: {
  playing: boolean
  color: string
}): React.ReactElement {
  const theme = useTheme()
  const side = theme.rem(2.25)
  if (props.playing) {
    const box = theme.rem(1.5)
    return (
      <View
        style={{
          width: box,
          height: box,
          backgroundColor: props.color
        }}
      />
    )
  }
  return (
    <View
      style={{
        width: 0,
        height: 0,
        borderStyle: 'solid',
        borderTopWidth: side / 2,
        borderBottomWidth: side / 2,
        borderLeftWidth: side * 0.86,
        borderTopColor: 'transparent',
        borderBottomColor: 'transparent',
        borderLeftColor: props.color
      }}
    />
  )
}

/** Apple Music is a fruit, flat and gray. A file on the phone is a page. */
function SongSource(props: {
  source: SongCandidate['source']
}): React.ReactElement {
  const theme = useTheme()
  const file = props.source === 'device'
  const label =
    props.source === 'catalog'
      ? lstrings.walkup_badge_catalog
      : props.source === 'library'
        ? lstrings.walkup_badge_library
        : lstrings.walkup_badge_device
  const color = theme.secondaryTextColor
  return (
    <View accessible accessibilityLabel={label}>
      {file ? (
        <Icon name="description" size={1.35} color={color} />
      ) : (
        <AppleGlyph size={theme.rem(1.35)} color={color} />
      )}
    </View>
  )
}

function messageOf(caught: unknown, fallback: string): string {
  return caught instanceof Error && caught.message !== ''
    ? caught.message
    : fallback
}

const HANDLE_REM = 1.5

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
  licence: {
    fontFamily: theme.regularTextFont,
    fontSize: theme.rem(0.75),
    color: theme.tertiaryTextColor
  },
  timeline: {
    height: theme.rem(3),
    marginHorizontal: theme.rem(HANDLE_REM / 2),
    justifyContent: 'center'
  },
  track: {
    height: theme.rem(0.375),
    borderRadius: theme.radiusPill,
    backgroundColor: theme.defaultBorderColor
  },
  range: {
    position: 'absolute',
    height: theme.rem(0.375),
    borderRadius: theme.radiusPill,
    backgroundColor: theme.scoreboardAccentColor
  },
  handle: {
    position: 'absolute',
    width: theme.rem(HANDLE_REM),
    height: theme.rem(HANDLE_REM),
    marginHorizontal: -theme.rem(HANDLE_REM / 2),
    borderRadius: theme.radiusPill,
    backgroundColor: theme.primaryButtonColor
  },
  readoutRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: theme.rem(theme.spaceSmRem)
  },
  readoutLabel: {
    width: theme.rem(3),
    fontFamily: theme.semiBoldTextFont,
    fontSize: theme.rem(0.875),
    fontWeight: '600',
    color: theme.primaryTextColor
  },
  readout: {
    flex: 1,
    fontFamily: theme.regularTextFont,
    fontSize: theme.rem(1),
    color: theme.primaryTextColor
  },
  times: {
    flexDirection: 'row',
    alignItems: 'stretch',
    gap: theme.rem(theme.spaceMdRem)
  },
  readouts: {
    flex: 1,
    justifyContent: 'center',
    gap: theme.rem(theme.spaceSmRem)
  },
  play: {
    alignSelf: 'stretch',
    justifyContent: 'center',
    alignItems: 'center',
    minWidth: theme.rem(3),
    paddingHorizontal: theme.rem(0.5)
  },
  playDimmed: {
    opacity: 0.4
  },
  error: {
    fontFamily: theme.regularTextFont,
    fontSize: theme.rem(0.875),
    color: theme.dangerColor
  }
}))
