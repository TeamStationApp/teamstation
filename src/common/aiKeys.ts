/** The three credential pools editable only by a node administrator. */
export interface AiKeys {
  anthropicChatbot: string[]
  anthropicScoring: string[]
  xaiVoice: string[]
}

/** Legacy configuration accepts one key; new configuration accepts a pool. */
export type ApiKeyPool = string | string[]

export function normalizedKeys(keys: ApiKeyPool): string[] {
  return [
    ...new Set(
      (typeof keys === 'string' ? [keys] : keys)
        .map(key => key.trim())
        .filter(key => key !== '')
    )
  ]
}

export function asApiKeyPool(raw: unknown): string | string[] {
  if (typeof raw === 'string') return raw
  if (Array.isArray(raw) && raw.every(key => typeof key === 'string'))
    return normalizedKeys(raw)
  throw new TypeError('API keys must be a string or an array of strings')
}

export function asAiKeys(raw: unknown): AiKeys {
  if (raw == null || typeof raw !== 'object' || Array.isArray(raw))
    throw new TypeError('AI keys must be an object')
  const value = raw as Record<string, unknown>
  const pool = (name: keyof AiKeys): string[] => {
    const keys = value[name]
    if (!Array.isArray(keys) || !keys.every(key => typeof key === 'string'))
      throw new TypeError(`${name} must be an array of API keys`)
    return normalizedKeys(keys)
  }
  return {
    anthropicChatbot: pool('anthropicChatbot'),
    anthropicScoring: pool('anthropicScoring'),
    xaiVoice: pool('xaiVoice')
  }
}
