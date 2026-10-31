import React from 'react'
import Svg, { Path } from 'react-native-svg'

import { STREAM_GLYPHS, type StreamGlyphProps } from './streamGlyphShape'

/** The same two icons as the web file, drawn with `react-native-svg`. */
export function StreamGlyph(props: StreamGlyphProps): React.ReactElement {
  const { name, color, size = 28 } = props
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24" pointerEvents="none">
      {STREAM_GLYPHS[name].map(path => (
        <Path key={path} d={path} fill={color} fillRule="evenodd" />
      ))}
    </Svg>
  )
}
