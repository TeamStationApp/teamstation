import { expect } from 'chai'
import { describe, it } from 'mocha'

import type { ServerConfig } from '../serverConfig'
import {
  type SpeechSettings,
  speechSettings,
  SpeechUnavailable,
  spokenText,
  synthesize
} from './speech'

const dictation = (apiKey: string): ServerConfig['dictation'] => ({
  apiKey,
  baseUrl: 'https://api.x.ai/v1',
  sttUrl: 'wss://api.x.ai/v1/stt',
  sttModel: 'grok-voice-transcribe-2.0',
  model: 'grok-4.3',
  openai: undefined,
  anthropic: undefined
})
const speech: NonNullable<ServerConfig['speech']> = {
  apiKey: undefined,
  baseUrl: 'https://api.x.ai/v1',
  voice: 'rex',
  speed: 1.1,
  bitRate: 64000
}

const settings: SpeechSettings = {
  apiKey: 'xai-test-key',
  baseUrl: 'https://speech.example.test/v1/',
  voice: 'rex',
  speed: 1.1,
  bitRate: 64000
}

function fakeFetch(
  answer: () => Response | Promise<Response>,
  seen: Array<{ url: string; init: RequestInit }> = []
): typeof fetch {
  return async (url: string | URL | Request, init?: RequestInit) => {
    const href =
      typeof url === 'string' ? url : url instanceof URL ? url.href : url.url
    seen.push({ url: href, init: init ?? {} })
    return await answer()
  }
}

async function refusal(promise: Promise<unknown>): Promise<Error> {
  try {
    await promise
  } catch (error) {
    return error as Error
  }
  throw new Error('expected a refusal')
}

describe('replay speech', function () {
  it('asks for the sentence as MP3 in the configured voice, and answers its bytes', async function () {
    const seen: Array<{ url: string; init: RequestInit }> = []
    const audio = await synthesize(
      { text: 'Ball one, one and oh.', emphasis: 'calm' },
      settings,
      fakeFetch(() => new Response(new Uint8Array([1, 2, 3])), seen)
    )
    expect([...audio]).deep.equals([1, 2, 3])
    expect(seen[0].url).equals('https://speech.example.test/v1/tts')
    expect(seen[0].init.method).equals('POST')
    expect(
      (seen[0].init.headers as Record<string, string>).authorization
    ).equals('Bearer xai-test-key')
    expect(JSON.parse(seen[0].init.body as string)).deep.equals({
      text: 'Ball one, one and oh.',
      voice_id: 'rex',
      language: 'en',
      speed: 1.1,
      output_format: { codec: 'mp3', sample_rate: 24000, bit_rate: 64000 }
    })
  })

  it('says an excited sentence louder', function () {
    expect(spokenText({ text: 'Gone!', emphasis: 'excited' })).equals(
      '<loud>Gone!</loud>'
    )
    expect(spokenText({ text: 'Ball one.', emphasis: 'calm' })).equals(
      'Ball one.'
    )
  })

  it('refuses a 4xx, a 5xx, an empty answer, a network failure and a timeout', async function () {
    const narration = { text: 'Ball one.', emphasis: 'calm' as const }
    for (const status of [401, 503]) {
      const error = await refusal(
        synthesize(
          narration,
          settings,
          fakeFetch(() => new Response('no', { status }))
        )
      )
      expect(error).instanceOf(SpeechUnavailable)
      expect(error.message).equals(`Speech answered ${status}`)
    }
    expect(
      (
        await refusal(
          synthesize(
            narration,
            settings,
            fakeFetch(() => new Response(new Uint8Array()))
          )
        )
      ).message
    ).equals('Speech was empty')
    expect(
      (
        await refusal(
          synthesize(
            narration,
            settings,
            fakeFetch(() => {
              throw new Error('connection refused')
            })
          )
        )
      ).message
    ).equals('Speech failed: connection refused')
    const hung: typeof fetch = async (
      _url: string | URL | Request,
      init?: RequestInit
    ) =>
      await new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => {
          reject(new Error('aborted'))
        })
      })
    const timedOut = await refusal(synthesize(narration, settings, hung, 20))
    expect(timedOut).instanceOf(SpeechUnavailable)
    expect(timedOut.message).equals('Speech timed out')
  })

  it("takes its key from speech, else dictation's, and is off without one", function () {
    expect(speechSettings({ speech: undefined, dictation: undefined })).equals(
      null
    )
    const fromDictation = speechSettings({
      speech: undefined,
      dictation: dictation('dictation-key')
    })
    expect(fromDictation).deep.equals({
      apiKey: 'dictation-key',
      baseUrl: 'https://api.x.ai/v1',
      voice: 'rex',
      speed: 1.1,
      bitRate: 64000
    })
    expect(
      speechSettings({
        speech: {
          apiKey: 'speech-key',
          baseUrl: 'http://127.0.0.1:1/v1',
          voice: 'leo',
          speed: 1,
          bitRate: 32000
        },
        dictation: dictation('dictation-key')
      })
    ).deep.equals({
      apiKey: 'speech-key',
      baseUrl: 'http://127.0.0.1:1/v1',
      voice: 'leo',
      speed: 1,
      bitRate: 32000
    })
    expect(
      speechSettings({
        speech: { ...speech, apiKey: '' },
        dictation: undefined
      })
    ).equals(null)
  })
})
