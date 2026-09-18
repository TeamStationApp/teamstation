/**
 * Tiles are not cameras.
 *
 * A multi-angle recording lays the programme output alongside the camera
 * views, so one tile of the mosaic is never a camera. Four tiles is three
 * cameras; three tiles is two.
 */
export function camerasFromTiles(tiles: number): number | null {
  if (!Number.isInteger(tiles) || tiles < 2) return null
  return tiles - 1
}
