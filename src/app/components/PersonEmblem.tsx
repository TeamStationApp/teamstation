import React from 'react'

import { Emblem, type EmblemProps } from './Emblem'
import { personTile } from './teamTile'

export type PersonEmblemProps = {
  /** Their primary account id: a merged account's rows carry the survivor's. */
  userId: string
  /** The name the row shows the reader, whose initials the tile draws. */
  name: string
} & Pick<EmblemProps, 'uri' | 'size' | 'initialsSize' | 'fitInitials'>

/**
 * A person's tile: their photo, or the initials of the name the row shows in
 * white on their account's colour (`personTint`), the same colour on every
 * screen and for every reader. With no id, the theme's untinted tile.
 */
export function PersonEmblem({
  userId,
  name,
  ...props
}: PersonEmblemProps): React.ReactElement {
  const tile = personTile({ userId, name })
  return (
    <Emblem
      {...props}
      shape="circle"
      fallback={tile.initials}
      tint={tile.tint}
    />
  )
}
