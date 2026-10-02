import React from 'react'

import { useTheme } from '../theme/ThemeContext'
import {
  MARK_ARC_PATHS,
  MARK_BODY_PATHS,
  MARK_TRANSFORM,
  MARK_VIEW_BOX
} from './gsMarkPaths'

export interface GsMarkProps {
  /** In rem, like every other size in the app. */
  size?: number
}

/**
 * The GameStation mark.
 *
 * Drawn rather than drawn *on*: the shipped artwork was a cream tile with the
 * G printed on it, so it sat in the header as a pale square a slightly
 * different colour from the header behind it. Here the cream is not painted at
 * all — the background, the counter of the G and the blade of grass are holes,
 * and whatever is behind the mark shows through them.
 *
 * Two fills, from the theme. On a pale header the body of the G is the dark
 * green; on `gsDark` it is the olive cream, because dark green on a dark green
 * header is a mark with a hole in it. One shape, two colours, no second file.
 *
 * Inline SVG rather than an `Image`: an SVG behind an `<img>` cannot see the
 * page's colours, so a themed mark would have meant shipping one file per
 * theme. This app already renders DOM where it has to — the player is a raw
 * `<video>` — and this is the same seam.
 */
export function GsMark(props: GsMarkProps): React.ReactElement {
  const { size = 1.75 } = props
  const theme = useTheme()
  const side = theme.rem(size)
  return (
    <svg
      width={side}
      height={side}
      viewBox={MARK_VIEW_BOX}
      role="img"
      aria-label="GameStation"
      style={{ display: 'block', flexShrink: 0 }}
    >
      <g transform={MARK_TRANSFORM}>
        <g fill={theme.markArcColor}>
          {MARK_ARC_PATHS.map(path => (
            <path key={path.slice(0, 24)} d={path} />
          ))}
        </g>
        <g fill={theme.markBodyColor}>
          {MARK_BODY_PATHS.map(path => (
            <path key={path.slice(0, 24)} d={path} />
          ))}
        </g>
      </g>
    </svg>
  )
}
