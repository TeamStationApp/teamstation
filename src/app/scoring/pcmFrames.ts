import { base64 } from 'rfc4648'

/** One tenth of a second of 16 kHz mono 16-bit PCM, matching the web worklet. */
export const PCM_FRAME_BYTES = 3200

/**
 * Joins a leftover with the next chunk and cuts whole frames off the front.
 * What is left over waits for the next chunk.
 */
export function appendPcm(
  rest: Uint8Array,
  next: Uint8Array
): { frames: ArrayBuffer[]; rest: Uint8Array } {
  const combined = new Uint8Array(rest.length + next.length)
  combined.set(rest, 0)
  combined.set(next, rest.length)
  const frames: ArrayBuffer[] = []
  let offset = 0
  while (combined.length - offset >= PCM_FRAME_BYTES) {
    frames.push(combined.slice(offset, offset + PCM_FRAME_BYTES).buffer)
    offset += PCM_FRAME_BYTES
  }
  return { frames, rest: combined.slice(offset) }
}

/** Base64 PCM from the native module, as bytes. */
export function bytesFromBase64(value: string): Uint8Array {
  try {
    return base64.parse(value)
  } catch (error) {
    throw new Error(
      error instanceof Error ? error.message : 'The audio was not base64'
    )
  }
}
