export type LineupQrGlyphKind = 'qr' | 'scan'

/**
 * Outlines in a 24-unit box, drawn as strokes: `qr` is a QR code's three
 * finder squares and a few modules; `scan` is four corner brackets, which
 * also frame the camera on the scan step.
 */
export const lineupQrGlyphPaths: Record<LineupQrGlyphKind, string> = {
  qr:
    'M4 4h6v6H4z' +
    'M14 4h6v6h-6z' +
    'M4 14h6v6H4z' +
    'M14 14h2v2h-2z' +
    'M18 14h2' +
    'M14 20h2' +
    'M18 18h2v2h-2z',
  scan:
    'M3 8V4a1 1 0 0 1 1-1h4' +
    'M16 3h4a1 1 0 0 1 1 1v4' +
    'M21 16v4a1 1 0 0 1-1 1h-4' +
    'M8 21H4a1 1 0 0 1-1-1v-4'
}

export interface LineupQrGlyphProps {
  kind: LineupQrGlyphKind
  color: string
  /** Points square; 24 by default. */
  size?: number
  /** In the 24-unit box; thicker draws a bolder frame at large sizes. */
  strokeWidth?: number
}
