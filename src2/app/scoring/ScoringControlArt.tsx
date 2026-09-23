import React, { memo, useId } from 'react'
import { View } from 'react-native'

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
      <svg width="100%" height="100%" style={{ display: 'block' }}>
        <defs>
          <linearGradient id={id} x1="0" y1="0" x2="0" y2="1">
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
              <stop key={offset} offset={offset} stopColor={color} />
            ))}
          </linearGradient>
        </defs>
        <rect width="100%" height="100%" fill={`url(#${id})`} />
        {kind === 'contact' &&
          Array.from({ length: 100 }, (_, i) => (
            <rect
              key={i}
              x={i * 3}
              y={0}
              width={3}
              height="100%"
              fill={i % 2 === 0 ? '#ffffff' : '#000000'}
              opacity={0.04}
            />
          ))}
      </svg>
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
    <svg width={size} height={size} viewBox="0 0 32 32" aria-hidden="true">
      {kind === 'more' && (
        <path
          d="M7 20 L16 11 L25 20"
          stroke="#34d399"
          strokeWidth={3}
          strokeLinecap="round"
          strokeLinejoin="round"
          fill="none"
        />
      )}
      {kind === 'undo' && (
        <path
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
          <rect
            x={2}
            y={7}
            width={28}
            height={18}
            rx={9}
            stroke="#a7f3d0"
            strokeOpacity={0.6}
            strokeWidth={2}
            fill="none"
          />
          <circle cx={16} cy={16} r={7} fill="#a7f3d0" />
        </>
      )}
      {kind === 'called' && (
        <>
          <rect
            x={3}
            y={5}
            width={26}
            height={22}
            rx={2}
            stroke="#fde68a"
            strokeWidth={4}
            fill="none"
          />
          <rect x={12} y={7} width={8} height={18} fill="#fef3c7" />
        </>
      )}
      {kind === 'swing' && (
        <path
          d="M8 8 L24 24 M8 24 L24 8"
          stroke="#fecaca"
          strokeWidth={2.5}
          strokeLinecap="round"
        />
      )}
      {kind === 'foul' && (
        <>
          <circle cx={16} cy={16} r={15} fill="#f8fafc" stroke="#cbd5e1" />
          <path
            d="M11 2 C6 7 6 25 11 30 M21 2 C26 7 26 25 21 30 M8 7 L12 9 M6.5 12 L11 13 M6 16 L11 16 M6.5 20 L11 19 M8 25 L12 23 M24 7 L20 9 M25.5 12 L21 13 M26 16 L21 16 M25.5 20 L21 19 M24 25 L20 23"
            stroke="#dc2626"
            strokeWidth={1.3}
            fill="none"
          />
        </>
      )}
      {kind === 'contact' && (
        <path
          d="M4 28 L7 30 L27 10 Q31 5 27 2 Q24 0 20 6 Z M3 27 L8 32"
          stroke="#fde68a"
          strokeWidth={1.5}
          fill="#fde68a"
        />
      )}
      {kind === 'music' && (
        <path
          d="M16 4 v14.07 c-.79-.45 -1.69-.73 -2.67-.73 -2.95 0 -5.33 2.39 -5.33 5.33 s2.39 5.33 5.33 5.33 5.33-2.39 5.33-5.33 V9.33 h5.33 V4 Z"
          fill="#ffffff"
        />
      )}
    </svg>
  )
}
