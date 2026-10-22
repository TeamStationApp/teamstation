import { u64, utf8 } from './bytes'
import { OP, type OpName, type Refusal, REFUSALS } from './coreOps'
import vectorFile from './frozenVectors.json'

/**
 * The wire between the TypeScript and the chat crypto core
 * (`crates/chat-crypto/src/abi.rs`), the same on every platform.
 *
 * A call is an op and its arguments, each `u32 big-endian length ‖ bytes`;
 * the answer is `0 ‖ results`, each length-prefixed, or `1 ‖ reason`. Each
 * platform's `core` supplies the raw call — the Node addon, the WASM module
 * or the phone's native module — and `makeCall` does the rest.
 */

/** The core refused: the reason is one of `ops.json`'s refusals. */
export class ChatCryptoError extends Error {
  readonly reason: Refusal | 'unknown'

  constructor(reason: string, message?: string) {
    const known = (REFUSALS as readonly string[]).includes(reason)
    super(message ?? `Chat crypto refused: ${reason}`)
    this.name = 'ChatCryptoError'
    this.reason = known ? (reason as Refusal) : 'unknown'
  }
}

/** Why there is no core on this platform. */
export type CoreUnavailableReason =
  | 'loading'
  | 'noWebAssembly'
  | 'fetchFailed'
  | 'instantiateFailed'
  | 'selfTestFailed'
  | 'noNativeModule'
  /** The browser's module failed mid-call (out of memory, say): it is not
   * called again until the page reloads. */
  | 'trapped'

export type ChatCoreStatus =
  { ready: true } | { ready: false; reason: CoreUnavailableReason }

/** A core call before the core is ready, or on a platform without one. */
export class ChatCryptoUnavailable extends Error {
  readonly reason: CoreUnavailableReason

  constructor(reason: CoreUnavailableReason, options?: { cause?: unknown }) {
    super(`Chat crypto is not available: ${reason}`, options)
    this.name = 'ChatCryptoUnavailable'
    this.reason = reason
  }
}

export type RawCall = (op: number, input: Uint8Array) => Uint8Array

export type CoreCall = (op: OpName, args: Uint8Array[]) => Uint8Array[]

export function encodeArgs(args: Uint8Array[]): Uint8Array {
  let length = 0
  for (const arg of args) length += 4 + arg.length
  const out = new Uint8Array(length)
  const view = new DataView(out.buffer)
  let at = 0
  for (const arg of args) {
    view.setUint32(at, arg.length)
    out.set(arg, at + 4)
    at += 4 + arg.length
  }
  return out
}

export function decodeResults(out: Uint8Array): Uint8Array[] {
  if (out.length === 0) throw new ChatCryptoError('malformed')
  if (out[0] === 1) {
    let reason = ''
    for (const byte of out.subarray(1)) reason += String.fromCharCode(byte)
    throw new ChatCryptoError(reason)
  }
  if (out[0] !== 0) throw new ChatCryptoError('malformed')
  const view = new DataView(out.buffer, out.byteOffset, out.byteLength)
  const results: Uint8Array[] = []
  let at = 1
  while (at < out.length) {
    if (at + 4 > out.length) throw new ChatCryptoError('malformed')
    const length = view.getUint32(at)
    const start = at + 4
    if (start + length > out.length) throw new ChatCryptoError('malformed')
    // Views of the answer, not copies: a 20 MiB blob is not copied again.
    results.push(out.subarray(start, start + length))
    at = start + length
  }
  return results
}

export function makeCall(raw: RawCall): CoreCall {
  return (op, args) => decodeResults(raw(OP[op], encodeArgs(args)))
}

/** A number argument: 8 bytes big-endian. */
export const num = (value: number): Uint8Array => u64(value)

/** A flag argument: one byte. */
export const flag = (value: boolean): Uint8Array => Uint8Array.of(value ? 1 : 0)

/** A number result. */
export function readNumber(bytes: Uint8Array): number {
  if (bytes.length !== 8) throw new ChatCryptoError('malformed')
  const view = new DataView(bytes.buffer, bytes.byteOffset, 8)
  return view.getUint32(0) * 0x100000000 + view.getUint32(4)
}

/** A flag result. */
export const readFlag = (bytes: Uint8Array): boolean => bytes[0] === 1

const hex = (bytes: Uint8Array): string => {
  let out = ''
  for (const byte of bytes) out += byte.toString(16).padStart(2, '0')
  return out
}

/**
 * Whether a freshly loaded core gives the frozen bytes: SHA-256, and the
 * frozen message seal (HKDF, XChaCha20-Poly1305, padding) with its Ed25519
 * signature. A core that loads but computes other bytes is no core.
 */
export function selfTest(call: CoreCall): boolean {
  try {
    const sha = (text: string): Uint8Array => call('sha256', [utf8(text)])[0]
    if (
      hex(sha('abc')) !==
      'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad'
    ) {
      return false
    }
    const plaintext = utf8(
      '{"type":"text","body":"hi 🎉","mentions":[],"attachments":[]}'
    )
    const [, ciphertext, signature] = call('sealMessage', [
      utf8('cnv_c1'),
      num(7),
      utf8('msg_aaaaaaaaaaaaaaaaaaaaaaaaaa'),
      num(42),
      utf8('post'),
      sha('epoch key'),
      plaintext,
      sha('identity'),
      sha('nonce').subarray(0, 24)
    ])
    const frozen = vectorFile.frozen
    return (
      hex(call('sha256', [ciphertext])[0]) === frozen.sealCiphertextSha256 &&
      hex(signature) === frozen.sealSignature &&
      // Full-width identity capability is required before keys are touched.
      // ff || u128be(2^64 + 7), independently frozen membership-row hash.
      hex(
        call('logRowHash', [
          new Uint8Array(32),
          utf8('cnv_identity'),
          num(1),
          utf8('join'),
          Uint8Array.of(255, 0, 0, 0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0, 0, 7),
          num(0),
          utf8(''),
          num(1234)
        ])[0]
      ) === '389c66526d5098d0ec2739ff8901bb28029a12932d4bc56218f1978700b6b832'
    )
  } catch {
    return false
  }
}
