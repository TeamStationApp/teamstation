import qrcode from 'qrcode-generator'

/** Modules of white around a QR code, which a reader needs to find it. */
export const QUIET_ZONE = 4

/** A QR code of `text`, `size` points square, quiet zone included. */
export interface QrCodeProps {
  text: string
  size: number
  accessibilityLabel?: string
}

export interface QrMatrix {
  /** Modules per side, without the quiet zone. */
  size: number
  dark: (x: number, y: number) => boolean
  /**
   * One SVG path of every dark module, in a viewBox of `size` plus the quiet
   * zone on each side, so a QR draws as one `<path>` on any platform.
   */
  path: string
}

/**
 * A QR code of `text` in byte mode at error correction L, the smallest
 * version that holds it. A GameChanger lineup is plain base64, so its bytes
 * are its characters.
 */
export function qrMatrix(text: string): QrMatrix {
  const code = qrcode(0, 'L')
  code.addData(text, 'Byte')
  code.make()
  const size = code.getModuleCount()
  const dark = (x: number, y: number): boolean => code.isDark(y, x)
  const runs: string[] = []
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size;) {
      if (!dark(x, y)) {
        x++
        continue
      }
      let end = x
      while (end < size && dark(end, y)) end++
      runs.push(
        `M${x + QUIET_ZONE} ${y + QUIET_ZONE}h${end - x}v1h-${end - x}z`
      )
      x = end
    }
  }
  return { size, dark, path: runs.join('') }
}
