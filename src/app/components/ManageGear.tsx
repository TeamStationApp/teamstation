import React, { useEffect, useState } from 'react'
import { Pressable, View } from 'react-native'

import type { TeamStationClient } from '../../common/api'
import { lstrings } from '../locales/strings'
import { cacheStyles, type Theme, useTheme } from '../theme/ThemeContext'
import { Icon } from './Icon'

export interface ManageGearProps {
  client: TeamStationClient
  scopeType: 'league' | 'season' | 'team'
  scopeId: string
  onPress: () => void
  accessibilityLabel?: string
}

/**
 * The gear in the bottom right corner of a team, season or league card.
 *
 * Only for somebody who administers that scope, and the server is what
 * decides: the same answer that says whether invites may be made says whether
 * this appears. Everybody else sees an unchanged card rather than a gear that
 * turns them away, because a door you cannot open is worse than no door.
 *
 * A disc, the same one the navigation uses, rather than a bare glyph: on a
 * card already carrying an emblem, a record and a place pill, an unbacked
 * icon reads as another piece of information rather than as something to
 * press. The corner is the bottom right because the top right belongs to the
 * place pill, and two things in one corner is one too many.
 */
export function ManageGear(props: ManageGearProps): React.ReactElement {
  const { client, scopeType, scopeId, onPress } = props
  const theme = useTheme()
  const styles = getStyles(theme)
  const [may, setMay] = useState(false)

  useEffect(() => {
    let live = true
    client
      .invites(scopeType, scopeId)
      .then(answer => {
        if (live) setMay(answer.canInvite)
      })
      .catch(() => undefined)
    return () => {
      live = false
    }
  }, [client, scopeId, scopeType])

  if (!may) return <View />

  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={props.accessibilityLabel ?? lstrings.manage_open}
      onPress={onPress}
      style={({ pressed }) => [styles.gear, pressed && styles.pressed]}
    >
      <Icon name="settings" size={1.25} color={theme.secondaryTextColor} />
    </Pressable>
  )
}

const getStyles = cacheStyles((theme: Theme) => ({
  gear: {
    width: theme.rem(2),
    height: theme.rem(2),
    borderRadius: theme.rem(1),
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: theme.containerBackgroundColor
  },
  pressed: {
    opacity: 0.6
  }
}))
