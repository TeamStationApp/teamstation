import React from 'react'

import type { TeamStationClient } from '../../common/api'
import type { PublicGroup } from '../../common/publicGroups'
import { SectionHeader } from '../components'
import { ActionList } from '../components/ActionRow'
import { useConfirmedAction } from '../components/useConfirmedAction'
import {
  GroupRelationshipRow,
  relationshipDetails
} from './GroupRelationshipRow'
import { participationExplanation } from './participationExplanation'

export function ParticipationList({
  client,
  owner,
  groups,
  disabled = false,
  onLeft
}: {
  client: TeamStationClient
  owner: { kind: 'season' | 'team'; id: string; name: string }
  groups: PublicGroup[]
  disabled?: boolean
  onLeft: () => void
}): React.ReactElement | null {
  const seasonSide = owner.kind === 'season'
  const confirmation = useConfirmedAction(
    client,
    `${owner.kind}:${owner.id}:${owner.name}:${disabled}:${groups.map(g => `${g.id}:${g.name}`).join('|')}`
  )
  if (groups.length === 0) return null
  return (
    <>
      {seasonSide && <SectionHeader title="Participating teams" />}
      <ActionList
        bounded={!seasonSide}
        testID={
          seasonSide ? 'participating-teams-list' : 'season-participations-card'
        }
      >
        {groups.map(group => (
          <GroupRelationshipRow
            key={group.id}
            group={group}
            action={seasonSide ? 'End' : 'Leave'}
            label={
              seasonSide
                ? `End participation for ${group.name}`
                : `Leave season ${group.name}`
            }
            detail={relationshipDetails(group)}
            disabled={disabled || confirmation.busy}
            onLeave={() => {
              const team = seasonSide ? group : owner
              const season = seasonSide ? owner : group
              confirmation.open({
                title: seasonSide
                  ? `End participation for ${team.name} in ${season.name}?`
                  : `Leave ${season.name}?`,
                detail: participationExplanation,
                sheetLabel: seasonSide ? 'End participation' : 'Leave season',
                dismissLabel: seasonSide
                  ? 'Cancel participation end'
                  : 'Cancel season departure',
                fallback: 'Participation could not end. Retry.',
                testID: seasonSide
                  ? 'confirm-participation-end'
                  : 'confirm-season-departure',
                label: seasonSide
                  ? 'End participation'
                  : `Leave ${season.name}`,
                accessibilityLabel: seasonSide
                  ? 'Confirm end participation'
                  : undefined,
                run: async current => {
                  await client.endParticipation(season.id, team.id)
                  if (current()) onLeft()
                }
              })
            }}
          />
        ))}
      </ActionList>
      {confirmation.sheet}
    </>
  )
}
