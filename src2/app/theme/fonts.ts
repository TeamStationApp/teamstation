/**
 * The names a `fontFamily` may be given, on the web.
 *
 * A browser takes a **stack** — a list of families, each tried in turn — so a
 * font that is slow or blocked costs the lettering and nothing else. React
 * Native takes one family name and no fallback at all, so the two platforms
 * cannot share a string; this module is the seam, and `fonts.native.ts` is the
 * other side of it.
 *
 * Nothing here is a weight. The theme names a family and the component asks
 * for a `fontWeight`, which is how both platforms want to be told.
 */
export const fonts = {
  spaceGrotesk:
    '"Space Grotesk", -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif',
  quicksand: 'Quicksand, -apple-system, BlinkMacSystemFont, sans-serif',
  helveticaNeue: 'Helvetica Neue, Arial, sans-serif',
  /** Material Symbols is a ligature font; `Icon` sets the name as text. */
  materialSymbols: 'Material Symbols Outlined'
}
