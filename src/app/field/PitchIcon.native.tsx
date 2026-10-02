import React from 'react'
import Svg, { Circle, Path } from 'react-native-svg'

export function PitchIcon({ kind }: { kind: string }): React.ReactElement {
  const fill =
    kind === 'foul'
      ? '#fff19a'
      : kind === 'called' || kind === 'swing'
        ? '#efb34f'
        : '#fffaf0'
  return (
    <Svg width={18} height={22} viewBox="0 0 28 28">
      <Circle
        cx="14"
        cy="14"
        r="10"
        fill={fill}
        stroke="#cabd97"
        strokeWidth="1"
      />
      <Path
        d="M8 6 Q15 14 8 22 M20 6 Q13 14 20 22 M9 9 l-3 1 M11 13 l-3 1 M10 17 l-3 1 M19 9 l3 1 M17 13 l3 1 M18 17 l3 1"
        fill="none"
        stroke="#bf4242"
        strokeWidth="1.4"
      />
      {kind === 'play' && (
        <Path
          d="M5 25 L14 13 Q20 2 24 3 Q28 6 17 16 L7 27 Z"
          fill="#986037"
          stroke="#593a23"
          strokeWidth="1.4"
        />
      )}
    </Svg>
  )
}
