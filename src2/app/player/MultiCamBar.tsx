import React, { useRef } from 'react'
import { Pressable, Text, View } from 'react-native'

import { lstrings } from '../locales/strings'
import { cacheStyles, type Theme, useTheme } from '../theme/ThemeContext'
import type { Window } from './wallClock'

/** The height a finger can grab the track by, in CSS pixels. */
const TRACK_HIT_PX = 72

/** Each button's height and least width, which sets the bar's own height. */
const BUTTON_REM = 2.75

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
  onClose: () => void
  /** Any press or drag on the bar, which keeps it from hiding under a finger. */
  onInteract: () => void
  /** Faded in when true, faded out and untouchable when false. */
  visible: boolean
  /** The bar's own element, so the view can move the keyboard's focus in. */
  rootRef?: React.Ref<HTMLDivElement>
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
 *
 * **One row.** The buttons sit either side of the track rather than under it,
 * because every line the bar takes is a line of picture the four angles lose.
 * Which angle is heard is chosen in the picker, before the view opens.
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
    onClose,
    onInteract,
    visible,
    rootRef
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
    // A raw div for the capture phase: the bar stays up for as long as
    // somebody is using it, whichever part of it they are using, focus moving
    // through it included. Calling it back once it has hidden is the view's
    // job, since nothing in a hidden bar can take a key.
    <div
      ref={rootRef}
      style={{
        position: 'absolute',
        left: 0,
        right: 0,
        bottom: 0,
        zIndex: 5,
        // However it comes or goes — a tap, a hover, the timer — it fades.
        opacity: visible ? 1 : 0,
        transition: 'opacity 250ms ease',
        pointerEvents: visible ? 'auto' : 'none'
      }}
      // Inert while hidden, not merely unclickable: its buttons and the
      // scrubber would otherwise still take the keyboard's focus and act on a
      // bar nobody can see.
      aria-hidden={!visible}
      inert={!visible}
      onPointerDownCapture={onInteract}
      onPointerMoveCapture={onInteract}
      onFocusCapture={onInteract}
    >
      <View style={styles.bar}>
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
            flex: 1,
            // Far taller than it looks: a finger that missed a 24-point strip
            // landed on the page instead, and a sideways drag there is iOS's
            // swipe back to the previous page. It reaches up over the bottom
            // of the pictures, as tall as the four coverage strips need
            // whatever the number of cameras, and down to the bar's edge.
            height: TRACK_HIT_PX,
            marginTop: -(TRACK_HIT_PX - 24) * 0.75,
            marginBottom: -(TRACK_HIT_PX - 24) * 0.25,
            // The visible strip sits where it always did, in the row, with
            // the extra reach above and below it.
            boxSizing: 'border-box',
            paddingBottom: (TRACK_HIT_PX - 24) * 0.25,
            display: 'flex',
            alignItems: 'flex-end',
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
          <div style={{ position: 'relative', width: '100%', height: 24 }}>
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
        </div>
        <Text style={styles.time}>{clock(take.toMs - take.fromMs)}</Text>
        <BarButton label="✕" hint={lstrings.angles_close} onPress={onClose} />
      </View>
    </div>
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
  buttonText: {
    color: '#ffffff',
    fontFamily: theme.semiBoldTextFont,
    fontSize: theme.rem(0.9375)
  }
}))
