import { expect } from 'chai'
import { describe, it } from 'mocha'

import { asAiKeys, asApiKeyPool, normalizedKeys } from '../common/aiKeys'
import {
  forgetCurrentKeys,
  keyAnswered,
  orderedKeys,
  redacted,
  retryableStatus,
  untilAnswered,
  withApiKeys
} from './aiKeyFallback'

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
  it('tries the keys in the order given, without changing the input', () => {
    const keys = ['a', 'b', 'a', 'c']
    expect(orderedKeys(keys)).deep.equals(['a', 'b', 'c'])
    expect(keys).deep.equals(['a', 'b', 'a', 'c'])
    expect(orderedKeys([])).deep.equals([])
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
  it('stays on the key that answered until it fails, then on the next', async () => {
    const pool = ['k1', 'k2', 'k3']
    const refused = new Set<string>()
    const used: string[] = []
    const ask = async (): Promise<string> =>
      await withApiKeys(
        pool,
        async key => {
          used.push(key)
          if (refused.has(key)) throw new Error('refused')
          return key
        },
        () => true
      )
    expect([await ask(), await ask()]).deep.equals(['k1', 'k1'])
    refused.add('k1')
    expect(await ask()).equals('k2')
    // k1 works again, but the pool stays where it moved to.
    refused.clear()
    expect([await ask(), await ask()]).deep.equals(['k2', 'k2'])
    expect(used).deep.equals(['k1', 'k1', 'k1', 'k2', 'k2', 'k2'])
    refused.add('k2')
    refused.add('k3')
    expect(await ask()).equals('k1')
    expect(orderedKeys(pool)).deep.equals(['k1', 'k2', 'k3'])
    // A failure that is not retried does not move the pool.
    keyAnswered(pool, 'k3')
    try {
      await withApiKeys(
        pool,
        async () => {
          throw new Error('bad request')
        },
        () => false
      )
    } catch {}
    expect(orderedKeys(pool)).deep.equals(['k3', 'k1', 'k2'])
    // An edited pool is a new pool, on its first key.
    expect(orderedKeys([...pool, 'k4'])[0]).equals('k1')
    for (let i = 0; i < 101; i++) keyAnswered([`p${i}`, `q${i}`], `q${i}`)
    expect(orderedKeys(pool)[0]).equals('k1')
    expect(orderedKeys(['p100', 'q100'])[0]).equals('q100')
    forgetCurrentKeys()
    expect(orderedKeys(['p100', 'q100'])[0]).equals('p100')
  })
  it('answers failures it may retry from the next key, and an empty pool with nothing', async () => {
    const seen: string[] = []
    expect(
      await untilAnswered(
        ['a', 'b'],
        async key => {
          seen.push(key)
          return seen.length === 1 ? { error: 'busy' } : { ok: key }
        },
        answer => ('error' in answer ? 'retry' : false)
      )
    ).deep.equals({ ok: seen[1] })
    expect(
      await untilAnswered(
        ['a', 'b'],
        async () => ({ error: 'bad' }),
        () => 'final'
      )
    ).deep.equals({ error: 'bad' })
    expect(
      await untilAnswered(
        [],
        async () => 1,
        () => false
      )
    ).equals(undefined)
    try {
      await untilAnswered(
        ['a'],
        async () => {
          throw new Error('bug')
        },
        () => false
      )
      expect.fail('rethrow')
    } catch (error) {
      expect((error as Error).message).equals('bug')
    }
    expect(redacted(`k-1 ${'x'.repeat(300)}`, 'k-1')).length(200)
    expect(redacted('k-1 said', 'k-1')).equals('[redacted] said')
    expect(redacted('plain', '')).equals('plain')
  })
})
