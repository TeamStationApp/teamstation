import React, { useCallback, useRef, useState } from 'react'
import { Text } from 'react-native'

import {
  asTeamSummary,
  groupPath,
  type TeamStationClient,
  type TeamSummary
} from '../../common/api'
import { asGroupDetail, type GroupDetail } from '../../common/publicGroups'
import { Button, Screen } from '../components'
import { useLatestRequest } from '../hooks/useLatestRequest'
import { useNoticedRead } from '../hooks/useNoticedRead'
import { useScreenScope } from '../hooks/useScreenScope'
import { StoredFirst } from '../sync/storedFirst'
import { useTheme } from '../theme/ThemeContext'
import { TeamScreen, type TeamScreenProps } from './TeamScreen'

/** Every team address uses the same presentation and a current access answer. */
export function TeamPage({
  client,
  id,
  team: hint,
  onSettings,
  onCreateGame,
  onLoaded,
  onAddPeople,
  onAddExistingPlayer,
  onCreatePlayer,
  ...presentation
}: Omit<
  TeamScreenProps,
  | 'team'
  | 'onManage'
  | 'publicDetail'
  | 'nonMemberView'
  | 'managesPeople'
  | 'onCreateGame'
  | 'onAddPeople'
  | 'onAddPlayer'
> & {
  client: TeamStationClient
  id: string
  team?: TeamSummary
  onSettings?: (id: string) => void
  onCreateGame?: (id: string) => void
  /** The team as the server named it, each time it loads. */
  onLoaded?: (team: { id: string; name: string }) => void
  /** Add People, Add Player and Create Player, offered as settings offers them. */
  onAddPeople?: (id: string, role?: 'admin') => void
  onAddExistingPlayer?: (id: string) => void
  onCreatePlayer?: (id: string) => void
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
  const loaded = useRef(onLoaded)
  loaded.current = onLoaded
  const shown = useRef(detail)
  shown.current = detail
  const load = useCallback(async (): Promise<void> => {
    const current = begin()
    // What the phone stored for the team paints at once while nothing is
    // shown, and the team's own screen reads its lists under it: with no
    // signal the read answers the same, but only once its deadline passed.
    const stored = new StoredFirst()
    let painted = false
    stored
      .paint(
        client,
        groupPath({ kind: 'team', id }),
        asGroupDetail,
        value => {
          painted = true
          setResult({ id, client, detail: value, error: '' })
          loaded.current?.({ id: value.group.id, name: value.group.name })
        },
        () => current() && shown.current == null
      )
      .catch(() => undefined)
    try {
      const found = await client.group({ kind: 'team', id })
      stored.answered()
      if (!current()) return
      setResult({ id, client, detail: found, error: '' })
      // The screen the stored team opened is already reading its lists.
      if (!painted) setRefreshRevision(value => value + 1)
      loaded.current?.({ id: found.group.id, name: found.group.name })
    } catch (error) {
      stored.answered()
      if (!current()) return
      setResult({
        id,
        client,
        error:
          error instanceof Error ? error.message : 'The team could not load.'
      })
    }
  }, [client, id, begin])
  useNoticedRead(useScreenScope(load, client))
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
  // Anybody signed in gets the members' page, less what the server keeps for
  // members when they are not one; only somebody signed out gets the public
  // one. The same page however the team was reached: Search, a follow, a
  // game or a link.
  const full = detail.canViewPrivate || detail.nonMemberView
  return (
    <TeamScreen
      key={`${group.id}:${detail.canViewPrivate}:${detail.nonMemberView}`}
      client={client}
      team={team}
      {...presentation}
      refreshRevision={refreshRevision}
      publicDetail={full ? undefined : detail}
      nonMemberView={detail.nonMemberView}
      managesPeople={detail.canManagePeople === true}
      onCreateGame={
        detail.canManagePeople === true && onCreateGame != null
          ? () => {
              onCreateGame(group.id)
            }
          : undefined
      }
      onAddPeople={
        detail.canManage && !group.external && onAddPeople != null
          ? role => {
              onAddPeople(group.id, role)
            }
          : undefined
      }
      onAddPlayer={
        detail.canManageRoster &&
        !group.external &&
        onAddExistingPlayer != null &&
        onCreatePlayer != null
          ? {
              existing: () => {
                onAddExistingPlayer(group.id)
              },
              create: () => {
                onCreatePlayer(group.id)
              }
            }
          : undefined
      }
      onManage={
        (detail.canManage || detail.canManageRoster) && onSettings != null
          ? () => {
              onSettings(group.id)
            }
          : undefined
      }
    />
  )
}
