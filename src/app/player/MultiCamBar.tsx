import React, { useEffect, useRef } from 'react'
import { Text, View } from 'react-native'

import { useTheme } from '../theme/ThemeContext'
import {
  type BarAngle,
  barHeightRem,
  clock,
  getBarStyles,
  type MultiCamBarProps as SharedBarProps,
  TrackStrips
} from './multiCam/barParts'

export { barHeightRem, type BarAngle }

export interface MultiCamBarProps extends SharedBarProps {
  /** The bar's own element, so the view can move the keyboard's focus in. */
  rootRef?: React.Ref<HTMLDivElement>
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
 * skipping are the press grid's squares and the keys; the grid's bottom row,
 * under this bar, scrubs it. Which angle is heard is chosen in the picker, before
 * the view opens.
 */
export function MultiCamBar(props: MultiCamBarProps): React.ReactElement {
  const {
    window: take,
    atMs,
    angles,
    onTrackRect,
    onInteract,
    visible,
    rootRef,
    insets,
    frame
  } = props
  const styles = getBarStyles(useTheme())
  const span = Math.max(1, take.toMs - take.fromMs)

  // Where the track is, for a press on the bottom row of the press grid to
  // land where the finger is on it: on mount, and again whenever the window
  // changes size or the bar moves.
  const trackRef = useRef<HTMLDivElement | null>(null)
  useEffect(() => {
    if (onTrackRect == null) return
    const report = (): void => {
      const rect = trackRef.current?.getBoundingClientRect()
      if (rect == null || rect.width <= 0) return
      onTrackRect({ x: rect.left, y: rect.top, w: rect.width, h: rect.height })
    }
    report()
    window.addEventListener('resize', report)
    // The track narrows as the clocks either side of it widen — past ten
    // minutes, past an hour — with nothing else about the window changing.
    const track = trackRef.current
    const watcher =
      track != null && typeof ResizeObserver === 'function'
        ? new ResizeObserver(report)
        : null
    if (track != null) watcher?.observe(track)
    return () => {
      window.removeEventListener('resize', report)
      watcher?.disconnect()
    }
  }, [onTrackRect, frame?.left, frame?.width, frame?.bottom])

  return (
    // A raw div for the capture phase: the bar stays up for as long as
    // somebody is using it from the keyboard, focus moving through it
    // included. It takes no pointer: the press grid's bottom row, under it,
    // is the scrub.
    <div
      ref={rootRef}
      style={{
        position: 'absolute',
        left: frame?.left ?? insets?.left ?? 0,
        ...(frame != null
          ? { width: frame.width }
          : { right: insets?.right ?? 0 }),
        bottom: frame?.bottom ?? insets?.bottom ?? 0,
        zIndex: 5,
        // However it comes or goes — a tap, a hover, the timer — it fades.
        opacity: visible ? 1 : 0,
        transition: 'opacity 250ms ease',
        pointerEvents: 'none'
      }}
      // Inert while hidden, not merely unclickable: the scrubber would
      // otherwise still take the keyboard's focus and act on a bar nobody
      // can see.
      aria-hidden={!visible}
      inert={!visible}
      onFocusCapture={onInteract}
    >
      <View style={styles.bar}>
        <Text style={styles.time}>{clock(atMs - take.fromMs)}</Text>
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
            position: 'relative',
            height: 24
          }}
        >
          <TrackStrips take={take} atMs={atMs} angles={angles} />
        </div>
        <Text style={styles.time}>{clock(take.toMs - take.fromMs)}</Text>
      </View>
    </div>
  )
}
