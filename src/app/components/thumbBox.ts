/**
 * The list-row thumbnail.
 *
 * The width is the width a 16:9 frame of this text height has today. The
 * height is that width at 4:3, which is taller than the text, so the row
 * grows and the picture is a center crop of the same frame.
 */
export function thumbBox(textHeight: number): {
  width: number
  height: number
} {
  const width = (textHeight * 16) / 9
  const height = (width * 3) / 4
  return { width, height }
}
