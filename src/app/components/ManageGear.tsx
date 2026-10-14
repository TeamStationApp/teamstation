import React, { useEffect, useState } from 'react'
import { View } from 'react-native'

import type { TeamStationClient } from '../../common/api'
import { lstrings } from '../locales/strings'
import { SettingsGear } from './SettingsGear'

export interface ManageGearProps {
  client: TeamStationClient
  scopeType: 'league' | 'season' | 'team'
  scopeId: string
  onPress: () => void
  accessibilityLabel?: string
}

/** Settings access is decided by the server's scope invitation permission. */
export function ManageGear(props: ManageGearProps): React.ReactElement {
  const { client, scopeType, scopeId, onPress } = props
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
    <SettingsGear
      onPress={onPress}
      label={props.accessibilityLabel ?? lstrings.manage_open}
    />
  )
}
