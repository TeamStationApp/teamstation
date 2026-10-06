import { join } from 'node:path'

import {
  type ChatCoreStatus,
  type CoreCall,
  makeCall,
  type RawCall
} from './coreCall'

/**
 * The chat crypto core in Node — the server, the scripts and the tests: the
 * Node-API addon built from `crates/chat-crypto` by `npm run chat-crypto`.
 *
 * It loads at import, so the server calls the core synchronously, as it
 * always has. `TS_CHAT_NODE_ADDON`, when a bundle defines it, names the addon
 * (the bundled app tests are not beside it); otherwise it is
 * `node/chat_crypto.node` next to this file, which `npm run build` copies
 * into `lib/` too. Its twins are `core.web.ts` (WebAssembly) and
 * `core.native.ts` (the phones' TurboModule).
 */
declare const TS_CHAT_NODE_ADDON: string | undefined

interface Addon {
  call: (op: number, input: Uint8Array) => Uint8Array
}

/** The addon's raw call, or the error that says how to build it. */
export function loadAddon(
  path: string,
  load: (path: string) => unknown = require
): RawCall {
  let addon: Addon
  try {
    addon = load(path) as Addon
  } catch (caught: unknown) {
    const why = caught instanceof Error ? caught.message : String(caught)
    throw new Error(
      `The chat crypto addon is missing or broken (${path}): run npm run chat-crypto. ${why}`
    )
  }
  return (op, input) => {
    const out = addon.call(op, input)
    return new Uint8Array(out.buffer, out.byteOffset, out.byteLength)
  }
}

export function addonPath(): string {
  return typeof TS_CHAT_NODE_ADDON === 'string'
    ? TS_CHAT_NODE_ADDON
    : join(__dirname, 'node', 'chat_crypto.node')
}

export const call: CoreCall = makeCall(loadAddon(addonPath()))

/** Node's core is ready once this module has loaded. */
export function chatCoreStatus(): ChatCoreStatus {
  return { ready: true }
}

export async function loadChatCore(): Promise<ChatCoreStatus> {
  return chatCoreStatus()
}
