import { expect } from 'chai'
import { describe, it } from 'mocha'

import { fromHex, runVectors, toHex, vectorSummary } from './vectors'

/** U3: the shared frozen vectors, through the wrappers, on the Node core. */
describe('chatCrypto vectors', () => {
  it('every vector matches through the TypeScript wrappers', () => {
    const results = runVectors()
    expect(results.filter(result => !result.ok)).deep.equals([])
    expect(vectorSummary(results)).equals('vectors ok')
  })

  it('names the first that does not match', () => {
    expect(
      vectorSummary([
        { name: 'a', ok: true, got: 'x', want: 'x' },
        { name: 'seal', ok: false, got: 'threw boom', want: 'y' },
        { name: 'c', ok: false, got: '1', want: '2' }
      ])
    ).equals('vectors failed: seal (got threw boom)')
  })

  it('a core that throws outside a check is a failure, not a crash', async () => {
    const hash = (await import('./hash')) as { sha256: unknown }
    const real = hash.sha256
    hash.sha256 = () => {
      throw new Error('no seed')
    }
    try {
      expect(vectorSummary()).equals('vectors failed: threw no seed')
    } finally {
      hash.sha256 = real
    }
  })

  it('hex both ways', () => {
    expect(toHex(fromHex('00ff10ab'))).equals('00ff10ab')
    expect(toHex(new Uint8Array(0))).equals('')
  })
})
