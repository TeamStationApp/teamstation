export interface ScoreboardState {
  homeTeam: string
  awayTeam: string
  homeScore: number
  awayScore: number
  batter: { firstName: string; lastName: string }
  pitcher: { firstName: string; lastName: string }
  pitchCount: number
  balls: number
  strikes: number
  outs: number
}
/** Fictional preview data; the scene has no scoring engine or network dependency. */
export const DEMO_SCOREBOARD: ScoreboardState = {
  homeTeam: 'PIONEERS',
  awayTeam: 'VISITORS',
  homeScore: 3,
  awayScore: 2,
  batter: { firstName: 'Alex', lastName: 'Rivera' },
  pitcher: { firstName: 'James', lastName: 'Wilson' },
  pitchCount: 64,
  balls: 2,
  strikes: 1,
  outs: 1
}
export function shortName(person: ScoreboardState['batter']): string {
  return `${person.firstName.trim()} ${person.lastName.trim().slice(0, 1)}.`
    .trim()
    .toUpperCase()
}
export function countLights(value: number, maximum: number): boolean[] {
  const count = Number.isFinite(value)
    ? Math.max(0, Math.min(maximum, Math.floor(value)))
    : 0
  return Array.from({ length: maximum }, (_, index) => index < count)
}
