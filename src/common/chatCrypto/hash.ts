import { call } from './core'

/** SHA-256, on the chat crypto core. */
export function sha256(data: Uint8Array): Uint8Array {
  return call('sha256', [data])[0]
}
