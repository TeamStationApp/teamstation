import React, { useEffect, useState } from 'react'
import { Switch, View } from 'react-native'

import type { TeamStationClient } from '../../common/api'
import type { UmpireSettings } from '../../common/umpires'
import { ListCard, ListRow, SectionHeader } from '../components'
import { useSceneReveals } from '../components/sceneShown'
import { useTheme } from '../theme/ThemeContext'
import { UmpireError, useUmpireWork } from './shared'
export type UmpireSettingsDestination =
  | 'leagueUmpires'
  | 'umpireTypes'
  | 'umpireNoteTypes'
  | 'umpireLevels'
  | 'umpireRequirements'
  | 'umpireSchedule'
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
  const theme = useTheme()
  const [hasLevels, setHasLevels] = useState(false)
  const [settings, setSettings] = useState<UmpireSettings>()
  const { error, busy, run, live } = useUmpireWork(league)
  // Levels and types, added on the screens pushed over this one, enable the
  // season requirements below.
  const reveals = useSceneReveals()
  useEffect(() => {
    run(async () => {
      const [value, levels, types] = await Promise.all([
        client.umpireSettings(league),
        client.umpireLevels(league),
        client.umpireTypes(league)
      ])
      if (live()) {
        setSettings(value)
        setHasLevels(levels.length > 0 && types.length > 0)
      }
    })
  }, [client, league, live, run, reveals])
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
    <View style={{ gap: theme.rem(0.75) }}>
      <SectionHeader title="Umpire Management" />
      <ListCard>
        <ListRow
          title="Enable umpire management"
          end={
            <Switch
              accessibilityLabel="Enable umpire management"
              value={settings?.management ?? false}
              disabled={busy || settings == null}
              onValueChange={management => {
                update({ management })
              }}
            />
          }
        />
        <ListRow
          title="Manage Umpire Types"
          muted={disabled}
          disabled={disabled}
          onPress={() => {
            onOpen('umpireTypes')
          }}
        />
        <ListRow
          title="Manage Umpire Levels"
          muted={disabled}
          disabled={disabled}
          onPress={() => {
            onOpen('umpireLevels')
          }}
        />
        <ListRow
          title="Set Season Requirements"
          muted={disabled || !hasLevels}
          disabled={disabled || !hasLevels}
          onPress={() => {
            onOpen('umpireRequirements')
          }}
        />
        <ListRow
          title="Manage Umpires"
          muted={disabled}
          disabled={disabled}
          onPress={() => {
            onOpen('leagueUmpires')
          }}
        />
        <ListRow
          title="Umpire schedule"
          muted={disabled}
          disabled={disabled}
          onPress={() => {
            onOpen('umpireSchedule')
          }}
        />
        <ListRow
          title="Manage Umpire Game Notes"
          muted={disabled}
          disabled={disabled}
          onPress={() => {
            onOpen('umpireNoteTypes')
          }}
        />
        <ListRow
          title="Enable Team Credits"
          subtitle="Allow umpires to credit teams that they are a member of."
          subtitleNumberOfLines={0}
          muted={disabled}
          disabled={disabled}
          end={
            <Switch
              accessibilityLabel="Enable Team Credits"
              value={settings?.credits ?? false}
              disabled={disabled}
              onValueChange={credits => {
                update({ credits })
              }}
            />
          }
        />
      </ListCard>
      <UmpireError error={error} />
    </View>
  )
}
