import React, { useEffect, useState } from 'react'
import { Text } from 'react-native'

import type { TeamStationClient } from '../../common/api'
import type { GroupDetail } from '../../common/publicGroups'
import { Button, DangerText, Screen } from '../components'
import { useLatestRequest } from '../hooks/useLatestRequest'
import { LocationScreen } from './LocationScreen'

export function GroupLocationPage({
  client,
  kind,
  id,
  onDone
}: {
  client: TeamStationClient
  kind: 'team' | 'league'
  id: string
  onDone: () => void
}): React.ReactElement {
  const [detail, setDetail] = useState<GroupDetail>()
  const [error, setError] = useState('')
  const [revision, setRevision] = useState(0)
  const begin = useLatestRequest()
  const beginSave = useLatestRequest()
  useEffect(() => {
    const current = begin()
    beginSave()
    setDetail(undefined)
    setError('')
    client.group({ kind, id }).then(
      value => {
        if (current()) {
          setDetail(value)
          setError('')
        }
      },
      () => {
        if (current()) setError('Location could not load. Try again.')
      }
    )
  }, [client, kind, id, revision, begin, beginSave])
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
        <DangerText label="Cancel" onPress={onDone} />
      </Screen>
    )
  if (!detail.canManage)
    return (
      <Screen>
        <Text>Only a current administrator can change these settings.</Text>
        <DangerText label="Cancel" onPress={onDone} />
      </Screen>
    )
  return (
    <LocationScreen
      client={client}
      current={detail.group.locality}
      onCancel={onDone}
      onSave={async locality => {
        const current = beginSave()
        await client.updateGroup({ kind, id: detail.group.id }, { locality })
        if (current()) onDone()
      }}
    />
  )
}
