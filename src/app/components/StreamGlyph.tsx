import React from 'react'

import { STREAM_GLYPHS, type StreamGlyphProps } from './streamGlyphShape'

/** Camera setup's two row icons, which Material Symbols does not draw. */
export function StreamGlyph(props: StreamGlyphProps): React.ReactElement {
  const { name, color, size = 28 } = props
  return (
    <svg
      aria-hidden="true"
      data-testid={`stream-glyph-${name}`}
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill={color}
      fillRule="evenodd"
      style={{ display: 'block', flexShrink: 0 }}
    >
      {STREAM_GLYPHS[name].map(path => (
        <path key={path} d={path} />
      ))}
    </svg>
  )
}
