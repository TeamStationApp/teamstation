import React from 'react'
import { G, Path, Svg } from 'react-native-svg'

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
 * The GameStation mark, drawn the same way, by a different renderer.
 *
 * The same paths, the same view box, the same two fills from the theme — the
 * only difference is that `react-native-svg` draws them instead of the
 * browser. That is what keeps the mark from being a second file to keep in
 * step: the shape lives in `gsMarkPaths.ts` and both platforms read it.
 *
 * Still not an image, for the reason the web file gives: the cream is not
 * painted at all, so the background, the counter of the G and the blade of
 * grass are holes that whatever is behind the mark shows through — including
 * the glass of the header.
 */
export function GsMark(props: GsMarkProps): React.ReactElement {
  const { size = 1.75 } = props
  const theme = useTheme()
  const side = theme.rem(size)
  return (
    <Svg
      width={side}
      height={side}
      viewBox={MARK_VIEW_BOX}
      accessibilityLabel="GameStation"
    >
      <G transform={MARK_TRANSFORM}>
        <G fill={theme.markArcColor}>
          {MARK_ARC_PATHS.map(path => (
            <Path key={path.slice(0, 24)} d={path} />
          ))}
        </G>
        <G fill={theme.markBodyColor}>
          {MARK_BODY_PATHS.map(path => (
            <Path key={path.slice(0, 24)} d={path} />
          ))}
        </G>
      </G>
    </Svg>
  )
}
