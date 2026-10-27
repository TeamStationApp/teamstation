import React, { useEffect, useRef } from 'react'
import { Text, View } from 'react-native'

import { useTheme } from '../theme/ThemeContext'
import {
  type BarAngle,
  barHeightRem,
  clock,
  getBarStyles,
  type MultiCamBarProps as SharedBarProps,
  TRACK_HIT_PX,
  TrackStrips
} from './multiCam/barParts'
import { TAP_SLOP_PX } from './multiCam/useMultiCam'

export { barHeightRem, type BarAngle }

export interface MultiCamBarProps extends SharedBarProps {
  /** The bar's own element, so the view can move the keyboard's focus in. */
  rootRef?: React.Ref<HTMLDivElement>
  /**
   * An upward swipe is wanted by the page — Safari's bars are showing and a
   * swipe is the only thing that hides them — so the track lets a vertical
   * drag through and scrubs only on a sideways drag or a tap.
   */
  panPage?: boolean
  /**
   * What the hardware takes out of the screen: the bar sits just above the
   * home indicator and inside the corners, over the pictures that run on
   * under them.
   */
  insets?: { bottom: number; left: number; right: number }
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
 * **One row**: the time, the track and the total, because every line the bar
 * takes is a line of picture the four angles lose. Playing, pausing and
 * skipping are the pictures' own taps and the keys; a drag across the
 * pictures scrubs too. Which angle is heard is chosen in the picker, before
 * the view opens.
 */
export function MultiCamBar(props: MultiCamBarProps): React.ReactElement {
  const {
    window: take,
    atMs,
    angles,
    onScrub,
    onTrackWidth,
    onInteract,
    visible,
    rootRef,
    panPage = false,
    insets
  } = props
  const styles = getBarStyles(useTheme())
  const span = Math.max(1, take.toMs - take.fromMs)

  /**
   * Where in the take a press on the track landed.
   *
   * Measured off the element itself rather than out of a React Native press
   * event: the press event carries no width, so the first version of this
   * divided by nothing and every scrub was ignored.
   */
  const trackRef = useRef<HTMLDivElement | null>(null)
  const scrubbing = useRef(false)
  /** Where a drag in progress last was, to land there if the browser cancels it. */
  const lastX = useRef<number | null>(null)
  /**
   * Where a finger came down on the track while the page wants vertical
   * swipes: nothing is scrubbed until it is clear the finger is not one.
   */
  const pending = useRef<{ x: number; y: number; id: number } | null>(null)
  const scrubTo = (clientX: number, final: boolean): void => {
    const node = trackRef.current
    if (node == null) return
    const rect = node.getBoundingClientRect()
    if (rect.width <= 0) return
    const at = Math.min(1, Math.max(0, (clientX - rect.left) / rect.width))
    onScrub(take.fromMs + at * span, final)
  }

  // The track's width, for a drag across the pictures to be measured in: on
  // mount, and again whenever the window changes size.
  useEffect(() => {
    if (onTrackWidth == null) return
    const report = (): void => {
      const width = trackRef.current?.getBoundingClientRect().width ?? 0
      if (width > 0) onTrackWidth(width)
    }
    report()
    window.addEventListener('resize', report)
    return () => {
      window.removeEventListener('resize', report)
    }
  }, [onTrackWidth])

  return (
    // A raw div for the capture phase: the bar stays up for as long as
    // somebody is using it, whichever part of it they are using, focus moving
    // through it included. Calling it back once it has hidden is the view's
    // job, since nothing in a hidden bar can take a key.
    <div
      ref={rootRef}
      style={{
        position: 'absolute',
        left: insets?.left ?? 0,
        right: insets?.right ?? 0,
        bottom: insets?.bottom ?? 0,
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
            // While the page wants a swipe up, a vertical drag that starts on
            // the track is that swipe: the bar sits at the bottom, which is
            // exactly where a thumb starts one, and a track that kept every
            // drag for itself scrubbed the game instead of hiding the bars.
            touchAction: panPage ? 'pan-y' : 'none',
            cursor: 'pointer'
          }}
          onPointerDown={event => {
            if (panPage) {
              pending.current = {
                x: event.clientX,
                y: event.clientY,
                id: event.pointerId
              }
              return
            }
            scrubbing.current = true
            lastX.current = event.clientX
            ;(event.target as HTMLElement).setPointerCapture?.(event.pointerId)
            scrubTo(event.clientX, false)
          }}
          onPointerMove={event => {
            const from = pending.current
            if (from?.id === event.pointerId) {
              // Sideways is a scrub; the browser takes a vertical drag itself
              // and cancels the pointer.
              const dx = Math.abs(event.clientX - from.x)
              const dy = Math.abs(event.clientY - from.y)
              if (dx < TAP_SLOP_PX || dx <= dy) return
              pending.current = null
              scrubbing.current = true
              ;(event.target as HTMLElement).setPointerCapture?.(
                event.pointerId
              )
            }
            if (scrubbing.current) {
              lastX.current = event.clientX
              scrubTo(event.clientX, false)
            }
          }}
          onPointerUp={event => {
            // Where the finger lifts is where it lands — a drag's last move
            // can be well short of it — and a tap that never became a drag
            // still seeks, as it always has.
            if (scrubbing.current || pending.current?.id === event.pointerId) {
              scrubTo(event.clientX, true)
            }
            pending.current = null
            scrubbing.current = false
          }}
          // The browser took the drag for the page before it was a scrub:
          // nothing was scrubbed. Taken from a scrub already under way, it
          // lands where the finger last was, not on whatever seek the drag
          // had last been allowed.
          onPointerCancel={() => {
            if (scrubbing.current && lastX.current != null) {
              scrubTo(lastX.current, true)
            }
            pending.current = null
            scrubbing.current = false
            lastX.current = null
          }}
        >
          <div style={{ position: 'relative', width: '100%', height: 24 }}>
            <TrackStrips take={take} atMs={atMs} angles={angles} />
          </div>
        </div>
        <Text style={styles.time}>{clock(take.toMs - take.fromMs)}</Text>
      </View>
    </div>
  )
}
