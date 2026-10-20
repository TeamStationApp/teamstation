import React from 'react'
import { Pressable, Text, View } from 'react-native'

import { Icon, type IconName } from '../../components/Icon'
import { lstrings } from '../../locales/strings'
import { cacheStyles, type Theme, useTheme } from '../../theme/ThemeContext'
import { intersects } from '../scoreboardOverlay/overlayLayout'
import type { Window } from '../wallClock'
import type { Rect } from './layout'

/**
 * What the two multi-camera bars share — the browser's and the phone's.
 *
 * A file of its own because a phone's `MultiCamBar.native.tsx` cannot import
 * from its web twin: Metro resolves the import back to the native sibling.
 */

/** The height a finger can grab the track by, in pixels. */
export const TRACK_HIT_PX = 72

/** Each button's height and least width, which sets the bar's own height. */
export const BUTTON_REM = 2.75

/**
 * How tall the bar stands, in rems: a button and the padding above and below
 * it. Anything that has to sit clear of the bar reads it here.
 */
export function barHeightRem(theme: Theme): number {
  return BUTTON_REM + 2 * theme.spaceXsRem
}

export interface BarAngle {
  id: string
  name: string
  /** The stretch of wall-clock time this camera actually covers. */
  fromMs: number
  toMs: number
}

export interface MultiCamBarProps {
  window: Window
  atMs: number
  playing: boolean
  angles: BarAngle[]
  onTogglePlay: () => void
  onSkip: (deltaSec: number) => void
  onScrub: (wallMs: number) => void
  /** Any press or drag on the bar, which keeps it from hiding under a finger. */
  onInteract: () => void
  /** Faded in when true, faded out and untouchable when false. */
  visible: boolean
}

/** Where `ms` falls in the take, from 0 to 1. */
export function fractionOf(take: Window, ms: number): number {
  const span = Math.max(1, take.toMs - take.fromMs)
  return Math.min(1, Math.max(0, (ms - take.fromMs) / span))
}

/** −10 s, play or pause, +10 s: the buttons before the track. */
export function TransportButtons(props: {
  playing: boolean
  onTogglePlay: () => void
  onSkip: (deltaSec: number) => void
}): React.ReactElement {
  const { playing, onTogglePlay, onSkip } = props
  return (
    <>
      <BarButton
        icon="replay_10"
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
        icon="forward_10"
        hint={lstrings.angles_forward_ten}
        onPress={() => {
          onSkip(10)
        }}
      />
    </>
  )
}

/**
 * The visible strip of the track: one line per camera, so what each was there
 * for is visible rather than discovered by scrubbing into an empty tile, the
 * part played, and the playhead.
 */
export function TrackStrips(props: {
  take: Window
  atMs: number
  angles: BarAngle[]
}): React.ReactElement {
  const { take, atMs, angles } = props
  const theme = useTheme()
  const styles = getBarStyles(theme)
  return (
    <>
      {angles.map((angle, index) => (
        <View
          key={angle.id}
          style={[
            styles.coverage,
            {
              top: index * theme.rem(0.3125),
              left: `${fractionOf(take, angle.fromMs) * 100}%`,
              width: `${(fractionOf(take, angle.toMs) - fractionOf(take, angle.fromMs)) * 100}%`
            }
          ]}
        />
      ))}
      <View
        style={[styles.played, { width: `${fractionOf(take, atMs) * 100}%` }]}
      />
      <View
        style={[styles.head, { left: `${fractionOf(take, atMs) * 100}%` }]}
      />
    </>
  )
}

/**
 * One round button. An icon where the app has one, from the Material Symbols
 * font it ships: the ten-second arrows were characters (`⏴⏴`) that Android's
 * fonts do not have, and drew as two empty boxes there.
 */
export function BarButton(props: {
  label?: string
  icon?: IconName
  hint: string
  onPress: () => void
}): React.ReactElement {
  const styles = getBarStyles(useTheme())
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={props.hint}
      style={styles.button}
      onPress={props.onPress}
    >
      {props.icon != null ? (
        <Icon name={props.icon} size={1.25} color="#ffffff" />
      ) : (
        <Text style={styles.buttonText}>{props.label}</Text>
      )}
    </Pressable>
  )
}

/**
 * The way out: an ✕ in the top right corner, on the browser and the phone
 * alike, whichever way the screen is turned.
 *
 * It comes and goes with the controls — the bar, or the flash of a tap — so
 * the pictures have the corner to themselves the rest of the time, and
 * whatever a viewer did to call a control up shows them the way out too.
 * Hidden it is faded out and takes no touch, so the corner is the top-right
 * square of the picture again.
 */
export function ExitButton(props: {
  visible: boolean
  onPress: () => void
  /** How far down from the top, past a notch or a status bar. */
  top?: number
  right?: number
}): React.ReactElement {
  const { visible, onPress, top = 0, right = 0 } = props
  const theme = useTheme()
  const styles = getBarStyles(theme)
  return (
    <View
      style={[
        styles.exit,
        {
          top: top + theme.rem(theme.spaceSmRem),
          right: right + theme.rem(theme.spaceSmRem),
          opacity: visible ? 1 : 0
        }
      ]}
      pointerEvents={visible ? 'box-none' : 'none'}
      accessibilityElementsHidden={!visible}
      importantForAccessibility={visible ? 'auto' : 'no-hide-descendants'}
    >
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={lstrings.angles_close}
        style={styles.exitButton}
        onPress={onPress}
      >
        <Text style={styles.buttonText}>✕</Text>
      </Pressable>
    </View>
  )
}

/**
 * How much of the top right corner the ✕ takes, in pixels from the edge:
 * what the Slow Mo pill steps left by while the ✕ is showing.
 */
export function exitClearance(theme: Theme): number {
  return theme.rem(BUTTON_REM + theme.spaceSmRem)
}

/** The way out's side, square. */
export function exitSize(theme: Theme): number {
  return theme.rem(BUTTON_REM)
}

/**
 * Where the way out's top goes, in the screen's coordinates: at `spot`, the
 * top right of the area it is kept inside, unless the board or its box score
 * reaches there — upright, and sideways with two angles, the board's right
 * end does, and the ✕ hid its count — in which case `gap` under them.
 */
export function exitTopClear(
  spot: Rect,
  covers: Array<Rect | null>,
  gap: number
): number {
  let y = spot.y
  for (let moved = true; moved;) {
    moved = false
    for (const cover of covers) {
      if (cover == null || !intersects({ ...spot, y }, cover)) continue
      y = cover.y + cover.h + gap
      moved = true
    }
  }
  return y
}

/** `1:04:11` into the take, counted from when the first camera started. */
export function clock(ms: number): string {
  const total = Math.max(0, Math.round(ms / 1000))
  const hours = Math.floor(total / 3600)
  const minutes = Math.floor((total % 3600) / 60)
  const seconds = total % 60
  const pad = (value: number): string => String(value).padStart(2, '0')
  return hours > 0
    ? `${hours}:${pad(minutes)}:${pad(seconds)}`
    : `${minutes}:${pad(seconds)}`
}

export const getBarStyles = cacheStyles((theme: Theme) => ({
  bar: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: theme.rem(theme.spaceXsRem),
    paddingHorizontal: theme.rem(theme.spaceSmRem),
    paddingVertical: theme.rem(theme.spaceXsRem),
    // Dark enough to read a white clock against a sunlit outfield. At 55% the
    // times and the coverage strips vanished wherever a bright picture ran
    // underneath them, which on a four-up grid is most of the width.
    backgroundColor: 'rgba(0, 0, 0, 0.82)'
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
  button: {
    minWidth: theme.rem(BUTTON_REM),
    height: theme.rem(BUTTON_REM),
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: theme.rem(BUTTON_REM / 2),
    paddingHorizontal: theme.rem(theme.spaceXsRem),
    backgroundColor: 'rgba(255, 255, 255, 0.12)'
  },
  exit: {
    position: 'absolute',
    // Over the pictures, the flash and the bar.
    zIndex: 7
  },
  exitButton: {
    width: theme.rem(BUTTON_REM),
    height: theme.rem(BUTTON_REM),
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: theme.rem(BUTTON_REM / 2),
    // On the picture rather than on the bar's dark strip, so darker than
    // the bar's buttons to read against a bright outfield.
    backgroundColor: 'rgba(0, 0, 0, 0.6)'
  },
  buttonText: {
    color: '#ffffff',
    fontFamily: theme.semiBoldTextFont,
    fontSize: theme.rem(0.9375)
  }
}))
