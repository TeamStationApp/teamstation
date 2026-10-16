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
  // The app's own files, which `index.html` declares and the browser waits
  // for: never a system font, which would draw at another size (the board
  // especially). Inter stands in for Helvetica Neue, which cannot be shipped.
  // `sans-serif` is only for a file that failed to arrive, so the app is
  // not drawn in the browser's default serif.
  spaceGrotesk: '"Space Grotesk", sans-serif',
  quicksand: 'Quicksand, sans-serif',
  inter: 'Inter, sans-serif',
  /** Material Symbols is a ligature font; `Icon` sets the name as text. */
  materialSymbols: 'Material Symbols Outlined'
}
