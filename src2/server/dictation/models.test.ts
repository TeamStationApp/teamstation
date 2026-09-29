import { expect } from 'chai'
import { describe, it } from 'mocha'

import { DICTATION_MODELS } from '../../common/api'
import { endpointFor, modelsOf, type ProviderKeys } from './models'

const XAI: ProviderKeys = { apiKey: 'xai', baseUrl: 'https://api.x.ai/v1' }
const ALL: ProviderKeys = {
  ...XAI,
  openai: { apiKey: 'openai', baseUrl: 'https://api.openai.com/v1' },
  anthropic: { apiKey: 'anthropic', baseUrl: 'https://api.anthropic.com/v1' }
}

describe('dictation models', function () {
  it('sends each model to its provider, in its request shape', function () {
    expect(endpointFor('grok-4.3', ALL)).deep.equals({
      api: 'chat',
      apiKey: 'xai',
      baseUrl: 'https://api.x.ai/v1'
    })
    expect(endpointFor('gpt-6-sol', ALL)).deep.equals({
      api: 'chat',
      apiKey: 'openai',
      baseUrl: 'https://api.openai.com/v1',
      body: { reasoning_effort: 'none' },
      followUp: true,
      gameInUserMessage: true
    })
    expect(endpointFor('claude-haiku-4-5-20251001', ALL)).deep.equals({
      api: 'messages',
      apiKey: 'anthropic',
      baseUrl: 'https://api.anthropic.com/v1'
    })
    expect(endpointFor('llama-9', ALL)).equals(undefined)
  })

  it('offers only the models it has a key for, in the scorer’s order', function () {
    expect(modelsOf(ALL)).deep.equals([...DICTATION_MODELS])
    expect(modelsOf(XAI)).deep.equals(['grok-4.3'])
    expect(endpointFor('gpt-6-luna', XAI)).equals(undefined)
    expect(endpointFor('claude-haiku-4-5-20251001', XAI)).equals(undefined)
  })
})
