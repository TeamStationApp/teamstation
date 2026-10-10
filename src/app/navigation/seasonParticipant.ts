import type { TeamSummary } from '../../common/api'

/** A season participant can be visible without private team collection access. */
export function seasonParticipantDestination(
  team: TeamSummary
):
  | { name: 'team'; team: TeamSummary }
  | { name: 'group'; kind: 'team'; id: string } {
  return team.canViewPrivate
    ? { name: 'team', team }
    : { name: 'group', kind: 'team', id: team.id }
}
