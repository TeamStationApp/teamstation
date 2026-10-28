import React, { useEffect, useRef } from 'react'
import { Text, View } from 'react-native'

import { useTheme } from '../theme/ThemeContext'
import {
  type BarAngle,
  barHeightRem,
  clock,
  getBarStyles,
  type MultiCamBarProps,
  TrackStrips
} from './multiCam/barParts'

export { barHeightRem, type BarAngle, type MultiCamBarProps }

/**
 * The multi-camera controls on a phone: the time, the take's track with a
 * strip per camera, the length — on the game's own clock — on the bottom of
 * the block of videos, as wide as it (`frame`). The way out is the view's, at
 * the block's top right (`ExitButton`).
 *
 * The track takes no touch: the press grid's bottom row, under it, is the
 * scrub (`pressGrid.ts`). It says where it is drawn, in the press layer's
 * coordinates, so a press lands where the finger is on it.
 */
export function MultiCamBar(props: MultiCamBarProps): React.ReactElement {
  const { window: take, atMs, angles, onTrackRect, visible, frame } = props
  const styles = getBarStyles(useTheme())
  const span = Math.max(1, take.toMs - take.fromMs)
  const left = frame?.left ?? 0
  // The track's place in the bar, from its own layout; its place in the
  // press layer also moves with the frame, which its layout does not see.
  const inBar = useRef<{ x: number; y: number; w: number; h: number } | null>(
    null
  )
  const report = (): void => {
    const at = inBar.current
    if (at != null) onTrackRect?.({ ...at, x: left + at.x })
  }
  const reportRef = useRef(report)
  reportRef.current = report
  useEffect(() => {
    reportRef.current()
  }, [left])

  return (
    <View
      style={{
        position: 'absolute',
        left,
        ...(frame != null ? { width: frame.width } : { right: 0 }),
        bottom: frame?.bottom ?? 0,
        zIndex: 5,
        opacity: visible ? 1 : 0
      }}
      pointerEvents="none"
      accessibilityElementsHidden={!visible}
      importantForAccessibility={visible ? 'auto' : 'no-hide-descendants'}
    >
      <View style={styles.bar}>
        <Text style={styles.time}>{clock(atMs - take.fromMs)}</Text>
        <View
          accessibilityRole="adjustable"
          accessibilityLabel="Position in the game"
          accessibilityValue={{
            min: 0,
            max: Math.round(span / 1000),
            now: Math.round((atMs - take.fromMs) / 1000)
          }}
          style={{ flex: 1, height: 24 }}
          // The row sits at the bar's left, which is the frame's: the
          // track's place in the press layer is the frame's left plus its own.
          // Said again whenever either changes.
          onLayout={event => {
            const { x, y, width, height } = event.nativeEvent.layout
            inBar.current = { x, y, w: width, h: height }
            report()
          }}
        >
          <TrackStrips take={take} atMs={atMs} angles={angles} />
        </View>
        <Text style={styles.time}>{clock(take.toMs - take.fromMs)}</Text>
      </View>
    </View>
  )
}
