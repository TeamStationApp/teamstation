import React, { useEffect, useState } from 'react'

import type { TeamStationClient } from '../../common/api'
import type { GroupRef } from '../../common/groupCreation'
import { Button } from './Button'

/**
 * Follow, or Following to stop, for a team or season somebody neither runs
 * nor belongs to. It asks for the person's follows itself, and draws nothing
 * until it knows — or at all when nobody is signed in.
 *
 * Following changes no access: it only puts the group on the person's Home.
 */
export function FollowButton(props: {
  client: TeamStationClient
  group: GroupRef
  name: string
}): React.ReactElement | null {
  const { client, group, name } = props
  const [following, setFollowing] = useState<boolean>()
  const [busy, setBusy] = useState(false)
  useEffect(() => {
    let active = true
    setFollowing(undefined)
    client.follows().then(
      groups => {
        if (active)
          setFollowing(
            groups.some(
              followed =>
                followed.kind === group.kind && followed.id === group.id
            )
          )
      },
      () => undefined
    )
    return () => {
      active = false
    }
  }, [client, group.kind, group.id])
  if (following == null) return null
  return (
    <Button
      label={following ? 'Following' : 'Follow'}
      accessibilityLabel={`${following ? 'Unfollow' : 'Follow'} ${name}`}
      compact
      kind={following ? 'secondary' : 'primary'}
      busy={busy}
      onPress={() => {
        setBusy(true)
        ;(following
          ? client.unfollow(group)
          : client.follow(group).then(() => undefined)
        )
          .then(
            () => {
              setFollowing(!following)
            },
            () => undefined
          )
          .finally(() => {
            setBusy(false)
          })
      }}
    />
  )
}
