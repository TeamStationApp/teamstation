import React, { useRef, useState } from 'react'
import { type GestureResponderEvent, View } from 'react-native'

import { lstrings } from '../locales/strings'
import { lightHaptic } from '../scoring/lightHaptic'
import { cacheStyles, type Theme, useTheme } from '../theme/ThemeContext'
import { type Clip, jogClip } from './clipModel'

/** The angle between two teeth: fine, so the wheel reads as knurled. */
export const TOOTH_PITCH = (6 * Math.PI) / 180
/** How much of its pitch a tooth fills, face on. */
const TOOTH_FILL = 0.45

/** One tooth as drawn: its centre from the wheel's left edge, in points. */
export interface Tooth {
  x: number
  width: number
  opacity: number
}

/**
 * The teeth of a wheel `width` wide, turned by `rotation` radians, as seen
 * edge-on.
 *
 * The wheel is a cylinder whose radius is half its width, so the half of it
 * facing the screen spans exactly that width. A tooth at angle θ from the
 * front sits `R·sin θ` from the centre, is `cos θ` as wide as one facing
 * straight out, and fades with it: the middle teeth are widest and
 * brightest, and the ends crowd together and darken as the wheel turns away
 * into the screen. Only the front half, |θ| < 90°, is drawn.
 */
export function wheelTeeth(rotation: number, width: number): Tooth[] {
  if (width <= 0) return []
  const radius = width / 2
  const face = radius * TOOTH_PITCH * TOOTH_FILL
  const offset = ((rotation % TOOTH_PITCH) + TOOTH_PITCH) % TOOTH_PITCH
  // A tooth exactly side-on has no width: the edge is open at both ends,
  // with a little slack for the sums that land a hair inside it.
  const half = Math.PI / 2 - 1e-9
  const teeth: Tooth[] = []
  const first = offset - Math.ceil(half / TOOTH_PITCH) * TOOTH_PITCH
  for (let angle = first; angle < half; angle += TOOTH_PITCH) {
    if (angle <= -half) continue
    const facing = Math.cos(angle)
    teeth.push({
      x: radius + radius * Math.sin(angle),
      width: face * facing,
      opacity: 0.25 + 0.75 * facing
    })
  }
  return teeth
}

export interface JogWheelProps {
  clip: Clip
  durationMs: number
  /** The timeline's width, so a jog is a quarter of the same drag there. */
  timelineWidth: number
  onChange: (clip: Clip) => void
  /** After the finger lifts, when the jog moved the window. */
  onCommit?: (clip: Clip) => void
}

/**
 * A knurled wheel under the timeline, for setting the window finely.
 *
 * Dragging it turns the wheel with the finger and slides the window a
 * quarter as far as the same drag on the timeline would, in the timeline's
 * tenth-second steps, with a light tick on each move that crosses a step. Lifting the finger
 * after a jog that moved the window commits it, which starts a playing clip
 * again from there; a touch that moved nothing commits nothing.
 */
export function JogWheel(props: JogWheelProps): React.ReactElement {
  const { clip, durationMs, timelineWidth, onChange, onCommit } = props
  const theme = useTheme()
  const styles = getStyles(theme)
  const view = useRef<React.ComponentRef<typeof View>>(null)
  const [width, setWidth] = useState(0)
  const [rotation, setRotation] = useState(0)
  const drag = useRef({ x: 0, rotation: 0, startMs: 0, lastMs: 0 })
  const latest = useRef(clip)
  latest.current = clip

  const jog = (event: GestureResponderEvent): Clip => {
    const dx = event.nativeEvent.pageX - drag.current.x
    if (width > 0) setRotation(drag.current.rotation + dx / (width / 2))
    return jogClip(drag.current.startMs, dx, timelineWidth, durationMs)
  }

  return (
    <View
      ref={view}
      style={styles.touch}
      testID="walkup-jog"
      accessibilityLabel={lstrings.walkup_jog}
      onLayout={event => {
        setWidth(event.nativeEvent.layout.width)
      }}
      onStartShouldSetResponder={() => true}
      onMoveShouldSetResponder={() => true}
      onResponderTerminationRequest={() => false}
      onResponderGrant={event => {
        drag.current = {
          x: event.nativeEvent.pageX,
          rotation,
          startMs: latest.current.startMs,
          lastMs: latest.current.startMs
        }
      }}
      onResponderMove={event => {
        const next = jog(event)
        if (next.startMs === drag.current.lastMs) return
        drag.current.lastMs = next.startMs
        lightHaptic(view.current)
        onChange(next)
      }}
      onResponderRelease={event => {
        const next = jog(event)
        if (next.startMs !== drag.current.lastMs) {
          drag.current.lastMs = next.startMs
          onChange(next)
        }
        if (next.startMs !== drag.current.startMs) onCommit?.(next)
      }}
      // A native gesture (the screen's scroll, an edge swipe) can take the
      // touch away. The window has already moved, so it is committed as a
      // release would be, and a playing clip follows it.
      onResponderTerminate={() => {
        if (drag.current.lastMs !== drag.current.startMs) {
          onCommit?.({ ...latest.current })
        }
      }}
    >
      <View style={styles.wheel}>
        {wheelTeeth(rotation, width).map((tooth, index) => (
          <View
            key={index}
            style={[
              styles.tooth,
              {
                left: tooth.x - tooth.width / 2,
                width: tooth.width,
                opacity: tooth.opacity
              }
            ]}
          />
        ))}
      </View>
    </View>
  )
}

/** About an eighth of an inch: the wheel's own height. */
const WHEEL_REM = 1.2
/** The finger's target, taller than the wheel it turns. */
const TOUCH_REM = 2.75

const getStyles = cacheStyles((theme: Theme) => ({
  touch: {
    height: theme.rem(TOUCH_REM),
    marginHorizontal: theme.rem(0.75),
    justifyContent: 'center'
  },
  wheel: {
    pointerEvents: 'none',
    height: theme.rem(WHEEL_REM),
    borderRadius: theme.rem(0.25),
    overflow: 'hidden',
    backgroundColor: theme.defaultBorderColor
  },
  tooth: {
    position: 'absolute',
    top: 0,
    bottom: 0,
    borderRadius: theme.rem(0.0625),
    backgroundColor: theme.primaryTextColor
  }
}))
