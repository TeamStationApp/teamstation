import { join, lp } from './bytes'
import { sign, verify } from './keys'

/**
 * A device proving itself to a new session. The server hands out a random
 * 32-byte nonce (`POST /chat/devices/:id/resume-challenge`, single use, two
 * minutes) together with the session id, and the device signs `lp(nonce) ‖
 * lp(deviceId) ‖ lp(sessionId)` with the Ed25519 half of its device keys.
 * Naming the session means a signature cannot bind the device to any other.
 */
export interface ResumeFields {
  nonce: Uint8Array
  deviceId: string
  sessionId: string
}

/** What a device signs to resume. */
export function resumeSignedBytes(fields: ResumeFields): Uint8Array {
  return join(lp(fields.nonce), lp(fields.deviceId), lp(fields.sessionId))
}

export function signResume(
  fields: ResumeFields,
  deviceSignSecretKey: Uint8Array
): Uint8Array {
  return sign(resumeSignedBytes(fields), deviceSignSecretKey)
}

export function verifyResume(
  fields: ResumeFields,
  signature: Uint8Array,
  deviceSignPublicKey: Uint8Array
): boolean {
  return verify(signature, resumeSignedBytes(fields), deviceSignPublicKey)
}
