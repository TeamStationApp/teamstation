import { expect } from 'chai'
import { describe, it } from 'mocha'

import { asAiKeys, asApiKeyPool, normalizedKeys } from '../common/aiKeys'
import { retryableStatus, shuffledKeys, withApiKeys } from './aiKeyFallback'

describe('API key pools', () => {
  it('normalizes legacy strings and deduplicates trimmed keys', () => {
    expect(normalizedKeys(' a ')).deep.equals(['a'])
    expect(normalizedKeys([' a ', '', 'a', 'b'])).deep.equals(['a', 'b'])
    expect(asApiKeyPool('one')).equals('one')
    expect(asApiKeyPool([' a ', 'a'])).deep.equals(['a'])
    for (const value of [null, {}, 1, [1]])
      expect(() => asApiKeyPool(value)).throws(TypeError)
    for (const value of [null, [], {}, { anthropicChatbot: 'secret' }])
      expect(() => asAiKeys(value)).throws(TypeError)
    expect(
      asAiKeys({
        anthropicChatbot: [' a '],
        anthropicScoring: [],
        xaiVoice: ['b']
      })
    ).deep.equals({
      anthropicChatbot: ['a'],
      anthropicScoring: [],
      xaiVoice: ['b']
    })
  })
  it('can start at every key, without changing the input', () => {
    const keys = ['a', 'b', 'c']
    expect(shuffledKeys(keys, () => 0)).deep.equals(['b', 'c', 'a'])
    expect(shuffledKeys(keys, () => 0.999)).deep.equals(keys)
    expect(shuffledKeys(keys, () => 0.5)).deep.equals(['a', 'c', 'b'])
    expect(keys).deep.equals(['a', 'b', 'c'])
  })
  it('retries exactly credential, rate limit, timeout and server statuses', () => {
    for (const status of [401, 403, 408, 429, 500, 529, 599])
      expect(retryableStatus(status)).equals(true)
    for (const status of [200, 400, 404, 413, 422, 499, 600])
      expect(retryableStatus(status)).equals(false)
  })
  it('stops on success, never repeats, and preserves the latest error object', async () => {
    const seen: string[] = []
    const last = new Error('latest')
    try {
      await withApiKeys(
        ['a', 'b', 'a'],
        async key => {
          seen.push(key)
          throw seen.length === 1 ? new Error('first') : last
        },
        () => true
      )
      expect.fail('must reject')
    } catch (error) {
      expect(error).equals(last)
    }
    expect(new Set(seen).size).equals(2)
    let calls = 0
    expect(
      await withApiKeys(
        ['a', 'b'],
        async () => ++calls,
        () => true
      )
    ).equals(1)
    expect(calls).equals(1)
    try {
      await withApiKeys(
        ['a', 'b'],
        async () => {
          throw last
        },
        () => false
      )
    } catch (error) {
      expect(error).equals(last)
    }
    try {
      await withApiKeys(
        [],
        async () => 1,
        () => true
      )
      expect.fail('empty')
    } catch (error) {
      expect(String(error)).contains('No API keys')
    }
  })
})
