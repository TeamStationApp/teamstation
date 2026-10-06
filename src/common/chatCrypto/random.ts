import { call } from './core'
import { num } from './coreCall'

/**
 * Random bytes, from the chat crypto core: the operating system's generator
 * on a phone and in Node, and in the browser Web Crypto's, which the
 * WebAssembly loader hands the module. There is no other source.
 */
export function randomBytes(length: number): Uint8Array {
  if (!Number.isSafeInteger(length) || length < 0) {
    throw new RangeError(`Not a length: ${length}`)
  }
  return call('randomBytes', [num(length)])[0]
}
