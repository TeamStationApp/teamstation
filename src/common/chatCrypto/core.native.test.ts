import { expect } from 'chai'
import { afterEach, describe, it } from 'mocha'

import { call as nodeCall } from './core'
import {
  type ChatCoreStatus,
  ChatCryptoUnavailable,
  type CoreCall
} from './coreCall'

/**
 * `core.native.ts` as a phone loads it, with `NativeChatCrypto` (which needs
 * React Native) replaced in the module cache: absent, as in a build without
 * the module, or the Node addon behind the module's shape.
 */
interface NativeCore {
  call: CoreCall
  chatCoreStatus: () => ChatCoreStatus
  loadChatCore: () => Promise<ChatCoreStatus>
}

const spec = require.resolve('../../app/chat/NativeChatCrypto')
const native = require.resolve('./core.native')

function loadWith(module: unknown): NativeCore {
  Reflect.deleteProperty(require.cache, native)
  require.cache[spec] = {
    id: spec,
    filename: spec,
    loaded: true,
    exports: { __esModule: true, default: module }
  } as unknown as NodeJS.Module
  return require('./core.native') as NativeCore
}

describe('the chat crypto core on a phone, as the app loads it', () => {
  afterEach(() => {
    Reflect.deleteProperty(require.cache, native)
    Reflect.deleteProperty(require.cache, spec)
  })

  it('without the native module, is noNativeModule and calls nothing', async () => {
    const core = loadWith(null)
    const unavailable = { ready: false, reason: 'noNativeModule' }
    expect(core.chatCoreStatus()).deep.equals(unavailable)
    expect(await core.loadChatCore()).deep.equals(unavailable)
    expect(() => core.call('sha256', []))
      .throws(ChatCryptoUnavailable)
      .with.property('reason', 'noNativeModule')
  })

  it('with the module, is ready and calls it', async () => {
    const { addonPath } = require('./core') as { addonPath: () => string }
    const raw = require(addonPath()) as {
      call: (op: number, input: Uint8Array) => Uint8Array
    }
    const core = loadWith({
      call: (op: number, input: ArrayBuffer) => {
        const out = raw.call(op, new Uint8Array(input))
        return out.buffer.slice(out.byteOffset, out.byteOffset + out.byteLength)
      }
    })
    expect(await core.loadChatCore()).deep.equals({ ready: true })
    expect(core.call('sha256', [Uint8Array.of(1)])).deep.equals(
      nodeCall('sha256', [Uint8Array.of(1)])
    )
  })
})
