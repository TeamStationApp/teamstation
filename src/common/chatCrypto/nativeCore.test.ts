import { expect } from 'chai'
import { describe, it } from 'mocha'

import { call as nodeCall } from './core'
import { encodeArgs } from './coreCall'
import { OP } from './coreOps'
import { coreOf } from './nativeCore'

/**
 * The phones' core over a stand-in for the NativeChatCrypto module: the Node
 * addon behind the same ArrayBuffer-in, ArrayBuffer-out shape.
 */
describe('the chat crypto core on a phone', () => {
  const addon = (): { call: (op: number, input: object) => object } => {
    const { addonPath } = require('./core') as { addonPath: () => string }

    const raw = require(addonPath()) as {
      call: (op: number, input: Uint8Array) => Uint8Array
    }
    return {
      call: (op, input) => {
        expect(input).instanceOf(ArrayBuffer)
        const out = raw.call(op, new Uint8Array(input as ArrayBuffer))
        return out.buffer.slice(out.byteOffset, out.byteOffset + out.byteLength)
      }
    }
  }

  it('is ready over a module that gives the frozen bytes', () => {
    const core = coreOf(addon())
    expect(core.status).deep.equals({ ready: true })
    expect(core.call?.('sha256', [Uint8Array.of(1)])).deep.equals(
      nodeCall('sha256', [Uint8Array.of(1)])
    )
  })

  it('is noNativeModule without the module', () => {
    expect(coreOf(null)).deep.equals({
      status: { ready: false, reason: 'noNativeModule' },
      call: undefined
    })
  })

  it('is selfTestFailed over a module that gives other bytes', () => {
    const wrong = {
      call: () => Uint8Array.of(0, 0, 0, 0, 32, ...new Uint8Array(32)).buffer
    }
    expect(coreOf(wrong).status).deep.equals({
      ready: false,
      reason: 'selfTestFailed'
    })
    expect(encodeArgs([]).length).equals(0)
    expect(OP.sha256).equals(1)
  })
})
