import React, { useId } from 'react'

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
 * The TeamStation mark.
 *
 * Three strokes and nothing filled, so the header's glass shows through the
 * middle of the square. The gradient's two colours come from the theme: on a
 * pale header it runs from the light green to the dark one; on `tsDark` it
 * runs to the cream instead, because dark green on a dark header is half a
 * mark.
 *
 * Inline SVG rather than an `Image`: an SVG behind an `<img>` cannot see the
 * page's colours, so a themed mark would mean one file per theme.
 */
export function TsMark(props: TsMarkProps): React.ReactElement {
  const { size = 1.75 } = props
  const theme = useTheme()
  const side = theme.rem(size)
  // One gradient per mark on the page: two marks sharing an id would both
  // draw with whichever gradient the document met first.
  const gradient = `tsMark${useId().replace(/:/g, '')}`
  return (
    <svg
      width={side}
      height={side}
      viewBox={MARK_VIEW_BOX}
      role="img"
      aria-label="TeamStation"
      style={{ display: 'block', flexShrink: 0 }}
    >
      <defs>
        <linearGradient
          id={gradient}
          gradientUnits="userSpaceOnUse"
          x1={MARK_GRADIENT.x1}
          y1={MARK_GRADIENT.y1}
          x2={MARK_GRADIENT.x2}
          y2={MARK_GRADIENT.y2}
        >
          <stop
            offset={MARK_GRADIENT_STOPS[0]}
            stopColor={theme.markGradientStart}
          />
          <stop
            offset={MARK_GRADIENT_STOPS[1]}
            stopColor={theme.markGradientEnd}
          />
        </linearGradient>
      </defs>
      <g
        fill="none"
        stroke={`url(#${gradient})`}
        strokeWidth={MARK_STROKE_WIDTH}
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        {MARK_PATHS.map(path => (
          <path key={path} d={path} />
        ))}
      </g>
    </svg>
  )
}
