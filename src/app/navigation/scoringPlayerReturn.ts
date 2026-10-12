import type { Route } from './routes'

export interface ScoringPlayerOrigin {
  gameId: string
  userId: string
  teamId: string
}
/** Only this player/team visit belongs to the retained scoring session. */
export function isScoringPlayerChild(
  route: Route,
  origin?: ScoringPlayerOrigin
): boolean {
  return (
    origin != null &&
    route.name === 'player' &&
    route.userId === origin.userId &&
    route.onTeam === origin.teamId
  )
}
export function isScoringPlayerReturn(
  route: Route,
  origin?: ScoringPlayerOrigin
): boolean {
  return (
    origin != null &&
    route.name === 'scoreGame' &&
    route.gameId === origin.gameId
  )
}
