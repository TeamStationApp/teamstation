import type { HomeRunKind } from './stadiumBoundary'
export interface ScoreboardState {
  celebration?: { id: string; kind: HomeRunKind; paused: boolean }
  instruction?: string
  detail?: string
  homeTeam: string
  awayTeam: string
  homeScore: number
  awayScore: number
  batter: { firstName: string; lastName: string }
  pitcher: { firstName: string; lastName: string }
  batterHits?: number
  batterAtBats?: number
  pitchCount: number
  balls: number
  strikes: number
  outs: number
  inning: number
  half: 'top' | 'bottom'
}
/** Fictional preview data; the scene has no scoring engine or network dependency. */
export const DEMO_SCOREBOARD: ScoreboardState = {
  homeTeam: 'PIONEERS',
  awayTeam: 'VISITORS',
  homeScore: 3,
  awayScore: 2,
  batter: { firstName: 'Alex', lastName: 'Rivera' },
  pitcher: { firstName: 'James', lastName: 'Wilson' },
  batterHits: 1,
  batterAtBats: 3,
  pitchCount: 64,
  balls: 2,
  strikes: 1,
  outs: 1,
  inning: 5,
  half: 'top'
}
export function shortName(person: ScoreboardState['batter']): string {
  if (person.lastName.trim() === '')
    return person.firstName.trim().toUpperCase()
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

/** A run total with no leading zero. Two digits only when the score needs them. */
export function scoreDigits(value: number): string {
  const n = Number.isFinite(value)
    ? Math.max(0, Math.min(99, Math.floor(value)))
    : 0
  return String(n)
}
/** Pitch count tight against the P:, as `P:64`. */
export function pitchLabel(count: number): string {
  const n = Number.isFinite(count)
    ? Math.max(0, Math.min(999, Math.floor(count)))
    : 0
  return `P:${n}`
}
export function battingLine(state: ScoreboardState): string {
  const count = (value: number | undefined): number =>
    value != null && Number.isFinite(value) ? Math.max(0, Math.floor(value)) : 0
  const atBats = count(state.batterAtBats)
  return `${Math.min(count(state.batterHits), atBats)}-${atBats}`
}
