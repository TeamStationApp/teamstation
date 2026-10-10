import React from 'react'

import { useScoringSheetTheme } from './scoringSheetTheme'
export function DefensiveFieldArt(): React.ReactElement {
  const { scoringSurface: surface } = useScoringSheetTheme()
  return (
    <svg
      width="100%"
      height="100%"
      viewBox="0 0 360 240"
      preserveAspectRatio="none"
      aria-label="Top-down baseball field"
      style={{ pointerEvents: 'none' }}
    >
      <path
        d="M180 220 L15 55 Q180 -45 345 55 Z"
        fill={surface.idle}
        stroke={surface.border}
        strokeWidth="2"
      />
      <path
        d="M180 214 L91 136 L180 66 L269 136 Z"
        fill={surface.input}
        stroke={surface.inputBorder}
        strokeWidth="2"
      />
      <path
        d="M180 214 L15 55 M180 214 L345 55"
        fill="none"
        stroke={surface.secondaryText}
        strokeWidth="2"
      />
      <circle
        cx="180"
        cy="144"
        r="10"
        fill={surface.badges.green.background}
        stroke={surface.inputBorder}
      />
      <path
        d="M174 210 L186 210 L186 217 L180 222 L174 217 Z M86 131 L96 131 L96 141 L86 141 Z M175 61 L185 61 L185 71 L175 71 Z M264 131 L274 131 L274 141 L264 141 Z"
        fill={surface.activeText}
        stroke={surface.inputBorder}
      />
    </svg>
  )
}
