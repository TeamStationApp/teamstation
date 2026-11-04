import { expect } from 'chai'
import { afterEach, beforeEach, describe, it } from 'mocha'

import { defaultNodeSettings } from '../common/nodeSettings'
import { type GroupFixture, groupFixture } from '../test/groupFixtures'
import { aiKeys, aiSettings } from './aiKeys'
import { asServerConfig } from './serverConfig'

const pools = {
  anthropicChatbot: ['chat-a', 'chat-b'],
  anthropicScoring: ['score-a', 'score-b'],
  xaiVoice: ['voice-a', 'voice-b']
}

describe('administrator API keys', function () {
  this.timeout(60000)
  let f: GroupFixture
  beforeEach(async () => {
    f = await groupFixture()
  })
  afterEach(async () => {
    await f?.h.close()
  })
  it('restricts reads and writes, stores normalized arrays, and preserves keys for older clients', async () => {
    expect(
      (await f.h.request('GET', '/node/settings', undefined, 101)).status
    ).equals(403)
    expect(
      (
        await f.h.request(
          'PUT',
          '/node/settings',
          { ...defaultNodeSettings, aiKeys: pools },
          101
        )
      ).status
    ).equals(403)
    const saved = await f.h.request(
      'PUT',
      '/node/settings',
      {
        ...defaultNodeSettings,
        aiKeys: {
          ...pools,
          anthropicChatbot: [' chat-a ', '', 'chat-a', 'chat-b']
        }
      },
      105
    )
    expect(saved.status).equals(200)
    expect(saved.headers.get('cache-control')).equals('no-store')
    expect((await saved.json()).aiKeys).deep.equals(pools)
    expect(await aiKeys(f.h.db)).deep.equals(pools)
    await f.h.request('PUT', '/node/settings', defaultNodeSettings, 105)
    expect(await aiKeys(f.h.db)).deep.equals(pools)
    const bad = await f.h.request(
      'PUT',
      '/node/settings',
      {
        ...defaultNodeSettings,
        aiKeys: { ...pools, xaiVoice: 'private-placeholder' }
      },
      105
    )
    expect(bad.status).equals(400)
    expect(await bad.text()).not.contains('private-placeholder')
    expect(await aiKeys(f.h.db)).deep.equals(pools)
  })
  it('uses legacy defaults until saved and activates and disables each purpose without restarting', async () => {
    const config = asServerConfig({})
    expect(await aiSettings(f.h.db, config)).deep.equals({
      tess: null,
      speech: null,
      dictation: null
    })
    const legacy = asServerConfig({
      tess: { apiKey: 'chat' },
      dictation: { apiKey: 'voice', anthropic: { apiKey: 'score' } },
      speech: { apiKey: 'speech' }
    })
    expect(await aiKeys(f.h.db, legacy)).deep.equals({
      anthropicChatbot: ['chat'],
      anthropicScoring: ['score'],
      xaiVoice: ['voice']
    })
    const before = await aiSettings(f.h.db, legacy)
    expect(before.tess?.apiKey).equals('chat')
    expect(before.speech?.apiKey).equals('speech')
    await f.h.request(
      'PUT',
      '/node/settings',
      { ...defaultNodeSettings, aiKeys: pools },
      105
    )
    const after = await aiSettings(f.h.db, config)
    expect(after.tess?.apiKey).deep.equals(pools.anthropicChatbot)
    expect(after.dictation?.anthropic?.apiKey).deep.equals(
      pools.anthropicScoring
    )
    expect(after.speech?.apiKey).deep.equals(pools.xaiVoice)
    expect(after.dictation?.apiKey).deep.equals(pools.xaiVoice)
    await f.h.request(
      'PUT',
      '/node/settings',
      {
        ...defaultNodeSettings,
        aiKeys: { anthropicChatbot: [], anthropicScoring: [], xaiVoice: [] }
      },
      105
    )
    expect(await aiSettings(f.h.db, legacy)).deep.equals({
      tess: null,
      speech: null,
      dictation: null
    })
    expect(after.tess?.apiKey).deep.equals(pools.anthropicChatbot)
  })
})
