import { ChatCryptoUnavailable, type RawCall } from './coreCall'

/**
 * The browser's loader for the chat crypto core's WebAssembly module
 * (`crates/chat-crypto`, built by `scripts/chatCryptoBuild.mjs wasm`).
 *
 * The module exports `memory`, `chat_crypto_alloc`, `chat_crypto_free` and
 * `chat_crypto_call`, and imports one function, `env.chat_crypto_random(ptr,
 * len)`, which is filled here from `getRandomValues` in calls of at most
 * 65,536 bytes, Web Crypto's limit on one call. A call copies its input into
 * the module's memory, calls the core, copies the answer out and frees both.
 * A call that traps ends the module: it and every later call throw
 * `ChatCryptoUnavailable('trapped')`.
 */

interface CoreExports {
  memory: WebAssembly.Memory
  chat_crypto_alloc: (length: number) => number
  chat_crypto_free: (pointer: number, length: number) => void
  chat_crypto_call: (
    op: number,
    input: number,
    inputLength: number,
    out: number,
    outLength: number
  ) => number
}

export type GetRandomValues = (array: Uint8Array) => unknown

/** Web Crypto's limit on one `getRandomValues` call. */
const MOST_PER_CALL = 65536

function importsFor(
  memory: () => WebAssembly.Memory,
  getRandomValues: GetRandomValues
): WebAssembly.Imports {
  return {
    env: {
      chat_crypto_random: (pointer: number, length: number): void => {
        for (let at = 0; at < length; at += MOST_PER_CALL) {
          const size = Math.min(MOST_PER_CALL, length - at)
          getRandomValues(new Uint8Array(memory().buffer, pointer + at, size))
        }
      }
    }
  }
}

function rawCallOf(exports: CoreExports): RawCall {
  // A trap (out of memory, say) leaves the module's heap in an unknown state:
  // the module is not called again, and every later call throws.
  let trapped: unknown
  return (op, input) => {
    if (trapped !== undefined) {
      throw new ChatCryptoUnavailable('trapped', { cause: trapped })
    }
    try {
      const inputPointer = exports.chat_crypto_alloc(input.length)
      const slot = exports.chat_crypto_alloc(8)
      new Uint8Array(exports.memory.buffer).set(input, inputPointer)
      exports.chat_crypto_call(op, inputPointer, input.length, slot, slot + 4)
      // Read after the call: memory may have grown, and the old buffer gone.
      const view = new DataView(exports.memory.buffer)
      const outPointer = view.getUint32(slot, true)
      const outLength = view.getUint32(slot + 4, true)
      const answer = new Uint8Array(
        exports.memory.buffer,
        outPointer,
        outLength
      ).slice()
      exports.chat_crypto_free(outPointer, outLength)
      exports.chat_crypto_free(inputPointer, input.length)
      exports.chat_crypto_free(slot, 8)
      return answer
    } catch (error) {
      trapped = error
      throw new ChatCryptoUnavailable('trapped', { cause: error })
    }
  }
}

/** The core's raw call from the module's bytes. */
export async function instantiateCore(
  bytes: ArrayBuffer | Uint8Array,
  getRandomValues: GetRandomValues,
  wasm: Pick<typeof WebAssembly, 'instantiate'> = WebAssembly
): Promise<RawCall> {
  // The random import needs the module's memory, which exists only once the
  // module does: it reads it from here when it is called.
  const made: { exports?: CoreExports } = {}
  const memory = (): WebAssembly.Memory => {
    if (made.exports == null) {
      throw new Error('The chat crypto module has no memory yet')
    }
    return made.exports.memory
  }
  const result = await wasm.instantiate(
    bytes,
    importsFor(memory, getRandomValues)
  )
  made.exports = result.instance.exports as unknown as CoreExports
  return rawCallOf(made.exports)
}
