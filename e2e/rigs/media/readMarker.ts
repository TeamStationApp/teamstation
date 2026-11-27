/**
 * Reads the wall clock the fake broadcaster burns into every frame, from the
 * picture a page is showing.
 *
 * The marker is `LIVE_MARKER`'s (`mobile/apps/tsDirector/scripts/
 * rtspLoopServer.js`): 32 square cells on a black strip, cell *n* white when
 * bit *n* of the frame's wall ms is set, and a 33rd cell always white. The
 * fake broadcaster draws it at the picture's bottom-left, so no overlay on
 * the top-left ever covers it.
 *
 * `readMarker` runs in the page: it is handed to the browser as source text
 * (`readMarkerSource`), so it reaches for nothing outside itself. hls.js plays
 * through Media Source, which is the page's own origin, so the `<video>` can
 * be drawn into a canvas and read back.
 */

/** Where the cells are, in the picture's own pixels. */
export interface MarkerGeometry {
  bits: number
  originX: number
  originY: number
  stride: number
  cell: number
  sentinelSlot: number
}

/** `LIVE_MARKER`, moved to the bottom-left of a picture `height` tall. */
export function markerGeometry(height: number): MarkerGeometry {
  const cell = 32
  return {
    bits: 32,
    originX: 40,
    originY: height - 40 - cell,
    stride: 36,
    cell,
    sentinelSlot: 32
  }
}

/**
 * The low 32 bits of the wall ms the frame on screen carries, or null when
 * the marker is not there to read (no picture yet, or something over it).
 */
export function readMarker(
  video: HTMLVideoElement,
  geometry: MarkerGeometry
): number | null {
  const width = video.videoWidth
  const height = video.videoHeight
  if (width === 0 || height === 0) return null
  const canvas = document.createElement('canvas')
  canvas.width = width
  canvas.height = height
  const context = canvas.getContext('2d', { willReadFrequently: true })
  if (context == null) return null
  context.drawImage(video, 0, 0, width, height)
  const { bits, originX, originY, stride, cell, sentinelSlot } = geometry
  // The middle half of a cell, away from the encoder's softened edges.
  const quarter = Math.floor(cell / 4)
  const brightness = (x: number, y: number): number => {
    const pixels = context.getImageData(x, y, cell / 2, cell / 2).data
    let sum = 0
    for (let i = 0; i < pixels.length; i += 4)
      sum += 0.299 * pixels[i] + 0.587 * pixels[i + 1] + 0.114 * pixels[i + 2]
    return sum / (pixels.length / 4)
  }
  const slot = (n: number): number =>
    brightness(originX + n * stride + quarter, originY + quarter)
  // The always-white cell, and the black strip under the cells.
  if (slot(sentinelSlot) < 160) return null
  if (brightness(originX, originY + cell + 2) > 96) return null
  let value = 0
  for (let bit = 0; bit < bits; bit++) {
    if (slot(bit) > 128) value += Math.pow(2, bit)
  }
  return value
}

/** `readMarker` as source text, for a page to run. */
export function readMarkerSource(): string {
  return readMarker.toString()
}

/**
 * The whole wall ms from the marker's low 32 bits and any estimate within 24
 * days of it, which is every timeline this is checked against.
 */
export function unwrapMarker(low32: number, nearMs: number): number {
  const span = 2 ** 32
  const base = nearMs - (((nearMs % span) + span) % span)
  const candidates = [base - span, base, base + span].map(one => one + low32)
  return candidates.reduce((best, one) =>
    Math.abs(one - nearMs) < Math.abs(best - nearMs) ? one : best
  )
}
