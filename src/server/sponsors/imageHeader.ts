import type { ImageHeader } from '../../common/sponsors/limits'

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]

/** The start-of-frame markers, baseline to lossless; each holds the size. */
const SOF_MARKERS = new Set([
  0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf
])

/**
 * A picture's type and size, from the PNG's IHDR or the JPEG's start of
 * frame, or `null` when the bytes are neither, or stop before saying. Only
 * the header is read: nothing is decoded.
 */
export function imageHeader(bytes: Uint8Array): ImageHeader | null {
  if (PNG_SIGNATURE.every((byte, index) => bytes[index] === byte))
    return pngHeader(bytes)
  if (bytes[0] === 0xff && bytes[1] === 0xd8) return jpegHeader(bytes)
  return null
}

const view = (bytes: Uint8Array): DataView =>
  new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)

function pngHeader(bytes: Uint8Array): ImageHeader | null {
  // Signature (8), then the IHDR chunk: length (4), type (4), width, height.
  if (bytes.length < 24) return null
  if (String.fromCharCode(...bytes.subarray(12, 16)) !== 'IHDR') return null
  const data = view(bytes)
  const width = data.getUint32(16)
  const height = data.getUint32(20)
  return width > 0 && height > 0 ? { type: 'image/png', width, height } : null
}

function jpegHeader(bytes: Uint8Array): ImageHeader | null {
  const data = view(bytes)
  let at = 2
  while (at + 4 <= bytes.length) {
    if (bytes[at] !== 0xff) return null
    const marker = bytes[at + 1]
    // Fill bytes, and markers that stand alone with no length.
    if (marker === 0xff) {
      at += 1
      continue
    }
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      at += 2
      continue
    }
    // The end of the image, or the scan's data, with no frame before it.
    if (marker === 0xd9 || marker === 0xda) return null
    const length = data.getUint16(at + 2)
    if (SOF_MARKERS.has(marker)) {
      if (at + 9 > bytes.length) return null
      const height = data.getUint16(at + 5)
      const width = data.getUint16(at + 7)
      return width > 0 && height > 0
        ? { type: 'image/jpeg', width, height }
        : null
    }
    if (length < 2) return null
    at += 2 + length
  }
  return null
}
