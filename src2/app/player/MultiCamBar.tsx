import React, { useRef } from 'react'
import { Pressable, Text, View } from 'react-native'

import { lstrings, sprintf } from '../locales/strings'
import { cacheStyles, type Theme, useTheme } from '../theme/ThemeContext'
import type { Window } from './wallClock'

export interface BarAngle {
  id: string
  name: string
  /** The stretch of wall-clock time this camera actually covers. */
  fromMs: number
  toMs: number
  /** True while this is the one being heard. */
  audio: boolean
}

export interface MultiCamBarProps {
  window: Window
  atMs: number
  playing: boolean
  angles: BarAngle[]
  onTogglePlay: () => void
  onSkip: (deltaSec: number) => void
  onScrub: (wallMs: number) => void
  onPickAudio: (id: string) => void
  onClose: () => void
}

/**
 * The controls, drawn on the game's own clock.
 *
 * Not on any one tile's timeline, which is the thing that makes four
 * recordings of unequal length possible to sit in front of. The bar is the
 * stretch of wall-clock time the take covers, each camera draws the part of it
 * that camera was running for, and the playhead is an instant rather than a
 * position — so a camera that started three minutes late reads as a strip that
 * begins three minutes in, and scrubbing before it simply lands in a part of
 * the game it was not there for.
 *
 * Four `<video>` elements cannot wear the browser's own controls: that is four
 * scrubbers and four fullscreen buttons over one picture. So this is ours, and
 * with it goes the accessibility the native controls brought — hence the roles
 * and labels on everything here.
 */
export function MultiCamBar(props: MultiCamBarProps): React.ReactElement {
  const {
    window: take,
    atMs,
    playing,
    angles,
    onTogglePlay,
    onSkip,
    onScrub,
    onPickAudio,
    onClose
  } = props
  const theme = useTheme()
  const styles = getStyles(theme)
  const span = Math.max(1, take.toMs - take.fromMs)
  const fraction = (ms: number): number =>
    Math.min(1, Math.max(0, (ms - take.fromMs) / span))

  /**
   * Where in the take a press on the track landed.
   *
   * Measured off the element itself rather than out of a React Native press
   * event: the press event carries no width, so the first version of this
   * divided by nothing and every scrub was ignored.
   */
  const trackRef = useRef<HTMLDivElement | null>(null)
  const scrubbing = useRef(false)
  const scrubTo = (clientX: number): void => {
    const node = trackRef.current
    if (node == null) return
    const rect = node.getBoundingClientRect()
    if (rect.width <= 0) return
    const at = Math.min(1, Math.max(0, (clientX - rect.left) / rect.width))
    onScrub(take.fromMs + at * span)
  }

  return (
    <View style={styles.bar}>
      <View style={styles.trackRow}>
        <Text style={styles.time}>{clock(atMs - take.fromMs)}</Text>
        {/* A raw div, for the same reason the tiles use one: this needs the
            pointer's position against the element's own box, and it has to
            keep following a finger that is still down. */}
        <div
          ref={trackRef}
          role="slider"
          aria-label="Position in the game"
          aria-valuemin={0}
          aria-valuemax={Math.round(span / 1000)}
          aria-valuenow={Math.round((atMs - take.fromMs) / 1000)}
          tabIndex={0}
          style={{
            position: 'relative',
            flex: 1,
            height: 24,
            display: 'flex',
            alignItems: 'center',
            touchAction: 'none',
            cursor: 'pointer'
          }}
          onPointerDown={event => {
            scrubbing.current = true
            ;(event.target as HTMLElement).setPointerCapture?.(event.pointerId)
            scrubTo(event.clientX)
          }}
          onPointerMove={event => {
            if (scrubbing.current) scrubTo(event.clientX)
          }}
          onPointerUp={() => {
            scrubbing.current = false
          }}
        >
          {/* One strip per camera, so what each was there for is visible
              rather than discovered by scrubbing into an empty tile. */}
          {angles.map((angle, index) => (
            <View
              key={angle.id}
              style={[
                styles.coverage,
                {
                  top: index * theme.rem(0.3125),
                  left: `${fraction(angle.fromMs) * 100}%`,
                  width: `${(fraction(angle.toMs) - fraction(angle.fromMs)) * 100}%`
                }
              ]}
            />
          ))}
          <View
            style={[styles.played, { width: `${fraction(atMs) * 100}%` }]}
          />
          <View style={[styles.head, { left: `${fraction(atMs) * 100}%` }]} />
        </div>
        <Text style={styles.time}>{clock(take.toMs - take.fromMs)}</Text>
      </View>

      <View style={styles.buttons}>
        <BarButton
          label="⏴⏴"
          hint={lstrings.angles_back_ten}
          onPress={() => {
            onSkip(-10)
          }}
        />
        <BarButton
          label={playing ? '❚❚' : '▶'}
          hint={playing ? lstrings.angles_pause : lstrings.angles_play}
          onPress={onTogglePlay}
        />
        <BarButton
          label="⏵⏵"
          hint={lstrings.angles_forward_ten}
          onPress={() => {
            onSkip(10)
          }}
        />

        <View style={styles.audio}>
          {angles.map(angle => (
            <Pressable
              key={angle.id}
              accessibilityRole="radio"
              accessibilityState={{ selected: angle.audio }}
              accessibilityLabel={sprintf(
                lstrings.angles_sound_from,
                angle.name
              )}
              style={[styles.audioPill, angle.audio && styles.audioPillOn]}
              onPress={() => {
                onPickAudio(angle.id)
              }}
            >
              <Text
                style={[styles.audioText, angle.audio && styles.audioTextOn]}
                numberOfLines={1}
              >
                {angle.audio ? `🔊 ${angle.name}` : angle.name}
              </Text>
            </Pressable>
          ))}
        </View>

        <BarButton label="✕" hint={lstrings.angles_close} onPress={onClose} />
      </View>
    </View>
  )
}

function BarButton(props: {
  label: string
  hint: string
  onPress: () => void
}): React.ReactElement {
  const styles = getStyles(useTheme())
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={props.hint}
      style={styles.button}
      onPress={props.onPress}
    >
      <Text style={styles.buttonText}>{props.label}</Text>
    </Pressable>
  )
}

/** `1:04:11` into the take, counted from when the first camera started. */
function clock(ms: number): string {
  const total = Math.max(0, Math.round(ms / 1000))
  const hours = Math.floor(total / 3600)
  const minutes = Math.floor((total % 3600) / 60)
  const seconds = total % 60
  const pad = (value: number): string => String(value).padStart(2, '0')
  return hours > 0
    ? `${hours}:${pad(minutes)}:${pad(seconds)}`
    : `${minutes}:${pad(seconds)}`
}

const getStyles = cacheStyles((theme: Theme) => ({
  bar: {
    position: 'absolute',
    left: 0,
    right: 0,
    bottom: 0,
    // Above the pictures: the tiles stack explicitly, and without this the
    // bottom row of them covered the scrubber completely.
    zIndex: 5,
    paddingHorizontal: theme.rem(theme.spaceSmRem),
    paddingBottom: theme.rem(theme.spaceSmRem),
    paddingTop: theme.rem(theme.spaceXsRem),
    // Dark enough to read a white clock against a sunlit outfield. At 55% the
    // times and the coverage strips vanished wherever a bright picture ran
    // underneath them, which on a four-up grid is most of the width.
    backgroundColor: 'rgba(0, 0, 0, 0.82)'
  },
  trackRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: theme.rem(theme.spaceSmRem)
  },
  time: {
    color: '#ffffff',
    fontFamily: theme.regularTextFont,
    fontSize: theme.rem(0.75),
    minWidth: theme.rem(3.5),
    textAlign: 'center',
    textShadowColor: 'rgba(0, 0, 0, 0.9)',
    textShadowRadius: 3
  },
  coverage: {
    position: 'absolute',
    height: theme.rem(0.1875),
    borderRadius: theme.rem(0.125),
    backgroundColor: 'rgba(255, 255, 255, 0.55)'
  },
  played: {
    position: 'absolute',
    bottom: theme.rem(0.25),
    height: theme.rem(0.25),
    borderRadius: theme.rem(0.125),
    backgroundColor: theme.activeColor
  },
  head: {
    position: 'absolute',
    bottom: 0,
    width: theme.rem(0.75),
    height: theme.rem(0.75),
    marginLeft: theme.rem(-0.375),
    borderRadius: theme.rem(0.375),
    backgroundColor: '#ffffff'
  },
  buttons: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: theme.rem(theme.spaceXsRem),
    marginTop: theme.rem(theme.spaceXsRem)
  },
  button: {
    minWidth: theme.rem(2.75),
    height: theme.rem(2.75),
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: theme.rem(1.375),
    paddingHorizontal: theme.rem(theme.spaceXsRem),
    backgroundColor: 'rgba(255, 255, 255, 0.12)'
  },
  buttonText: {
    color: '#ffffff',
    fontFamily: theme.semiBoldTextFont,
    fontSize: theme.rem(0.9375)
  },
  audio: {
    flex: 1,
    flexDirection: 'row',
    flexWrap: 'wrap',
    justifyContent: 'center',
    gap: theme.rem(theme.spaceXsRem)
  },
  audioPill: {
    minHeight: theme.rem(2),
    justifyContent: 'center',
    paddingHorizontal: theme.rem(theme.spaceSmRem),
    borderRadius: theme.rem(1),
    backgroundColor: 'rgba(255, 255, 255, 0.12)'
  },
  audioPillOn: {
    backgroundColor: theme.activeColor
  },
  audioText: {
    color: 'rgba(255, 255, 255, 0.75)',
    fontFamily: theme.regularTextFont,
    fontSize: theme.rem(0.75),
    maxWidth: theme.rem(9)
  },
  audioTextOn: {
    color: '#ffffff',
    fontFamily: theme.semiBoldTextFont
  }
}))
