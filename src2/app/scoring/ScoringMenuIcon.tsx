import React from 'react'

import { type MenuIconKind, menuIconPaths } from './scoringMenuIcons'

/** Local outlines keep menu icons available even before web fonts load. */
export function ScoringMenuIcon({
  kind,
  color
}: {
  kind: MenuIconKind
  color: string
}): React.ReactElement {
  return (
    <svg
      aria-hidden="true"
      width={16}
      height={16}
      viewBox="0 0 24 24"
      style={{ display: 'block', flexShrink: 0 }}
    >
      <path
        d={menuIconPaths[kind]}
        stroke={color}
        strokeWidth={1.7}
        strokeLinecap="round"
        strokeLinejoin="round"
        fill="none"
      />
    </svg>
  )
}
