import React from 'react'

import { Emblem, type EmblemProps } from './Emblem'
import { groupTile } from './teamTile'

export type TeamEmblemProps = {
  /**
   * The team's id, which picks its colour (`teamTint`). Null only for a team
   * that is not saved yet, which draws the theme's untinted tile.
   */
  teamId: string | null
  name: string
} & Pick<EmblemProps, 'uri' | 'size' | 'fitInitials'>

/** Every real team, including a placeholder, is its initials on its id's colour. */
export function TeamEmblem({
  teamId,
  name,
  uri,
  ...props
}: TeamEmblemProps): React.ReactElement {
  const tile = groupTile({ kind: 'team', id: teamId, name, uri })
  return (
    <Emblem
      {...props}
      uri={tile.uri}
      fallback={tile.initials}
      tint={tile.tint}
    />
  )
}
