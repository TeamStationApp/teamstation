import React from 'react'

import { lineupQrGlyphPaths, type LineupQrGlyphProps } from './lineupQrGlyphs'

/** The QR and scan glyphs, as a DOM `<svg>`. */
export function LineupQrGlyph({
  kind,
  color,
  size = 24,
  strokeWidth = 1.7
}: LineupQrGlyphProps): React.ReactElement {
  return (
    <svg
      aria-hidden="true"
      data-testid={`lineupQrGlyph-${kind}`}
      width={size}
      height={size}
      viewBox="0 0 24 24"
      style={{ display: 'block', flexShrink: 0 }}
    >
      <path
        d={lineupQrGlyphPaths[kind]}
        stroke={color}
        strokeWidth={strokeWidth}
        strokeLinecap="round"
        strokeLinejoin="round"
        fill="none"
      />
    </svg>
  )
}
