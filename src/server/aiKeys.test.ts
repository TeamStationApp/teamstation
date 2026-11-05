import { EventEmitter } from 'node:events'

import { expect } from 'chai'
import { afterEach, beforeEach, describe, it } from 'mocha'

import type { AiKeys } from '../common/aiKeys'
import { DEFAULT_DICTATION_MODEL } from '../common/api'
import {
  defaultNodeSettings,
  type NodeSettings,
  type NodeSettingsUpdate
} from '../common/nodeSettings'
import { TEST_AI_KEYS_SCOPE as S } from '../test/aiKeysScope'
import { actor, type GroupFixture, groupFixture } from '../test/groupFixtures'
import {
  AI_KEYS_SETTING,
  aiKeys,
  type AiSettings,
  aiSettings,
  fileAiKeys,
  forgetAiKeysNotices,
  storedAiKeys,
  storedAiKeysValue,
  tessAvailable
} from './aiKeys'
import type { Actor } from './auth/sessions'
import { endpointFor } from './dictation/models'
import { SttSession } from './dictation/stt'
import { nodeSettings, setNodeSettings } from './nodeSettings'
import { asServerConfig, type ServerConfig } from './serverConfig'
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
  const save = async (
    who: Actor,
    settings: NodeSettingsUpdate
  ): Promise<void> => {
    await setNodeSettings(f.h.db, who, settings, S)
  }
  const settingsFor = async (who: Actor): Promise<NodeSettings> =>
    await nodeSettings(f.h.db, who, S)
  const effective = async (config?: ServerConfig): Promise<AiKeys> =>
    (await aiKeys(f.h.db, config, S)).keys
  const settingsOf = async (config: ServerConfig): Promise<AiSettings> =>
    await aiSettings(f.h.db, config, S)
  it('prewarms and reuses the voice socket across holds with resolved legacy configuration', async () => {
    const config = asServerConfig({ dictation: { apiKey: 'legacy-voice' } })
    const resolved = (await settingsOf(config)).dictation!
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
    await save(actor(105), {
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
      expect(await settingsFor(caller)).not.has.property('aiKeys')
      try {
        await save(caller, {
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
    expect(await effective()).deep.equals(pools)
    expect((await settingsFor(actor(105))).aiKeys).deep.equals(pools)
  })
  it('scores with Grok on the voice pool alone, so a removed key is used for nothing', async () => {
    await save(actor(105), { ...defaultNodeSettings, aiKeys: pools })
    const legacy = asServerConfig({
      dictation: { apiKey: 'legacy-scoring', model: 'grok-example' }
    })
    const saved = (await settingsOf(legacy)).dictation!
    expect(saved.apiKey).deep.equals(pools.xaiVoice)
    expect(endpointFor('grok-example', saved)?.apiKey).deep.equals(
      pools.xaiVoice
    )
    await save(actor(105), {
      ...defaultNodeSettings,
      aiKeys: { ...pools, xaiVoice: ['voice-b'] }
    })
    expect(
      endpointFor('grok-example', (await settingsOf(legacy)).dictation!)?.apiKey
    ).deep.equals(['voice-b'])
    const fresh = (await settingsOf(asServerConfig({}))).dictation!
    expect(endpointFor('claude-example', fresh)?.apiKey).deep.equals(
      pools.anthropicScoring
    )
  })
  it('defaults scoring to a model the stored keys can reach', async () => {
    await save(actor(105), {
      ...defaultNodeSettings,
      aiKeys: { ...pools, anthropicScoring: [] }
    })
    const voiceOnly = (await settingsOf(asServerConfig({}))).dictation!
    expect(voiceOnly.model.startsWith('grok-')).equals(true)
    expect(endpointFor(voiceOnly.model, voiceOnly)).not.equals(undefined)
    await save(actor(105), { ...defaultNodeSettings, aiKeys: pools })
    expect((await settingsOf(asServerConfig({}))).dictation!.model).equals(
      DEFAULT_DICTATION_MODEL
    )
  })
  it('seals the pools for this server, and passes over a row another server saved', async () => {
    await save(actor(105), { ...defaultNodeSettings, aiKeys: pools })
    const row = await f.h.db
      .selectFrom('system_settings')
      .select('value')
      .where('key', '=', AI_KEYS_SETTING)
      .executeTakeFirstOrThrow()
    for (const key of Object.values(pools).flat())
      expect(JSON.stringify(row.value)).not.contains(key)
    expect(await storedAiKeys(f.h.db, S)).deep.equals(pools)
    forgetAiKeysNotices()
    const logged: string[] = []
    const error = console.error
    console.error = (message: string) => logged.push(message)
    try {
      // develop restored from production: same row, another server's secret.
      expect(
        await storedAiKeys(f.h.db, { ...S, secret: 'another-secret' })
      ).equals(undefined)
      expect(
        await storedAiKeys(f.h.db, { ...S, secret: 'another-secret' })
      ).equals(undefined)
      expect(
        await storedAiKeys(f.h.db, {
          ...S,
          origin: 'https://elsewhere.example'
        })
      ).equals(undefined)
      const legacy = asServerConfig({ tess: { apiKey: 'file-chat' } })
      const elsewhere = { ...S, origin: 'https://elsewhere.example' }
      expect(await aiKeys(f.h.db, legacy, elsewhere)).deep.equals({
        keys: fileAiKeys(legacy),
        saved: false
      })
      expect((await aiSettings(f.h.db, legacy, elsewhere)).tess?.apiKey).equals(
        'file-chat'
      )
      await f.h.db
        .updateTable('system_settings')
        .set({ value: JSON.stringify({ origin: S.origin, sealed: 'garbage' }) })
        .where('key', '=', AI_KEYS_SETTING)
        .execute()
      expect(await storedAiKeys(f.h.db, S)).equals(undefined)
      expect((await settingsFor(actor(105))).aiKeysSaved).equals(false)
    } finally {
      console.error = error
    }
    // Once per reason: the second open with the wrong secret says nothing.
    expect(logged).length(2)
    for (const line of logged) {
      expect(line).contains('using the file')
      expect(line).not.contains('garbage')
    }
    expect(() => storedAiKeysValue(pools, { ...S, secret: '' })).throws(
      'Set sessionSecret'
    )
  })
  it('stores nothing when a save repeats the file pools, and stores an edit', async () => {
    const stored = async (): Promise<number> =>
      (
        await f.h.db
          .selectFrom('system_settings')
          .select('key')
          .where('key', '=', AI_KEYS_SETTING)
          .execute()
      ).length
    await save(actor(105), { ...defaultNodeSettings, aiKeys: fileAiKeys() })
    expect(await stored()).equals(0)
    expect((await settingsFor(actor(105))).aiKeysSaved).equals(false)
    await save(actor(105), { ...defaultNodeSettings, aiKeys: pools })
    expect(await stored()).equals(1)
    expect(await effective()).deep.equals(pools)
    expect((await settingsFor(actor(105))).aiKeysSaved).equals(true)
    // Back to the file's keys.
    await save(actor(105), { ...defaultNodeSettings, aiKeys: null })
    expect(await stored()).equals(0)
    expect(await settingsFor(actor(105))).deep.include({
      aiKeys: fileAiKeys(),
      aiKeysSaved: false
    })
  })
  it('says once that saved keys override the file', async () => {
    forgetAiKeysNotices()
    const logged: string[] = []
    const log = console.log
    console.log = (message: string) => logged.push(message)
    try {
      await storedAiKeys(f.h.db, S)
      await save(actor(105), { ...defaultNodeSettings, aiKeys: pools })
      await storedAiKeys(f.h.db, S)
      await storedAiKeys(f.h.db, S)
    } finally {
      console.log = log
    }
    expect(logged).length(1)
    expect(logged[0]).contains('override serverConfig.json')
  })
  it('says whether Tess is on as the pools are now', async () => {
    const tess = tessAvailable(f.h.db, asServerConfig({}), S)
    expect(await tess()).equals(false)
    await save(actor(105), { ...defaultNodeSettings, aiKeys: pools })
    expect(await tess()).equals(true)
  })
  it('offers dictation and speech keys together as the one voice pool', () => {
    expect(
      fileAiKeys(
        asServerConfig({
          dictation: { apiKey: ['dictation', 'shared'] },
          speech: { apiKey: ['speech', 'shared'] }
        })
      ).xaiVoice
    ).deep.equals(['dictation', 'shared', 'speech'])
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
    expect(await effective()).deep.equals(pools)
    await f.h.request('PUT', '/node/settings', defaultNodeSettings, 105)
    expect(await effective()).deep.equals(pools)
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
    expect(await effective()).deep.equals(pools)
  })
  it('uses legacy defaults until saved and activates and disables each purpose without restarting', async () => {
    const config = asServerConfig({})
    expect(await settingsOf(config)).deep.equals({
      tess: null,
      speech: null,
      dictation: null
    })
    const legacy = asServerConfig({
      tess: { apiKey: 'chat' },
      dictation: { apiKey: 'voice', anthropic: { apiKey: 'score' } },
      speech: { apiKey: 'speech' }
    })
    expect(await effective(legacy)).deep.equals({
      anthropicChatbot: ['chat'],
      anthropicScoring: ['score'],
      xaiVoice: ['voice', 'speech']
    })
    const before = await settingsOf(legacy)
    expect(before.tess?.apiKey).equals('chat')
    expect(before.speech?.apiKey).equals('speech')
    await f.h.request(
      'PUT',
      '/node/settings',
      { ...defaultNodeSettings, aiKeys: pools },
      105
    )
    const after = await settingsOf(config)
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
    expect(await settingsOf(legacy)).deep.equals({
      tess: null,
      speech: null,
      dictation: null
    })
    expect(after.tess?.apiKey).deep.equals(pools.anthropicChatbot)
  })
})
