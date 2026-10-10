import React, { useCallback, useState } from 'react'
import { Text } from 'react-native'

import {
  asTeamSummary,
  type TeamStationClient,
  type TeamSummary
} from '../../common/api'
import type { GroupDetail } from '../../common/publicGroups'
import { Button, Screen } from '../components'
import { useForegroundRefresh } from '../hooks/useForegroundRefresh'
import { useLatestRequest } from '../hooks/useLatestRequest'
import { useTheme } from '../theme/ThemeContext'
import { TeamScreen, type TeamScreenProps } from './TeamScreen'

/** Every team address uses the same presentation and a current access answer. */
export function TeamPage({
  client,
  id,
  team: hint,
  onSettings,
  ...presentation
}: Omit<TeamScreenProps, 'team' | 'onManage' | 'publicDetail'> & {
  client: TeamStationClient
  id: string
  team?: TeamSummary
  onSettings?: (id: string) => void
}): React.ReactElement {
  const theme = useTheme()
  const [refreshRevision, setRefreshRevision] = useState(0)
  const [result, setResult] = useState<{
    id: string
    client: TeamStationClient
    detail?: GroupDetail
    error: string
  }>()
  const currentResult =
    result?.id === id && result.client === client ? result : undefined
  const detail = currentResult?.detail
  const error = currentResult?.error ?? ''
  const begin = useLatestRequest()
  const load = useCallback(async (): Promise<void> => {
    const current = begin()
    try {
      const found = await client.group({ kind: 'team', id })
      if (!current()) return
      setResult({ id, client, detail: found, error: '' })
      setRefreshRevision(value => value + 1)
    } catch (error) {
      if (!current()) return
      setResult({
        id,
        client,
        error:
          error instanceof Error ? error.message : 'The team could not load.'
      })
    }
  }, [client, id, begin])
  useForegroundRefresh(load)
  if (detail == null)
    return (
      <Screen>
        <Text
          accessibilityRole={error === '' ? undefined : 'alert'}
          style={{ color: theme.secondaryTextColor }}
        >
          {error === '' ? 'Loading…' : error}
        </Text>
        {error !== '' && (
          <Button
            label="Retry team"
            kind="secondary"
            onPress={() => {
              load().catch(() => undefined)
            }}
          />
        )}
      </Screen>
    )
  const group = detail.group
  const team = asTeamSummary({
    ...hint,
    id: group.id,
    name: group.name,
    shortName: null,
    logoPath: null,
    logoUrl: group.imageUrl,
    kind: group.external ? 'external' : 'full',
    canViewPrivate: detail.canViewPrivate
  })
  return (
    <TeamScreen
      key={`${group.id}:${detail.canViewPrivate}`}
      client={client}
      team={team}
      {...presentation}
      refreshRevision={refreshRevision}
      publicDetail={detail.canViewPrivate ? undefined : detail}
      onManage={
        detail.canManage && onSettings != null
          ? () => {
              onSettings(group.id)
            }
          : undefined
      }
    />
  )
}
