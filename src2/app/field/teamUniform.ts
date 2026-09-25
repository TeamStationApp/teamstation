import type { FieldPlayer } from './fieldModel'
import { fieldPalette } from './fieldPalette'

export const TEAM_COLORS = { away: '#294c78', home: '#b74242' } as const
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
