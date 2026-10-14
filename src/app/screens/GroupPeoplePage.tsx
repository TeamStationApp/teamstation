import React, { useEffect, useState } from 'react'
import { Text } from 'react-native'

import type { TeamStationClient } from '../../common/api'
import type { GroupRef } from '../../common/groupCreation'
import type { GroupDetail } from '../../common/publicGroups'
import { Button, Screen } from '../components'
import { CancelAction } from '../components/CancelAction'
import { useLatestRequest } from '../hooks/useLatestRequest'
import { AddPeopleScreen } from './AddPeopleScreen'
import { InviteSpectatorsScreen } from './InviteSpectatorsScreen'

export function GroupPeoplePage({
  client,
  group,
  invites,
  onDone
}: {
  client: TeamStationClient
  group: GroupRef
  invites: boolean
  onDone: () => void
}): React.ReactElement {
  const [detail, setDetail] = useState<GroupDetail>()
  const [error, setError] = useState('')
  const [revision, setRevision] = useState(0)
  const begin = useLatestRequest()
  useEffect(() => {
    const current = begin()
    setDetail(undefined)
    setError('')
    client.group({ kind: group.kind, id: group.id }).then(
      value => {
        if (current()) {
          setDetail(value)
          setError('')
        }
      },
      () => {
        if (current()) setError('Settings could not load. Try again.')
      }
    )
  }, [client, group.kind, group.id, revision, begin])
  if (detail == null)
    return (
      <Screen>
        <Text>{error === '' ? 'Loading…' : error}</Text>
        {error !== '' && (
          <Button
            label="Retry"
            onPress={() => {
              setRevision(value => value + 1)
            }}
          />
        )}
        <CancelAction label="Cancel" onPress={onDone} />
      </Screen>
    )
  if (!detail.canManage)
    return (
      <Screen>
        <Text>Only a current administrator can change these settings.</Text>
        <CancelAction label="Cancel" onPress={onDone} />
      </Screen>
    )
  const ref = { kind: detail.group.kind, id: detail.group.id }
  return invites ? (
    <InviteSpectatorsScreen
      client={client}
      group={ref}
      scopeName={detail.group.name}
    />
  ) : (
    <AddPeopleScreen
      client={client}
      group={ref}
      scopeName={detail.group.name}
      onDone={onDone}
      onCancel={onDone}
    />
  )
}
