import { equalBytes } from '../../common/chatCrypto/bytes'
import { epochAad, hpkeOpen, hpkeSeal } from '../../common/chatCrypto/hpke'
import { newEpochKey, newPukKey } from '../../common/chatCrypto/keys'
import { openAttachment, sealAttachment } from '../../common/chatCrypto/stream'

/**
 * The chat crypto bench: the same work on a phone (`ChatBenchScreen`) and in
 * Node (`scripts/chatCryptoBench.mjs`).
 *
 * It seals and opens a 20 MiB buffer through `stream.ts`, as an attachment
 * would be, and makes 1,000 HPKE `epoch` wraps, as a new epoch for a large
 * chat would. Both results are checked, so a fast wrong answer is not a
 * result.
 *
 * A megabyte here is 2^20 bytes of plaintext. `streamMBps` is the slower of
 * sealing (pad, encrypt, digest) and opening (digest check, decrypt, unpad):
 * an attachment has to go both ways.
 */

export interface ChatBenchResult {
  bytes: number
  wraps: number
  sealMs: number
  openMs: number
  wrapMs: number
  sealMBps: number
  openMBps: number
  streamMBps: number
  wrapsPerSecond: number
}

export interface ChatBenchOptions {
  /** Plaintext bytes through `stream.ts`. */
  bytes?: number
  /** HPKE wraps. */
  wraps?: number
  now?: () => number
}

export const BENCH_BYTES = 20 * 1024 * 1024
export const BENCH_WRAPS = 1000

const MB = 1024 * 1024

function clock(): () => number {
  const performance = (globalThis as { performance?: { now: () => number } })
    .performance
  return performance == null ? Date.now : () => performance.now()
}

export function runChatBench(options: ChatBenchOptions = {}): ChatBenchResult {
  const bytes = options.bytes ?? BENCH_BYTES
  const wraps = options.wraps ?? BENCH_WRAPS
  const now = options.now ?? clock()

  const file = new Uint8Array(bytes)
  for (let i = 0; i < bytes; i++) file[i] = (i * 31 + 7) & 0xff

  let start = now()
  const sealed = sealAttachment(file)
  const sealMs = now() - start
  start = now()
  const opened = openAttachment(sealed.key, sealed.blob, sealed.digest)
  const openMs = now() - start
  if (!equalBytes(opened, file)) throw new Error('stream did not round-trip')

  const puk = newPukKey()
  const epochKey = newEpochKey()
  const aad = epochAad({
    conversationId: 'cnv_bench',
    epoch: 1,
    recipientUserId: 1,
    identityId: 'cid_bench',
    generation: 1
  })
  let box = new Uint8Array(0)
  start = now()
  for (let i = 0; i < wraps; i++) {
    box = hpkeSeal('epoch', puk.publicKey, aad, epochKey)
  }
  const wrapMs = now() - start
  if (
    wraps > 0 &&
    !equalBytes(hpkeOpen('epoch', puk.secretKey, aad, box), epochKey)
  ) {
    throw new Error('HPKE did not round-trip')
  }

  const rate = (amount: number, ms: number): number =>
    ms <= 0 ? Infinity : amount / (ms / 1000)
  const sealMBps = rate(bytes / MB, sealMs)
  const openMBps = rate(bytes / MB, openMs)
  return {
    bytes,
    wraps,
    sealMs,
    openMs,
    wrapMs,
    sealMBps,
    openMBps,
    streamMBps: Math.min(sealMBps, openMBps),
    wrapsPerSecond: rate(wraps, wrapMs)
  }
}

/** The lines the screen and the script print. */
export function benchLines(result: ChatBenchResult): string[] {
  const fixed = (n: number): string => (Number.isFinite(n) ? n.toFixed(1) : '∞')
  return [
    `stream MB/s: ${fixed(result.streamMBps)}`,
    `seal MB/s: ${fixed(result.sealMBps)} (${Math.round(result.sealMs)} ms)`,
    `open MB/s: ${fixed(result.openMBps)} (${Math.round(result.openMs)} ms)`,
    `wraps/s: ${fixed(result.wrapsPerSecond)} (${result.wraps} in ${Math.round(result.wrapMs)} ms)`,
    `bytes: ${result.bytes} (MB = 2^20 bytes)`
  ]
}
