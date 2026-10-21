import React, { useEffect, useState } from 'react'
import { Switch, View } from 'react-native'

import type { TeamStationClient } from '../../common/api'
import type { UmpireSettings } from '../../common/umpires'
import { ListCard, ListRow, SectionHeader } from '../components'
import { UmpireError, useUmpireWork } from './shared'
export type UmpireSettingsDestination =
  'leagueUmpires' | 'umpireLevels' | 'umpireRequirements' | 'umpireSchedule'
export function UmpireSettingsCard({
  client,
  league,
  onOpen,
  onChanged
}: {
  client: TeamStationClient
  league: string
  onOpen: (screen: UmpireSettingsDestination) => void
  onChanged?: () => void
}): React.ReactElement {
  const [hasLevels, setHasLevels] = useState(false)
  const [settings, setSettings] = useState<UmpireSettings>()
  const { error, busy, run, live } = useUmpireWork(league)
  useEffect(() => {
    run(async () => {
      const [value, levels] = await Promise.all([
        client.umpireSettings(league),
        client.umpireLevels(league)
      ])
      if (live()) {
        setSettings(value)
        setHasLevels(levels.length > 0)
      }
    })
  }, [client, league, live, run])
  const update = (value: Partial<UmpireSettings>): void => {
    run(async () => {
      const next = await client.setUmpireSettings(league, value)
      if (live()) {
        setSettings(next)
        onChanged?.()
      }
    })
  }
  const disabled = busy || settings?.management !== true
  return (
    <View>
      <SectionHeader title="Umpires" />
      <ListCard>
        <ListRow
          title="Umpire management"
          end={
            <Switch
              accessibilityLabel="Umpire management"
              value={settings?.management ?? false}
              disabled={busy || settings == null}
              onValueChange={management => {
                update({ management })
              }}
            />
          }
        />
        <ListRow
          title="Create Umpire Levels"
          disabled={disabled}
          onPress={() => {
            onOpen('umpireLevels')
          }}
        />
        <ListRow
          title="Set Requirements"
          disabled={disabled || !hasLevels}
          onPress={() => {
            onOpen('umpireRequirements')
          }}
        />
        <ListRow
          title="Team credits"
          disabled={disabled}
          end={
            <Switch
              accessibilityLabel="Team credits"
              value={settings?.credits ?? false}
              disabled={disabled}
              onValueChange={credits => {
                update({ credits })
              }}
            />
          }
        />
        <ListRow
          title="Add Umpires"
          disabled={disabled}
          onPress={() => {
            onOpen('leagueUmpires')
          }}
        />
        <ListRow
          title="Umpire schedule"
          disabled={disabled}
          onPress={() => {
            onOpen('umpireSchedule')
          }}
        />
      </ListCard>
      <UmpireError error={error} />
    </View>
  )
}
