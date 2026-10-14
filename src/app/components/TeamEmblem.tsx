import React from 'react'

import { Emblem, type EmblemProps } from './Emblem'
import { teamInitialsOf, teamTint } from './teamTile'

/** Every real team, including a placeholder, shares one name-based identity. */
export function TeamEmblem({
  name,
  ...props
}: { name: string } & Pick<
  EmblemProps,
  'uri' | 'size' | 'fitInitials'
>): React.ReactElement {
  const normalized = name.trim()
  const initials = teamInitialsOf(normalized)
  return (
    <Emblem
      {...props}
      fallback={initials === '' ? 'T' : initials}
      tint={teamTint(normalized)}
    />
  )
}
