import type { RoleFlag } from '../../common/roles'
import { lstrings } from '../locales/strings'

/** `Team admin`, `Season admin`, `League admin`. */
export function adminLabel(scopeKind: 'league' | 'season' | 'team'): string {
  if (scopeKind === 'team') return lstrings.role_team_admin
  if (scopeKind === 'season') return lstrings.role_season_admin
  return lstrings.role_league_admin
}

/** `Coach`, `Assistant`, `Scorekeeper`, `Songkeeper`, `Videographer`. */
export function flagLabel(flag: RoleFlag): string {
  if (flag === 'coach') return lstrings.role_coach
  if (flag === 'assistant') return lstrings.role_assistant
  if (flag === 'scorekeeper') return lstrings.role_scorekeeper
  if (flag === 'songkeeper') return lstrings.role_songkeeper
  return lstrings.role_videographer
}

/** What a flag allows, with a `%s` for the level it is set on. */
export function flagDetail(flag: RoleFlag): string {
  if (flag === 'coach') return lstrings.role_coach_detail
  if (flag === 'assistant') return lstrings.role_assistant_detail
  if (flag === 'scorekeeper') return lstrings.role_scorekeeper_detail
  if (flag === 'songkeeper') return lstrings.role_songkeeper_detail
  return lstrings.role_videographer_detail
}
