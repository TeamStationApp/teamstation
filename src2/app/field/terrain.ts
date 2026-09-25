/** Metres above the surrounding ground. Separate surfaces and depth biases prevent
 * grazing-angle z-fighting on mobile depth buffers. */
export const TERRAIN = {
  grass: 0,
  stripe: 0.08,
  track: 0.16,
  dirt: 0.24,
  diamond: 0.32,
  plateDirt: 0.4,
  wear: 0.48,
  mound: 0.56,
  chalk: 0.64,
  players: 0.7
}
export function groundDepth(height: number): {
  polygonOffset: boolean
  polygonOffsetFactor: number
  polygonOffsetUnits: number
} {
  const layer = Math.round(height / 0.08) + 1
  return {
    polygonOffset: true,
    polygonOffsetFactor: 0,
    polygonOffsetUnits: -layer * 2
  }
}
