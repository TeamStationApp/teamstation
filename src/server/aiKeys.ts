import type { Kysely } from 'kysely'

import { type AiKeys, asAiKeys, normalizedKeys } from '../common/aiKeys'
import type { Database } from './db/database'
import type { DictationConfig } from './dictation/route'
import { type SpeechSettings, speechSettings } from './replay/speech'
import {
  type ServerConfig,
  serverConfig,
  type TessSettings,
  tessSettings
} from './serverConfig'

export const AI_KEYS_SETTING = 'ai.keys'

/** No process cache: every worker sees a save on its next request. */
export async function storedAiKeys(
  db: Kysely<Database>
): Promise<AiKeys | undefined> {
  const row = await db
    .selectFrom('system_settings')
    .select('value')
    .where('key', '=', AI_KEYS_SETTING)
    .executeTakeFirst()
  return row == null ? undefined : asAiKeys(row.value)
}

/** The administrator sees the effective pools, including file defaults. */
export async function aiKeys(
  db: Kysely<Database>,
  config: ServerConfig = serverConfig
): Promise<AiKeys> {
  return (
    (await storedAiKeys(db)) ?? {
      anthropicChatbot: normalizedKeys(
        config.tess?.apiKey ?? config.dictation?.anthropic?.apiKey ?? []
      ),
      anthropicScoring: normalizedKeys(
        config.dictation?.anthropic?.apiKey ?? []
      ),
      xaiVoice: normalizedKeys(
        config.dictation?.apiKey ?? config.speech?.apiKey ?? []
      )
    }
  )
}

export interface AiSettings {
  tess: TessSettings | null
  speech: SpeechSettings | null
  dictation: DictationConfig | null
}

/** Resolve one immutable snapshot; missing rows preserve the file's fallbacks. */
export async function aiSettings(
  db: Kysely<Database>,
  config: ServerConfig = serverConfig
): Promise<AiSettings> {
  const stored = await storedAiKeys(db)
  if (stored == null)
    return {
      tess: tessSettings(config),
      speech: speechSettings(config),
      dictation:
        config.dictation == null ||
        normalizedKeys(config.dictation.apiKey).length === 0
          ? null
          : config.dictation
    }
  const dictation = {
    apiKey: stored.xaiVoice,
    grokApiKey: config.dictation?.apiKey ?? [],
    baseUrl: config.dictation?.baseUrl ?? 'https://api.x.ai/v1',
    sttUrl: config.dictation?.sttUrl ?? 'wss://api.x.ai/v1/stt',
    sttModel: config.dictation?.sttModel ?? 'grok-voice-transcribe-2.0',
    model: config.dictation?.model ?? 'claude-haiku-5-5',
    openai: config.dictation?.openai,
    anthropic: {
      apiKey: stored.anthropicScoring,
      baseUrl:
        config.dictation?.anthropic?.baseUrl ?? 'https://api.anthropic.com/v1'
    }
  }
  const effective = {
    ...config,
    dictation,
    tess: {
      baseUrl: config.tess?.baseUrl ?? 'https://api.anthropic.com/v1',
      model: config.tess?.model ?? 'claude-sonnet-5-5',
      apiKey: stored.anthropicChatbot
    },
    speech: {
      baseUrl: config.speech?.baseUrl ?? 'https://api.x.ai/v1',
      voice: config.speech?.voice ?? 'rex',
      speed: config.speech?.speed ?? 1.1,
      bitRate: config.speech?.bitRate ?? 64000,
      apiKey: stored.xaiVoice
    }
  }
  return {
    tess: tessSettings(effective),
    speech: speechSettings(effective),
    dictation: stored.xaiVoice.length === 0 ? null : dictation
  }
}
