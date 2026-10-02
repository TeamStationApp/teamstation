import React, { useRef } from 'react'
import { type GestureResponderEvent, Text, View } from 'react-native'

import { useTheme } from '../theme/ThemeContext'
import {
  type BarAngle,
  barHeightRem,
  clock,
  getBarStyles,
  type MultiCamBarProps,
  TRACK_HIT_PX,
  TrackStrips,
  TransportButtons
} from './multiCam/barParts'

export { barHeightRem, type BarAngle, type MultiCamBarProps }

/**
 * The multi-camera controls on a phone: the same row as the browser's — back,
 * play, forward, the time, the take's track with a strip per camera, the
 * length — on the game's own clock. The way out is the view's, at the top
 * right (`ExitButton`).
 *
 * The track follows a finger with React Native's own responder: the press is
 * measured against the track's width from its layout, since a touch carries
 * its position within the view it landed on and nothing about that view's
 * size.
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
    onInteract,
    visible
  } = props
  const styles = getBarStyles(useTheme())
  const span = Math.max(1, take.toMs - take.fromMs)
  const trackWidth = useRef(0)

  const scrubTo = (event: GestureResponderEvent): void => {
    onInteract()
    const width = trackWidth.current
    if (width <= 0) return
    const at = Math.min(1, Math.max(0, event.nativeEvent.locationX / width))
    onScrub(take.fromMs + at * span)
  }

  return (
    <View
      style={{
        position: 'absolute',
        left: 0,
        right: 0,
        bottom: 0,
        zIndex: 5,
        opacity: visible ? 1 : 0
      }}
      // Hidden, it takes no touch: the pictures under it are the bottom
      // third's, which is what calls it back.
      pointerEvents={visible ? 'auto' : 'none'}
      accessibilityElementsHidden={!visible}
      importantForAccessibility={visible ? 'auto' : 'no-hide-descendants'}
      onTouchStart={onInteract}
    >
      <View style={styles.bar}>
        <TransportButtons
          playing={playing}
          onTogglePlay={onTogglePlay}
          onSkip={onSkip}
        />
        <Text style={styles.time}>{clock(atMs - take.fromMs)}</Text>
        <View
          accessibilityRole="adjustable"
          accessibilityLabel="Position in the game"
          accessibilityValue={{
            min: 0,
            max: Math.round(span / 1000),
            now: Math.round((atMs - take.fromMs) / 1000)
          }}
          // Far taller than it looks, reaching up over the bottom of the
          // pictures: a finger that misses a thin strip lands on a tile.
          style={{
            flex: 1,
            height: TRACK_HIT_PX,
            marginTop: -(TRACK_HIT_PX - 24) * 0.75,
            marginBottom: -(TRACK_HIT_PX - 24) * 0.25,
            paddingBottom: (TRACK_HIT_PX - 24) * 0.25,
            justifyContent: 'flex-end'
          }}
          onLayout={event => {
            trackWidth.current = event.nativeEvent.layout.width
          }}
          onStartShouldSetResponder={() => true}
          // A drag along the track keeps the finger even as it wanders up.
          onResponderTerminationRequest={() => false}
          onResponderGrant={scrubTo}
          onResponderMove={scrubTo}
        >
          {/* `pointerEvents` none, so `locationX` is always the track's own
              and never one of the strips' it happens to be over. */}
          <View style={{ width: '100%', height: 24 }} pointerEvents="none">
            <TrackStrips take={take} atMs={atMs} angles={angles} />
          </View>
        </View>
        <Text style={styles.time}>{clock(take.toMs - take.fromMs)}</Text>
      </View>
    </View>
  )
}
