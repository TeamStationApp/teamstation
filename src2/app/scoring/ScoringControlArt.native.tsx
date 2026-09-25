import React, { memo, useId } from 'react'
import { View } from 'react-native'
import Svg, {
  Circle,
  Defs,
  LinearGradient,
  Path,
  Rect,
  Stop
} from 'react-native-svg'

import { CONTROL_COLORS, type ControlKind } from './scoringControlStyle'

/** Decorative art stays inside each button; the field beneath stays untouched. */
export const ControlBackdrop = memo(function ControlBackdrop({
  kind
}: {
  kind: ControlKind
}): React.ReactElement {
  const id = useId().replace(/:/g, '')
  const colors = CONTROL_COLORS[kind]
  return (
    <View
      pointerEvents="none"
      style={{
        position: 'absolute',
        inset: 0,
        borderRadius: 11,
        overflow: 'hidden'
      }}
    >
      <Svg width="100%" height="100%">
        <Defs>
          <LinearGradient id={id} x1="0" y1="0" x2="0" y2="1">
            {(kind === 'contact'
              ? [
                  ['0', colors.top],
                  ['0.48', '#9e6d3e'],
                  ['0.52', '#855327'],
                  ['1', colors.bottom]
                ]
              : [
                  ['0', colors.top],
                  ['1', colors.bottom]
                ]
            ).map(([offset, color]) => (
              <Stop key={offset} offset={offset} stopColor={color} />
            ))}
          </LinearGradient>
        </Defs>
        <Rect width="100%" height="100%" fill={`url(#${id})`} />
        {kind === 'contact' &&
          Array.from({ length: 100 }, (_, i) => (
            <Rect
              key={i}
              transform={`translate(${i * 3} 0)`}
              width={3}
              height="100%"
              fill={i % 2 === 0 ? '#ffffff' : '#000000'}
              opacity={0.04}
            />
          ))}
      </Svg>
    </View>
  )
})

export function ControlIcon({
  kind,
  size = 14
}: {
  kind: ControlKind
  size?: number
}): React.ReactElement {
  return (
    <Svg width={size} height={size} viewBox="0 0 32 32" accessible={false}>
      {kind === 'more' && (
        <Path
          d="M7 20 L16 11 L25 20"
          stroke="#34d399"
          strokeWidth={3}
          strokeLinecap="round"
          strokeLinejoin="round"
          fill="none"
        />
      )}
      {kind === 'undo' && (
        <Path
          d="M5 13 H18 Q26 13 26 23 M5 13 L12 6 M5 13 L12 20"
          stroke="#fbbf24"
          strokeWidth={3}
          strokeLinecap="round"
          strokeLinejoin="round"
          fill="none"
        />
      )}
      {kind === 'ball' && (
        <>
          <Rect
            transform="translate(2 7)"
            width={28}
            height={18}
            rx={9}
            stroke="#a7f3d0"
            strokeOpacity={0.6}
            strokeWidth={2}
            fill="none"
          />
          <Circle cx={16} cy={16} r={7} fill="#a7f3d0" />
        </>
      )}
      {kind === 'called' && (
        <>
          <Rect
            transform="translate(3 5)"
            width={26}
            height={22}
            rx={2}
            stroke="#fde68a"
            strokeWidth={4}
            fill="none"
          />
          <Rect
            transform="translate(12 7)"
            width={8}
            height={18}
            fill="#fef3c7"
          />
        </>
      )}
      {kind === 'swing' && (
        <Path
          d="M8 8 L24 24 M8 24 L24 8"
          stroke="#fecaca"
          strokeWidth={2.5}
          strokeLinecap="round"
        />
      )}
      {kind === 'foul' && (
        <>
          <Circle cx={16} cy={16} r={15} fill="#f8fafc" stroke="#cbd5e1" />
          <Path
            d="M11 2 C6 7 6 25 11 30 M21 2 C26 7 26 25 21 30 M8 7 L12 9 M6.5 12 L11 13 M6 16 L11 16 M6.5 20 L11 19 M8 25 L12 23 M24 7 L20 9 M25.5 12 L21 13 M26 16 L21 16 M25.5 20 L21 19 M24 25 L20 23"
            stroke="#dc2626"
            strokeWidth={1.3}
            fill="none"
          />
        </>
      )}
      {kind === 'contact' && (
        <Path
          d="M4 28 L7 30 L27 10 Q31 5 27 2 Q24 0 20 6 Z M3 27 L8 32"
          stroke="#fde68a"
          strokeWidth={1.5}
          fill="#fde68a"
        />
      )}
    </Svg>
  )
}
