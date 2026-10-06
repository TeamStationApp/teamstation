import { readFileSync } from 'node:fs'

import { expect } from 'chai'
import { describe, it } from 'mocha'

import { ChatCryptoUnavailable, makeCall, num, selfTest } from './coreCall'
import { coreVectorSummary, runCoreVectors } from './coreVectors'
import { openAttachmentWith, sealAttachmentWith } from './stream'
import { instantiateCore } from './wasmCore'

const bytes = (): Uint8Array =>
  readFileSync('src/common/chatCrypto/wasm/chat_crypto.wasm')

/** The browser's loader, on the built module, in Node's WebAssembly. */
describe('the WASM chat crypto core', () => {
  it('gives every frozen vector', async () => {
    const call = makeCall(
      await instantiateCore(bytes(), array => crypto.getRandomValues(array))
    )
    expect(selfTest(call)).equals(true)
    expect(coreVectorSummary(runCoreVectors(call))).equals('vectors ok')
  })

  it('seals and opens 100 MiB in a few MiB of memory', async function () {
    this.timeout(60000)
    let memory: WebAssembly.Memory | undefined
    const call = makeCall(
      await instantiateCore(bytes(), array => crypto.getRandomValues(array), {
        instantiate: async (
          module: BufferSource,
          imports?: WebAssembly.Imports
        ) => {
          const made = await WebAssembly.instantiate(module, imports)
          memory = made.instance.exports.memory as WebAssembly.Memory
          return made
        }
      } as unknown as Pick<typeof WebAssembly, 'instantiate'>)
    )
    const file = new Uint8Array(100 * 1024 * 1024).fill(7)
    const { key, blob, digest } = sealAttachmentWith(call, file)
    const opened = openAttachmentWith(call, key, blob, digest)
    expect(opened.length).equals(file.length)
    // A part in and a part out, never the file.
    expect(memory?.buffer.byteLength ?? 0).below(8 * 1024 * 1024)
  })

  it('is not called again once a call traps', async () => {
    let calls = 0
    const call = makeCall(
      await instantiateCore(bytes(), array => {
        calls++
        if (calls === 1) throw new Error('no randomness')
        return crypto.getRandomValues(array)
      })
    )
    expect(() => call('randomBytes', [num(32)]))
      .throws(ChatCryptoUnavailable)
      .with.property('reason', 'trapped')
    expect(() => call('sha256', [new Uint8Array(1)]))
      .throws(ChatCryptoUnavailable)
      .with.property('reason', 'trapped')
    expect(calls).equals(1)
  })

  it('draws randomness in Web Crypto-sized calls', async () => {
    const sizes: number[] = []
    const call = makeCall(
      await instantiateCore(bytes(), array => {
        if (array.length > 65536) throw new Error('QuotaExceededError')
        sizes.push(array.length)
        return crypto.getRandomValues(array)
      })
    )
    const [drawn] = call('randomBytes', [num(135 * 1024)])
    expect(drawn.length).equals(135 * 1024)
    expect(sizes).deep.equals([65536, 65536, 7168])
    expect(drawn.some(byte => byte !== 0)).equals(true)
  })
})
