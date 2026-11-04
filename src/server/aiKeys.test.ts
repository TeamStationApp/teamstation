import { EventEmitter } from 'node:events'

import { expect } from 'chai'
import { afterEach, beforeEach, describe, it } from 'mocha'

import { defaultNodeSettings } from '../common/nodeSettings'
import { actor, type GroupFixture, groupFixture } from '../test/groupFixtures'
import { aiKeys, aiSettings } from './aiKeys'
import { endpointFor } from './dictation/models'
import { SttSession } from './dictation/stt'
import { nodeSettings, setNodeSettings } from './nodeSettings'
import { asServerConfig } from './serverConfig'
import { apiCall } from './tess/loopback'

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
  it('prewarms and reuses the voice socket across holds with resolved legacy configuration', async () => {
    const config = asServerConfig({ dictation: { apiKey: 'legacy-voice' } })
    const resolved = (await aiSettings(f.h.db, config)).dictation!
    expect(resolved.apiKey).equals('legacy-voice')
    const sockets: EventEmitter[] = []
    const finals: string[] = []
    const session = new SttSession(
      {
        apiKey: resolved.apiKey,
        connect: () => {
          const socket = Object.assign(new EventEmitter(), {
            send: (_frame: Buffer | string) => undefined,
            close: () => undefined
          })
          sockets.push(socket)
          return socket
        }
      },
      {
        onPartial: () => undefined,
        onError: message => expect.fail(message),
        onFinal: text => finals.push(text)
      }
    )
    try {
      session.retarget(['Trout'])
      expect(sockets).length(1)
      sockets[0].emit('open')
      sockets[0].emit('message', JSON.stringify({ type: 'transcript.created' }))
      for (const text of ['Ball one', 'Strike one']) {
        session.begin()
        session.write(Buffer.from([1, 0]))
        session.end()
        sockets[0].emit(
          'message',
          JSON.stringify({
            type: 'transcript.partial',
            speech_final: true,
            text
          })
        )
      }
      expect(finals).deep.equals(['Ball one', 'Strike one'])
      expect(sockets).length(1)
    } finally {
      session.close()
    }
  })
  it('keeps credentials out of chatbot tool results and rejects nonhuman credential changes', async () => {
    await setNodeSettings(f.h.db, actor(105), {
      ...defaultNodeSettings,
      aiKeys: pools
    })
    const credentials = { authorization: `Bearer ${f.h.tokens.get(105)!}` }
    const read = await apiCall(f.h.origin, credentials, 'GET', '/node/settings')
    expect(read.status).equals(200)
    expect(JSON.parse(read.body)).not.has.property('aiKeys')
    for (const key of Object.values(pools).flat())
      expect(read.body).not.contains(key)
    const denied = await apiCall(
      f.h.origin,
      credentials,
      'PUT',
      '/node/settings',
      undefined,
      {
        ...defaultNodeSettings,
        aiKeys: { ...pools, xaiVoice: ['replacement'] }
      }
    )
    expect(denied.status).equals(403)
    const ordinary = await apiCall(
      f.h.origin,
      credentials,
      'PUT',
      '/node/settings',
      undefined,
      defaultNodeSettings
    )
    expect(ordinary.status).equals(200)
    expect(JSON.parse(ordinary.body)).not.has.property('aiKeys')
    for (const caller of [
      { ...actor(105), viaTess: true as const },
      {
        ...actor(105),
        apiKey: { id: 'fixture-key', permissions: new Set<never>() }
      }
    ]) {
      expect(await nodeSettings(f.h.db, caller)).not.has.property('aiKeys')
      try {
        await setNodeSettings(f.h.db, caller, {
          ...defaultNodeSettings,
          aiKeys: pools
        })
        expect.fail('Expected credential write to be denied')
      } catch (error) {
        expect((error as Error).message).equals(
          'Sign in directly to change AI API keys'
        )
      }
    }
    expect(await aiKeys(f.h.db)).deep.equals(pools)
    expect((await nodeSettings(f.h.db, actor(105))).aiKeys).deep.equals(pools)
  })
  it('never uses administrator voice keys for legacy Grok scoring', async () => {
    await setNodeSettings(f.h.db, actor(105), {
      ...defaultNodeSettings,
      aiKeys: pools
    })
    const legacy = asServerConfig({
      dictation: { apiKey: 'legacy-scoring', model: 'grok-example' }
    })
    const saved = (await aiSettings(f.h.db, legacy)).dictation!
    expect(saved.apiKey).deep.equals(pools.xaiVoice)
    expect(endpointFor('grok-example', saved)?.apiKey).equals('legacy-scoring')
    const fresh = (await aiSettings(f.h.db, asServerConfig({}))).dictation!
    expect(endpointFor('grok-example', fresh)).equals(undefined)
    expect(endpointFor('claude-example', fresh)?.apiKey).deep.equals(
      pools.anthropicScoring
    )
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
