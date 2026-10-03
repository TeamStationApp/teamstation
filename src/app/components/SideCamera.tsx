import React from 'react'

import { useTheme } from '../theme/ThemeContext'

/**
 * A camera seen from the side, filled in.
 *
 * The schedule uses it where a thumbnail used to say that a game was
 * recorded. Small, and out of the way: the date and the result are the row.
 */
export function SideCamera(): React.ReactElement {
  const theme = useTheme()
  const width = theme.rem(1.25)
  const height = theme.rem(1)
  const color = theme.secondaryTextColor
  return (
    <svg
      width={width}
      height={height}
      viewBox="0 0 20 16"
      aria-label="Video"
      fill={color}
      style={{ display: 'block', pointerEvents: 'none' }}
    >
      <path d="M4 4.2V2.7A1.2 1.2 0 0 1 5.2 1.5h2.6A1.2 1.2 0 0 1 9 2.7v1.5z" />
      <path d="M1.2 5.2A1.6 1.6 0 0 1 2.8 3.6h8.4A1.6 1.6 0 0 1 12.8 5.2v6.2A1.6 1.6 0 0 1 11.2 13H2.8A1.6 1.6 0 0 1 1.2 11.4z" />
      <path d="M12.8 6.3 18.2 4.4a.7.7 0 0 1 1 .6v6.6a.7.7 0 0 1-1 .6l-5.4-1.9z" />
    </svg>
  )
}
