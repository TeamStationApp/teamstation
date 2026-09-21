/**
 * A shadow both platforms can draw.
 *
 * iOS takes a colour, an opacity, a radius and an offset and draws exactly
 * what it is told. Android takes a single number and works the rest out from
 * its own material model — and ignores `shadowRadius` entirely, so a component
 * that sets only the four iOS properties is **flat on Android**, silently, and
 * a card, a hero and a pegged picture all stop reading as objects at all.
 *
 * Android also paints by elevation and resolves `zIndex` against it, so
 * anything that needs to sit above something else needs both or it is
 * overpainted by whatever has a shadow.
 *
 * The number is derived rather than chosen: Material's own scale runs roughly
 * half the blur radius, which puts a card at 2, a hero at 4 and a floating
 * capsule at 6 — close enough to the shadows the designs were drawn with that
 * the two platforms look like one app.
 *
 * `overflow: 'hidden'` clips an elevation shadow away on Android, so a
 * component that clips its content has to put the shadow on a wrapper rather
 * than on the same view. `Card` and `GameHeroCard` both do.
 */
export function elevationFor(shadowRadius: number): number {
  return Math.max(1, Math.round(shadowRadius / 2))
}
