import { readFileSync } from 'node:fs'

import { expect } from 'chai'
import { afterEach, describe, it } from 'mocha'

import {
  call,
  chatCoreStatus,
  forgetChatCoreForTests,
  loadChatCore,
  type LoadChatCoreOptions
} from './core.web'
import { ChatCryptoUnavailable, num } from './coreCall'

const wasmBytes = (): ArrayBuffer => {
  const file = readFileSync('src/common/chatCrypto/wasm/chat_crypto.wasm')
  return file.buffer.slice(file.byteOffset, file.byteOffset + file.byteLength)
}

const fetching = (
  answer: () => Promise<{
    ok: boolean
    arrayBuffer: () => Promise<ArrayBuffer>
  }>
): {
  fetch: NonNullable<LoadChatCoreOptions['fetch']>
  asked: Array<{ url: string; integrity?: string }>
} => {
  const asked: Array<{ url: string; integrity?: string }> = []
  return {
    asked,
    fetch: async (url, init) => {
      asked.push({ url, integrity: init.integrity })
      return await answer()
    }
  }
}

const served = (bytes: ArrayBuffer): ReturnType<typeof fetching> =>
  fetching(async () => ({ ok: true, arrayBuffer: async () => bytes }))

/** The browser's core: what it loads, and every way it can be unavailable. */
describe('the chat crypto core in a browser', () => {
  afterEach(() => {
    forgetChatCoreForTests()
  })

  it('loads the module once, checks it, and calls it', async () => {
    const { fetch, asked } = served(wasmBytes())
    expect(chatCoreStatus()).deep.equals({ ready: false, reason: 'loading' })
    expect(() => call('sha256', [])).throws(ChatCryptoUnavailable)
    const first = loadChatCore({
      fetch,
      url: '/chat-crypto.wasm',
      integrity: 'sha384-x'
    })
    // A second load while the first is under way fetches nothing more.
    const second = loadChatCore()
    expect(await first).deep.equals({ ready: true })
    expect(await second).deep.equals({ ready: true })
    expect(asked).deep.equals([
      { url: '/chat-crypto.wasm', integrity: 'sha384-x' }
    ])
    expect(chatCoreStatus()).deep.equals({ ready: true })
    expect(call('sha256', [new Uint8Array(0)])[0].length).equals(32)
  })

  it('a module that traps is unavailable from then on', async () => {
    const { fetch } = served(wasmBytes())
    const getRandomValues = (): never => {
      throw new Error('no randomness')
    }
    expect(
      await loadChatCore({ fetch, url: '/m', getRandomValues })
    ).deep.equals({ ready: true })
    expect(() => call('randomBytes', [num(32)]))
      .throws(ChatCryptoUnavailable)
      .with.property('reason', 'trapped')
    expect(chatCoreStatus()).deep.equals({ ready: false, reason: 'trapped' })
    expect(await loadChatCore()).deep.equals({
      ready: false,
      reason: 'trapped'
    })
    expect(() => call('sha256', [new Uint8Array(0)]))
      .throws(ChatCryptoUnavailable)
      .with.property('reason', 'trapped')
  })

  it('without WebAssembly, never asks for the module', async () => {
    const { fetch, asked } = served(wasmBytes())
    expect(
      await loadChatCore({ fetch, url: '/m', WebAssembly: undefined })
    ).deep.equals({
      ready: false,
      reason: 'noWebAssembly'
    })
    expect(asked).deep.equals([])
    expect(() => call('sha256', []))
      .throws(ChatCryptoUnavailable)
      .with.property('reason', 'noWebAssembly')
    forgetChatCoreForTests()
    expect(
      await loadChatCore({ fetch, url: '/m', WebAssembly: {} })
    ).deep.equals({
      ready: false,
      reason: 'noWebAssembly'
    })
  })

  it('a module that does not arrive is fetchFailed', async () => {
    const missing = fetching(async () => ({
      ok: false,
      arrayBuffer: async () => new ArrayBuffer(0)
    }))
    expect(await loadChatCore({ fetch: missing.fetch, url: '/m' })).deep.equals(
      {
        ready: false,
        reason: 'fetchFailed'
      }
    )
    forgetChatCoreForTests()
    const refused = fetching(async () => {
      throw new TypeError('integrity mismatch')
    })
    expect(
      (await loadChatCore({ fetch: refused.fetch, url: '/m' })).ready
    ).equals(false)
    forgetChatCoreForTests()
    // No address at all: the build did not name one.
    expect(await loadChatCore({ fetch: refused.fetch })).deep.equals({
      ready: false,
      reason: 'fetchFailed'
    })
  })

  it('asks again after a module that did not arrive, and keeps it once loaded', async () => {
    let attempts = 0
    const flaky = fetching(async () => {
      attempts += 1
      if (attempts === 1) throw new TypeError('network')
      return { ok: true, arrayBuffer: async () => wasmBytes() }
    })
    expect(
      (await loadChatCore({ fetch: flaky.fetch, url: '/m' })).ready
    ).equals(false)
    expect(chatCoreStatus()).deep.equals({
      ready: false,
      reason: 'fetchFailed'
    })
    const again = loadChatCore({ fetch: flaky.fetch, url: '/m' })
    expect(chatCoreStatus()).deep.equals({ ready: false, reason: 'loading' })
    expect(await again).deep.equals({ ready: true })
    expect(await loadChatCore({ fetch: flaky.fetch, url: '/m' })).deep.equals({
      ready: true
    })
    expect(attempts).equals(2)
  })

  it('a module that will not instantiate is instantiateFailed', async () => {
    const { fetch } = served(new Uint8Array([0, 1, 2, 3]).buffer)
    expect(await loadChatCore({ fetch, url: '/m' })).deep.equals({
      ready: false,
      reason: 'instantiateFailed'
    })
  })

  it('a module that gives other bytes is selfTestFailed', async () => {
    const { fetch } = served(wasmBytes())
    // A WebAssembly whose core answers every call with 32 zero bytes.
    const memory = new WebAssembly.Memory({ initial: 1 })
    let next = 1024
    const fake = {
      instantiate: async () => ({
        instance: {
          exports: {
            memory,
            chat_crypto_alloc: (length: number) => {
              const at = next
              next += length + 8
              return at
            },
            chat_crypto_free: () => undefined,
            chat_crypto_call: (
              _op: number,
              _in: number,
              _len: number,
              slot: number
            ) => {
              const answer = Uint8Array.of(
                0,
                0,
                0,
                0,
                32,
                ...new Uint8Array(32)
              )
              const at = next
              next += answer.length
              new Uint8Array(memory.buffer).set(answer, at)
              const view = new DataView(memory.buffer)
              view.setUint32(slot, at, true)
              view.setUint32(slot + 4, answer.length, true)
              return 0
            }
          }
        }
      })
    }
    expect(
      await loadChatCore({ fetch, url: '/m', WebAssembly: fake })
    ).deep.equals({
      ready: false,
      reason: 'selfTestFailed'
    })
  })
})
