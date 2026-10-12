import type { RsvpChoice } from '../../common/eventInfo'

export const RSVP_COLORS = ['#208a4b', '#2376cf', '#cb3941'] as const
export function rsvpPosition(choice: RsvpChoice): number {
  return choice === 'yes' ? 0 : choice === 'no' ? 2 : 1
}
export function clampRsvpPosition(position: number): number {
  return Math.max(0, Math.min(2, position))
}
export function rsvpAtPosition(position: number): 'yes' | 'maybe' | 'no' {
  return (['yes', 'maybe', 'no'] as const)[
    Math.round(clampRsvpPosition(position))
  ]
}

export function rsvpColor(position: number): string {
  const clamped = clampRsvpPosition(position)
  const from = clamped < 1 ? 0 : 1
  const amount = clamped - from
  const channels = (hex: string): number[] =>
    [1, 3, 5].map(at => parseInt(hex.slice(at, at + 2), 16))
  const left = channels(RSVP_COLORS[from])
  const right = channels(RSVP_COLORS[from + 1])
  return (
    '#' +
    left
      .map((value, i) =>
        Math.round(value + (right[i] - value) * amount)
          .toString(16)
          .padStart(2, '0')
      )
      .join('')
  )
}
