import React from 'react'
import Svg, { Path } from 'react-native-svg'

import { lineupQrGlyphPaths, type LineupQrGlyphProps } from './lineupQrGlyphs'

/** The QR and scan glyphs, as a native `Svg`. */
export function LineupQrGlyph({
  kind,
  color,
  size = 24,
  strokeWidth = 1.7
}: LineupQrGlyphProps): React.ReactElement {
  return (
    <Svg
      testID={`lineupQrGlyph-${kind}`}
      width={size}
      height={size}
      viewBox="0 0 24 24"
      accessible={false}
    >
      <Path
        d={lineupQrGlyphPaths[kind]}
        stroke={color}
        strokeWidth={strokeWidth}
        strokeLinecap="round"
        strokeLinejoin="round"
        fill="none"
      />
    </Svg>
  )
}
