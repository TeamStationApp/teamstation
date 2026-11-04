import { type ApiKeyPool, normalizedKeys } from '../../common/aiKeys'
import type { Narration } from '../../common/replay/narration'
import { retryableStatus, withApiKeys } from '../aiKeyFallback'
import type { ServerConfig } from '../serverConfig'

/**
 * xAI's text to speech, for the replay's announcer. One request per
 * sentence, answered with the MP3 itself.
 */

export interface SpeechSettings {
  apiKey: ApiKeyPool
  baseUrl: string
  voice: string
  speed: number
  bitRate: number
}

export class SpeechUnavailable extends Error {
  constructor(
    message: string,
    readonly retryable = false
  ) {
    super(message)
    this.name = 'SpeechUnavailable'
  }
}

const TIMEOUT_MS = 20000

/** The announcer's settings, or null when nothing has a key to speak with. */
export function speechSettings(
  config: Pick<ServerConfig, 'speech' | 'dictation'>
): SpeechSettings | null {
  const apiKey = config.speech?.apiKey ?? config.dictation?.apiKey
  if (apiKey == null || normalizedKeys(apiKey).length === 0) return null
  return {
    apiKey,
    baseUrl: config.speech?.baseUrl ?? 'https://api.x.ai/v1',
    voice: config.speech?.voice ?? 'rex',
    speed: config.speech?.speed ?? 1.1,
    bitRate: config.speech?.bitRate ?? 64000
  }
}

/** The text as it is spoken: an excited sentence louder. */
export function spokenText(narration: Narration): string {
  return narration.emphasis === 'excited'
    ? `<loud>${narration.text}</loud>`
    : narration.text
}

async function synthesizeOnce(
  narration: Narration,
  settings: SpeechSettings,
  fetchImpl: typeof fetch = fetch,
  timeoutMs = TIMEOUT_MS
): Promise<Buffer> {
  const controller = new AbortController()
  const timer = setTimeout(() => {
    controller.abort()
  }, timeoutMs)
  try {
    const response = await fetchImpl(
      `${settings.baseUrl.replace(/\/$/, '')}/tts`,
      {
        method: 'POST',
        headers: {
          authorization: `Bearer ${String(settings.apiKey)}`,
          'content-type': 'application/json'
        },
        body: JSON.stringify({
          text: spokenText(narration),
          voice_id: settings.voice,
          language: 'en',
          speed: settings.speed,
          output_format: {
            codec: 'mp3',
            sample_rate: 24000,
            bit_rate: settings.bitRate
          }
        }),
        signal: controller.signal
      }
    )
    if (!response.ok)
      throw new SpeechUnavailable(
        `Speech answered ${response.status}`,
        retryableStatus(response.status)
      )
    const audio = Buffer.from(await response.arrayBuffer())
    if (audio.length === 0) throw new SpeechUnavailable('Speech was empty')
    return audio
  } catch (error) {
    if (error instanceof SpeechUnavailable) throw error
    throw new SpeechUnavailable(
      controller.signal.aborted
        ? 'Speech timed out'
        : 'Speech could not be reached',
      true
    )
  } finally {
    clearTimeout(timer)
  }
}

export async function synthesize(
  narration: Narration,
  settings: SpeechSettings,
  fetchImpl: typeof fetch = fetch,
  timeoutMs = TIMEOUT_MS
): Promise<Buffer> {
  return await withApiKeys(
    settings.apiKey,
    async key =>
      await synthesizeOnce(
        narration,
        { ...settings, apiKey: key },
        fetchImpl,
        timeoutMs
      ),
    error => error instanceof SpeechUnavailable && error.retryable
  )
}
