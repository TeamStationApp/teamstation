/**
 * A head and shoulders with a small plus in a circle at the upper right of
 * the head: adding a person who already exists. Drawn in a 24-unit box.
 * The circle is ringed in the background colour so it reads against the
 * head it overlaps.
 */
export const ADD_PERSON_GLYPH = {
  head: { cx: 10, cy: 8, r: 4 },
  shoulders: 'M2.5 21c0-4.4 3.4-7.5 7.5-7.5s7.5 3.1 7.5 7.5z',
  badge: { cx: 18, cy: 6, r: 5.2 },
  plus: 'M18 3.2v5.6M15.2 6h5.6'
} as const

export interface AddPersonGlyphProps {
  /** The silhouette and the badge. */
  color: string
  /** What the glyph sits on: the ring around the badge and its plus. */
  background: string
  /** Points square; 24 by default. */
  size?: number
}
