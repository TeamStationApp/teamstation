import React from 'react'

import {
  ADD_PERSON_GLYPH,
  type AddPersonGlyphProps
} from './addPersonGlyphShape'

/** The add-a-person glyph (a head and shoulders with a plus), as a DOM `<svg>`. */
export function AddPersonGlyph({
  color,
  background,
  size = 24
}: AddPersonGlyphProps): React.ReactElement {
  const { head, shoulders, badge, plus } = ADD_PERSON_GLYPH
  return (
    <svg
      aria-hidden="true"
      data-testid="addPersonGlyph"
      width={size}
      height={size}
      viewBox="0 0 24 24"
      style={{ display: 'block', flexShrink: 0 }}
    >
      <circle cx={head.cx} cy={head.cy} r={head.r} fill={color} />
      <path d={shoulders} fill={color} />
      <circle
        cx={badge.cx}
        cy={badge.cy}
        r={badge.r}
        fill={color}
        stroke={background}
        strokeWidth={1.8}
      />
      <path
        d={plus}
        stroke={background}
        strokeWidth={2.2}
        strokeLinecap="round"
        fill="none"
      />
    </svg>
  )
}
