import React, { useId, useState } from 'react'
import { View } from 'react-native'

import { RING_PAD, ringCanvasSize, ringSegments } from './perimeterRing'
import { useRingOffset } from './useRingOffset'

/**
 * A glowing string of blue, purple and green laid around the card. The
 * colors are pulled clockwise along that edge, one lap at a time.
 */
export function AtBatSweep(): React.ReactElement {
  const offset = useRingOffset()
  const glowId = useId().replace(/:/g, '')
  const [box, setBox] = useState({ width: 0, height: 0 })
  const canvas = ringCanvasSize(box.width, box.height)
  const segments =
    box.width > 0 ? ringSegments(box.width, box.height, offset) : []
  return (
    <View
      pointerEvents="none"
      style={{ position: 'absolute', left: 0, right: 0, top: 0, bottom: 0 }}
      onLayout={event => {
        const { width, height } = event.nativeEvent.layout
        setBox(current =>
          current.width === width && current.height === height
            ? current
            : { width, height }
        )
      }}
    >
      {box.width > 0 && (
        <svg
          width={canvas.width}
          height={canvas.height}
          style={{ position: 'absolute', left: -RING_PAD, top: -RING_PAD }}
        >
          <defs>
            <filter id={glowId} x="-40%" y="-40%" width="180%" height="180%">
              <feGaussianBlur stdDeviation="3" />
            </filter>
          </defs>
          <g
            filter={`url(#${glowId})`}
            opacity="0.95"
            strokeWidth={6}
            strokeLinecap="round"
          >
            {segments.map((segment, index) => (
              <line
                key={`glow-${index}`}
                x1={segment.x1}
                y1={segment.y1}
                x2={segment.x2}
                y2={segment.y2}
                stroke={segment.color}
              />
            ))}
          </g>
          <g strokeWidth={3} strokeLinecap="round">
            {segments.map((segment, index) => (
              <line
                key={`core-${index}`}
                x1={segment.x1}
                y1={segment.y1}
                x2={segment.x2}
                y2={segment.y2}
                stroke={segment.color}
              />
            ))}
          </g>
        </svg>
      )}
    </View>
  )
}
