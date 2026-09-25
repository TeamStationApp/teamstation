export const FIREWORK_BULBS = 64
/** All coordinates are local to the scoreboard LED plane. */
export function fireworkBulb(
  index: number,
  seconds: number
): { x: number; y: number; scale: number } {
  const side = index < FIREWORK_BULBS / 2 ? -1 : 1
  const burst = Math.floor((index % 32) / 16)
  const phase =
    ((Math.max(0, seconds) + burst * 0.8 + (side > 0 ? 0.35 : 0)) % 1.8) / 1.8
  const angle = ((index % 16) * Math.PI) / 8
  const radius = 0.3 + 4.4 * Math.sqrt(phase)
  return {
    x: side * 26 + Math.cos(angle) * radius,
    y: 1.2 + Math.sin(angle) * radius - 2 * phase * phase,
    scale: Math.max(0.08, 1 - phase)
  }
}
export function celebrationPulse(seconds: number): number {
  return 0.72 + 0.28 * (0.5 + 0.5 * Math.sin(seconds * Math.PI * 2))
}
