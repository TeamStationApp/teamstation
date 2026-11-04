import { type ApiKeyPool, normalizedKeys } from '../../common/aiKeys'
import { DICTATION_MODELS, type DictationModel } from '../../common/api'

/** Where an LLM is reached, and in which of the two request shapes. */
export interface LlmEndpoint {
  /** `chat`: OpenAI's chat completions, which xAI speaks too; `messages`: Anthropic's. */
  api: 'chat' | 'messages'
  apiKey: ApiKeyPool
  baseUrl: string
  /** Fields the provider needs on every request for this model. */
  body?: Record<string, unknown>
  /** Answer each call and ask again: the model makes one call a reply. */
  followUp?: boolean
  /** The game in the user message: the layout this provider caches. */
  gameInUserMessage?: boolean
}

export interface ProviderKeys {
  /** xAI's, for the dictation model and the Grok LLMs. */
  apiKey: ApiKeyPool
  baseUrl: string
  /** Legacy Grok scoring keys, kept separate when voice keys are overridden. */
  grokApiKey?: ApiKeyPool
  openai?: { apiKey: ApiKeyPool; baseUrl: string }
  anthropic?: { apiKey: ApiKeyPool; baseUrl: string }
}

/**
 * The provider that serves a model on this server, or undefined when the
 * server has no key for it. Grok is xAI's; GPT is OpenAI's, with reasoning off,
 * which is how its chat completions take tools and the fastest it answers,
 * and asked again after each call, since so it makes one call a reply;
 * Claude is Anthropic's.
 */
export function endpointFor(
  model: string,
  keys: ProviderKeys
): LlmEndpoint | undefined {
  const grokApiKey = keys.grokApiKey ?? keys.apiKey
  if (model.startsWith('grok-') && normalizedKeys(grokApiKey).length > 0)
    return { api: 'chat', apiKey: grokApiKey, baseUrl: keys.baseUrl }
  if (
    model.startsWith('gpt-') &&
    keys.openai != null &&
    normalizedKeys(keys.openai.apiKey).length > 0
  )
    return {
      api: 'chat',
      ...keys.openai,
      body: { reasoning_effort: 'none' },
      followUp: true,
      gameInUserMessage: true
    }
  if (
    model.startsWith('claude-') &&
    keys.anthropic != null &&
    normalizedKeys(keys.anthropic.apiKey).length > 0
  )
    return { api: 'messages', ...keys.anthropic }
  return undefined
}

/** The models this server can put an utterance to, in the scorer's order. */
export function modelsOf(keys: ProviderKeys): DictationModel[] {
  return DICTATION_MODELS.filter(model => endpointFor(model, keys) != null)
}
