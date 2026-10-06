import {
  type ChatCoreStatus,
  ChatCryptoUnavailable,
  type CoreCall,
  makeCall,
  type RawCall,
  selfTest
} from './coreCall'
import { type GetRandomValues, instantiateCore } from './wasmCore'

/**
 * The chat crypto core in the browser: the WebAssembly module the web build
 * ships beside the bundle (`TS_CHAT_WASM_URL`), checked against
 * `TS_CHAT_WASM_INTEGRITY`.
 *
 * `loadChatCore()` runs once and settles `ready` or `unavailable` with the
 * reason: no WebAssembly in this browser, the module did not arrive or was
 * not the one built, it would not instantiate (a policy that refuses
 * compilation included), or it computed other bytes than the frozen ones.
 * There is no other implementation: until it is ready, every call throws
 * `ChatCryptoUnavailable`, and chat does not open. A module that traps once
 * ready is unavailable (`trapped`) from then on, for this page.
 */
declare const TS_CHAT_WASM_URL: string | undefined
declare const TS_CHAT_WASM_INTEGRITY: string | undefined

export interface LoadChatCoreOptions {
  fetch?: (
    url: string,
    init: { integrity?: string }
  ) => Promise<{ ok: boolean; arrayBuffer: () => Promise<ArrayBuffer> }>
  WebAssembly?: unknown
  url?: string
  integrity?: string
  getRandomValues?: GetRandomValues
}

let status: ChatCoreStatus = { ready: false, reason: 'loading' }
let raw: CoreCall | undefined
let loading: Promise<ChatCoreStatus> | undefined

export const call: CoreCall = (op, args) => {
  if (raw == null) {
    throw new ChatCryptoUnavailable(status.ready ? 'loading' : status.reason)
  }
  return raw(op, args)
}

export function chatCoreStatus(): ChatCoreStatus {
  return status
}

async function load(options: LoadChatCoreOptions): Promise<ChatCoreStatus> {
  const wasm =
    'WebAssembly' in options
      ? options.WebAssembly
      : (globalThis as { WebAssembly?: unknown }).WebAssembly
  if (
    wasm == null ||
    typeof wasm !== 'object' ||
    typeof (wasm as { instantiate?: unknown }).instantiate !== 'function'
  ) {
    return { ready: false, reason: 'noWebAssembly' }
  }
  const url =
    options.url ??
    (typeof TS_CHAT_WASM_URL === 'string' ? TS_CHAT_WASM_URL : undefined)
  const integrity =
    options.integrity ??
    (typeof TS_CHAT_WASM_INTEGRITY === 'string'
      ? TS_CHAT_WASM_INTEGRITY
      : undefined)
  const fetcher =
    options.fetch ??
    (globalThis as { fetch?: LoadChatCoreOptions['fetch'] }).fetch
  let bytes: ArrayBuffer
  try {
    if (url == null || fetcher == null) throw new Error('No module to fetch')
    const response = await fetcher(url, { integrity })
    if (!response.ok) throw new Error('The module did not arrive')
    bytes = await response.arrayBuffer()
  } catch {
    return { ready: false, reason: 'fetchFailed' }
  }
  const getRandomValues =
    options.getRandomValues ??
    ((array: Uint8Array) => globalThis.crypto.getRandomValues(array))
  let rawCall: RawCall
  try {
    rawCall = await instantiateCore(
      bytes,
      getRandomValues,
      wasm as Pick<typeof WebAssembly, 'instantiate'>
    )
  } catch {
    return { ready: false, reason: 'instantiateFailed' }
  }
  const made = makeCall(rawCall)
  if (!selfTest(made)) return { ready: false, reason: 'selfTestFailed' }
  raw = (op, args) => {
    try {
      return made(op, args)
    } catch (error) {
      if (error instanceof ChatCryptoUnavailable) {
        // Settled for this page: the next chat screen shows why, and its
        // gate reports it.
        status = { ready: false, reason: error.reason }
        raw = undefined
        loading = Promise.resolve(status)
      }
      throw error
    }
  }
  return { ready: true }
}

/**
 * Loads the core once; every later call answers the same promise. A module
 * that did not arrive is the exception: it may be a moment's network, so
 * the next call (the next chat screen) asks for it again.
 */
export async function loadChatCore(
  options: LoadChatCoreOptions = {}
): Promise<ChatCoreStatus> {
  if (loading == null) {
    // Asked again after a module that did not arrive: loading, not failed.
    status = { ready: false, reason: 'loading' }
  }
  loading ??= load(options).then(settled => {
    status = settled
    if (!settled.ready && settled.reason === 'fetchFailed') loading = undefined
    return settled
  })
  return await loading
}

/** Forgets the core, for tests that load it again another way. */
export function forgetChatCoreForTests(): void {
  status = { ready: false, reason: 'loading' }
  raw = undefined
  loading = undefined
}
