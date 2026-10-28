import React from 'react'
import Svg, { Circle, Path } from 'react-native-svg'

import {
  ADD_PERSON_GLYPH,
  type AddPersonGlyphProps
} from './addPersonGlyphShape'

/** The add-a-person glyph (a head and shoulders with a plus), as a native `Svg`. */
export function AddPersonGlyph({
  color,
  background,
  size = 24
}: AddPersonGlyphProps): React.ReactElement {
  const { head, shoulders, badge, plus } = ADD_PERSON_GLYPH
  return (
    <Svg
      testID="addPersonGlyph"
      width={size}
      height={size}
      viewBox="0 0 24 24"
      accessible={false}
    >
      <Circle cx={head.cx} cy={head.cy} r={head.r} fill={color} />
      <Path d={shoulders} fill={color} />
      <Circle
        cx={badge.cx}
        cy={badge.cy}
        r={badge.r}
        fill={color}
        stroke={background}
        strokeWidth={1.8}
      />
      <Path
        d={plus}
        stroke={background}
        strokeWidth={2.2}
        strokeLinecap="round"
        fill="none"
      />
    </Svg>
  )
}
