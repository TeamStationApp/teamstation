import React from 'react'
import Svg, { Path } from 'react-native-svg'

import { type MenuIconKind, menuIconPaths } from './scoringMenuIcons'

export function ScoringMenuIcon({
  kind,
  color
}: {
  kind: MenuIconKind
  color: string
}): React.ReactElement {
  return (
    <Svg width={16} height={16} viewBox="0 0 24 24" accessible={false}>
      <Path
        d={menuIconPaths[kind]}
        stroke={color}
        strokeWidth={1.7}
        strokeLinecap="round"
        strokeLinejoin="round"
        fill="none"
      />
    </Svg>
  )
}
