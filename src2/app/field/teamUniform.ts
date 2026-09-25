import type { FieldPlayer } from './fieldModel'
import { fieldPalette } from './fieldPalette'

export const TEAM_COLORS = { away: '#e17842', home: '#b74242' } as const
export interface FieldTeam {
  name: string
  logoUrl?: string | null
}
export type FieldTeams = Record<'away' | 'home', FieldTeam>

export function uniformColor(player: FieldPlayer): string {
  return player.uniformSide == null
    ? player.team === 'runner'
      ? fieldPalette.runner
      : fieldPalette.defense
    : TEAM_COLORS[player.uniformSide]
}
