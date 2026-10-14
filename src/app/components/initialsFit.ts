/** Largest proportional glyph size within the preview's 80% inner square. */
export function initialsFontSize(
  box: number,
  width: number,
  height: number,
  reference: number
): number {
  if (width <= 0 || height <= 0 || reference <= 0) return box * 0.4
  return reference * Math.min((box * 0.8) / width, (box * 0.8) / height)
}
