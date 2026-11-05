import type { Kysely } from 'kysely'

import { type AiKeys, asAiKeys, normalizedKeys } from '../common/aiKeys'
import type { Database } from './db/database'
import type { DictationConfig } from './dictation/route'
import { type SpeechSettings, speechSettings } from './replay/speech'
import {
  publicUrl,
  type ServerConfig,
  serverConfig,
  type TessSettings,
  tessSettings
} from './serverConfig'
import { AI_DEFAULTS } from './serverConfigSchema'

export const AI_KEYS_SETTING = 'ai.keys'

/** Scoring with only administrator pools has no xAI LLM to default to. */
const POOLED_SCORING_MODEL = 'claude-haiku-5-5'

/**
 * The stored pools carry the origin that saved them. A database copied to
 * another server (develop is restored from production every night) keeps the
 * row, but that server ignores it and uses its own file configuration.
 */
interface StoredAiKeys extends AiKeys {
  origin: string
}

/** The row as written for this server's own origin. */
export function storedAiKeysValue(
  keys: AiKeys,
  origin: string = publicUrl
): StoredAiKeys {
  return { origin, ...asAiKeys(keys) }
}

/**
 * No process cache: every worker sees a save on its next request. A row that
 * cannot be read, or that another origin saved, is absent: the file's keys
 * apply and an administrator can save over it.
 */
export async function storedAiKeys(
  db: Kysely<Database>,
  origin: string = publicUrl
): Promise<AiKeys | undefined> {
  const row = await db
    .selectFrom('system_settings')
    .select('value')
    .where('key', '=', AI_KEYS_SETTING)
    .executeTakeFirst()
  if (row == null) return undefined
  const value = row.value as Partial<StoredAiKeys> | null
  if (value?.origin !== origin) return undefined
  try {
    return asAiKeys(value)
  } catch (error) {
    console.error(
      `${AI_KEYS_SETTING} is unreadable, using the file's keys: ${error instanceof Error ? error.message : String(error)}`
    )
    return undefined
  }
}

/** The pools the file configuration gives, before any administrator save. */
export function fileAiKeys(config: ServerConfig = serverConfig): AiKeys {
  return {
    anthropicChatbot: normalizedKeys(
      config.tess?.apiKey ?? config.dictation?.anthropic?.apiKey ?? []
    ),
    anthropicScoring: normalizedKeys(config.dictation?.anthropic?.apiKey ?? []),
    // Dictation and narration may name different keys; the one pool serves both.
    xaiVoice: normalizedKeys([
      ...normalizedKeys(config.dictation?.apiKey ?? []),
      ...normalizedKeys(config.speech?.apiKey ?? [])
    ])
  }
}

/** The administrator sees the effective pools, including file defaults. */
export async function aiKeys(
  db: Kysely<Database>,
  config: ServerConfig = serverConfig,
  origin: string = publicUrl
): Promise<AiKeys> {
  return (await storedAiKeys(db, origin)) ?? fileAiKeys(config)
}

/**
 * Whether saving `keys` would change anything. Saving the file's own pools
 * while no row is stored writes nothing, so a save of unrelated settings
 * never freezes the file's keys into the database.
 */
export async function aiKeysChange(
  db: Kysely<Database>,
  keys: AiKeys,
  config: ServerConfig = serverConfig,
  origin: string = publicUrl
): Promise<boolean> {
  if ((await storedAiKeys(db, origin)) != null) return true
  const file = fileAiKeys(config)
  const wanted = asAiKeys(keys)
  return (Object.keys(file) as Array<keyof AiKeys>).some(
    name => file[name].join('\n') !== wanted[name].join('\n')
  )
}

export interface AiSettings {
  tess: TessSettings | null
  speech: SpeechSettings | null
  dictation: DictationConfig | null
}

/** Dictation's settings around the given pools, with the file's endpoints. */
export function dictationConfig(
  config: ServerConfig,
  keys: Pick<AiKeys, 'anthropicScoring' | 'xaiVoice'>
): DictationConfig {
  return {
    apiKey: keys.xaiVoice,
    // The file's xAI key keeps scoring with Grok; administrator keys add to it.
    grokApiKey: normalizedKeys([
      ...normalizedKeys(config.dictation?.apiKey ?? []),
      ...keys.xaiVoice
    ]),
    baseUrl: config.dictation?.baseUrl ?? AI_DEFAULTS.xaiBaseUrl,
    sttUrl: config.dictation?.sttUrl ?? AI_DEFAULTS.sttUrl,
    sttModel: config.dictation?.sttModel ?? AI_DEFAULTS.sttModel,
    model: config.dictation?.model ?? POOLED_SCORING_MODEL,
    openai: config.dictation?.openai,
    anthropic: {
      apiKey: keys.anthropicScoring,
      baseUrl:
        config.dictation?.anthropic?.baseUrl ?? AI_DEFAULTS.anthropicBaseUrl
    }
  }
}

/** Resolve one immutable snapshot; missing rows preserve the file's fallbacks. */
export async function aiSettings(
  db: Kysely<Database>,
  config: ServerConfig = serverConfig,
  origin: string = publicUrl
): Promise<AiSettings> {
  const stored = await storedAiKeys(db, origin)
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
  const dictation = dictationConfig(config, stored)
  // Stored pools never fall back to another purpose's keys, even when empty.
  const effective = {
    dictation: undefined,
    tess: {
      baseUrl: config.tess?.baseUrl ?? AI_DEFAULTS.anthropicBaseUrl,
      model: config.tess?.model ?? AI_DEFAULTS.tessModel,
      apiKey: stored.anthropicChatbot
    },
    speech: {
      baseUrl: config.speech?.baseUrl ?? AI_DEFAULTS.xaiBaseUrl,
      voice: config.speech?.voice ?? AI_DEFAULTS.voice,
      speed: config.speech?.speed ?? AI_DEFAULTS.speed,
      bitRate: config.speech?.bitRate ?? AI_DEFAULTS.bitRate,
      apiKey: stored.xaiVoice
    }
  }
  return {
    tess: tessSettings(effective),
    speech: speechSettings(effective),
    dictation: stored.xaiVoice.length === 0 ? null : dictation
  }
}
