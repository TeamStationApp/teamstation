/** A line's width from its length and font size, where nothing can measure it. */
export function estimateInkWidth(text: string, fontPx: number): number {
  return Math.ceil(text.length * fontPx * 0.56)
}
