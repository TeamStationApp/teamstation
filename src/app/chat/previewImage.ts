/** Inspect encoded raster dimensions before any decoder can allocate the image. */
export function rasterDimensions(
  bytes: Uint8Array
): { width: number; height: number; mime: string } | undefined {
  const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const chars = (start: number, n: number): string =>
    String.fromCharCode(...bytes.subarray(start, start + n))
  let width = 0
  let height = 0
  let mime = ''
  if (
    bytes.length >= 24 &&
    v.getUint32(0) === 0x89504e47 &&
    v.getUint32(4) === 0x0d0a1a0a &&
    v.getUint32(8) === 13 &&
    chars(12, 4) === 'IHDR'
  ) {
    width = v.getUint32(16)
    height = v.getUint32(20)
    mime = 'image/png'
  } else if (bytes.length >= 4 && v.getUint16(0) === 0xffd8) {
    let at = 2
    while (at + 4 <= bytes.length && bytes[at++] === 0xff) {
      while (bytes[at] === 0xff) at++
      if (at + 3 > bytes.length) return
      const marker = bytes[at++]
      if (marker === 0xda || marker === 0xd9) break
      const length = v.getUint16(at)
      if (length < 2 || at + length > bytes.length) return
      if ([0xc0, 0xc1, 0xc2].includes(marker) && length >= 8) {
        width = v.getUint16(at + 5)
        height = v.getUint16(at + 3)
        mime = 'image/jpeg'
        break
      }
      at += length
    }
  } else if (
    bytes.length >= 30 &&
    chars(0, 4) === 'RIFF' &&
    chars(8, 4) === 'WEBP'
  ) {
    const header = chars(12, 4)
    if (header === 'VP8X') {
      // Animated containers may allocate a complete sequence during decode.
      if ((bytes[20] & 2) !== 0) return
      width = 1 + bytes[24] + bytes[25] * 256 + bytes[26] * 65536
      height = 1 + bytes[27] + bytes[28] * 256 + bytes[29] * 65536
    } else if (
      header === 'VP8 ' &&
      v.getUint16(23) === 0x9d01 &&
      bytes[25] === 0x2a
    ) {
      width = v.getUint16(26, true) & 0x3fff
      height = v.getUint16(28, true) & 0x3fff
    } else if (header === 'VP8L' && bytes[20] === 0x2f) {
      const dimensions = v.getUint32(21, true)
      width = (dimensions & 0x3fff) + 1
      height = ((dimensions >>> 14) & 0x3fff) + 1
    }
    mime = 'image/webp'
  }
  if (width <= 0 || height <= 0 || width * height > 12_000_000) return
  return { width, height, mime }
}
