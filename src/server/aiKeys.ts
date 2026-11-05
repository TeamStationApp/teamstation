import type { Kysely } from 'kysely'

import { type AiKeys, asAiKeys, normalizedKeys } from '../common/aiKeys'
import { DEFAULT_DICTATION_MODEL } from '../common/api'
import { unavailable } from '../common/errors'
import type { Database } from './db/database'
import { endpointFor, modelsOf } from './dictation/models'
import type { DictationConfig } from './dictation/route'
import { openSecret, sealSecret } from './live/secrets'
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

/**
 * Which server the stored pools belong to. The pools are sealed under the
 * server's `sessionSecret`, as stream keys are, and carry the origin that
 * saved them. A database copied to another server (develop is restored from
 * production every night) brings the row along, but there it cannot be read
 * and is ignored, and that server keeps to its own file configuration.
 */
export interface AiKeysScope {
  origin: string
  secret: string
}

export const serverAiKeysScope: AiKeysScope = {
  origin: publicUrl,
  secret: serverConfig.sessionSecret
}

interface StoredAiKeys {
  origin: string
  sealed: string
}

/** The row as written for this server. */
export function storedAiKeysValue(
  keys: AiKeys,
  scope: AiKeysScope = serverAiKeysScope
): StoredAiKeys {
  if (scope.secret === '')
    throw unavailable('Set sessionSecret on this server to save AI API keys')
  return {
    origin: scope.origin,
    sealed: sealSecret(scope.secret, JSON.stringify(asAiKeys(keys)))
  }
}

/** Each reason a row was passed over, said once per process. */
const said = new Set<string>()
function sayOnce(reason: string): void {
  if (said.has(reason)) return
  said.add(reason)
  console.error(`${AI_KEYS_SETTING} ${reason}; using the file's keys`)
}

/**
 * No process cache: every worker sees a save on its next request. A row that
 * cannot be read, or that another server saved, is absent: the file's keys
 * apply and an administrator can save over it.
 */
export async function storedAiKeys(
  db: Kysely<Database>,
  scope: AiKeysScope = serverAiKeysScope
): Promise<AiKeys | undefined> {
  const row = await db
    .selectFrom('system_settings')
    .select('value')
    .where('key', '=', AI_KEYS_SETTING)
    .executeTakeFirst()
  if (row == null) return undefined
  const value = row.value as Partial<StoredAiKeys> | null
  if (value?.origin !== scope.origin) {
    sayOnce(`was saved by ${String(value?.origin)}, not ${scope.origin}`)
    return undefined
  }
  try {
    return asAiKeys(JSON.parse(openSecret(scope.secret, String(value.sealed))))
  } catch {
    // Never the error itself: a failed open could quote what it was given.
    sayOnce('cannot be opened with this server’s sessionSecret')
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

/** The pools in effect, and whether a save of this server's put them there. */
export async function aiKeys(
  db: Kysely<Database>,
  config: ServerConfig = serverConfig,
  scope: AiKeysScope = serverAiKeysScope
): Promise<{ keys: AiKeys; saved: boolean }> {
  const stored = await storedAiKeys(db, scope)
  return stored == null
    ? { keys: fileAiKeys(config), saved: false }
    : { keys: stored, saved: true }
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
  scope: AiKeysScope = serverAiKeysScope
): Promise<boolean> {
  if ((await storedAiKeys(db, scope)) != null) return true
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

/**
 * Dictation's settings around the given pools, with the file's endpoints.
 * Grok scoring is xAI too, so it takes the voice pool: a key the
 * administrator removes from that pool is used for nothing.
 */
export function dictationConfig(
  config: ServerConfig,
  keys: Pick<AiKeys, 'anthropicScoring' | 'xaiVoice'>
): DictationConfig {
  const dictation: DictationConfig = {
    apiKey: keys.xaiVoice,
    baseUrl: config.dictation?.baseUrl ?? AI_DEFAULTS.xaiBaseUrl,
    sttUrl: config.dictation?.sttUrl ?? AI_DEFAULTS.sttUrl,
    sttModel: config.dictation?.sttModel ?? AI_DEFAULTS.sttModel,
    model: config.dictation?.model ?? DEFAULT_DICTATION_MODEL,
    openai: config.dictation?.openai,
    anthropic: {
      apiKey: keys.anthropicScoring,
      baseUrl:
        config.dictation?.anthropic?.baseUrl ?? AI_DEFAULTS.anthropicBaseUrl
    }
  }
  // With no model named in the file, one these keys can actually reach.
  if (
    config.dictation?.model == null &&
    endpointFor(dictation.model, dictation) == null
  )
    dictation.model = modelsOf(dictation)[0] ?? dictation.model
  return dictation
}

/** Resolve one immutable snapshot; missing rows preserve the file's fallbacks. */
export async function aiSettings(
  db: Kysely<Database>,
  config: ServerConfig = serverConfig,
  scope: AiKeysScope = serverAiKeysScope
): Promise<AiSettings> {
  const stored = await storedAiKeys(db, scope)
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

/** Said at startup, so an operator who edits the file knows why it has no effect. */
export async function sayStoredAiKeys(
  db: Kysely<Database>,
  scope: AiKeysScope = serverAiKeysScope
): Promise<void> {
  if ((await storedAiKeys(db, scope)) != null)
    console.log(
      `${AI_KEYS_SETTING}: keys saved in node administration override serverConfig.json's AI keys`
    )
}
