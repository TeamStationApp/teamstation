import React from 'react'
import { Path, Svg } from 'react-native-svg'

import { UMPIRE_MASK_PATH, UMPIRE_TROPHY_PATH } from './umpireMaskPath'
export function UmpireMaskDrawing({
  size,
  color,
  trophy = false
}: {
  size: number
  color: string
  trophy?: boolean
}): React.ReactElement {
  return (
    <Svg width={size} height={size} viewBox="0 0 32 32">
      <Path
        d={trophy ? UMPIRE_TROPHY_PATH : UMPIRE_MASK_PATH}
        fill="none"
        stroke={color}
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </Svg>
  )
}
