import React from 'react'

import { Emblem, type EmblemProps } from './Emblem'
import { TeamEmblem } from './TeamEmblem'
import { groupTile, type GroupTileSource } from './teamTile'

export type GroupEmblemProps = GroupTileSource &
  Pick<EmblemProps, 'size' | 'fitInitials'>

/**
 * A team, league or season tile: its picture, or its initials on the colour
 * its id gives it (`groupTile`). A season without a picture of its own draws
 * its league's, and sits on its league's colour.
 */
export function GroupEmblem(props: GroupEmblemProps): React.ReactElement {
  const { size, fitInitials } = props
  if (props.kind === 'team')
    return (
      <TeamEmblem
        teamId={props.id}
        name={props.name}
        uri={props.uri}
        size={size}
        fitInitials={fitInitials}
      />
    )
  const tile = groupTile(props)
  return (
    <Emblem
      uri={tile.uri}
      size={size}
      fitInitials={fitInitials}
      fallback={tile.initials}
      tint={tile.tint}
    />
  )
}
