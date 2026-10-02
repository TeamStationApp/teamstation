import React, { useId } from 'react'
import { Defs, G, LinearGradient, Path, Stop, Svg } from 'react-native-svg'

import { useTheme } from '../theme/ThemeContext'
import {
  MARK_GRADIENT,
  MARK_GRADIENT_STOPS,
  MARK_PATHS,
  MARK_STROKE_WIDTH,
  MARK_VIEW_BOX
} from './tsMarkPaths'

export interface TsMarkProps {
  /** In rem, like every other size in the app. */
  size?: number
}

/**
 * The TeamStation mark, drawn by `react-native-svg` from the same paths,
 * view box and theme colours as the web file, which says why it is strokes
 * over nothing rather than an image.
 */
export function TsMark(props: TsMarkProps): React.ReactElement {
  const { size = 1.75 } = props
  const theme = useTheme()
  const side = theme.rem(size)
  const gradient = `tsMark${useId().replace(/:/g, '')}`
  return (
    <Svg
      width={side}
      height={side}
      viewBox={MARK_VIEW_BOX}
      accessibilityLabel="TeamStation"
    >
      <Defs>
        <LinearGradient
          id={gradient}
          gradientUnits="userSpaceOnUse"
          x1={MARK_GRADIENT.x1}
          y1={MARK_GRADIENT.y1}
          x2={MARK_GRADIENT.x2}
          y2={MARK_GRADIENT.y2}
        >
          <Stop
            offset={MARK_GRADIENT_STOPS[0]}
            stopColor={theme.markGradientStart}
          />
          <Stop
            offset={MARK_GRADIENT_STOPS[1]}
            stopColor={theme.markGradientEnd}
          />
        </LinearGradient>
      </Defs>
      <G
        fill="none"
        stroke={`url(#${gradient})`}
        strokeWidth={MARK_STROKE_WIDTH}
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        {MARK_PATHS.map(path => (
          <Path key={path} d={path} />
        ))}
      </G>
    </Svg>
  )
}
