import { DICTATION_MODELS, type DictationModel } from '../../common/api'

/** Where an LLM is reached, and in which of the two request shapes. */
export interface LlmEndpoint {
  /** `chat`: OpenAI's chat completions, which xAI speaks too; `messages`: Anthropic's. */
  api: 'chat' | 'messages'
  apiKey: string
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
  apiKey: string
  baseUrl: string
  openai?: { apiKey: string; baseUrl: string }
  anthropic?: { apiKey: string; baseUrl: string }
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
  if (model.startsWith('grok-'))
    return { api: 'chat', apiKey: keys.apiKey, baseUrl: keys.baseUrl }
  if (model.startsWith('gpt-') && keys.openai != null)
    return {
      api: 'chat',
      ...keys.openai,
      body: { reasoning_effort: 'none' },
      followUp: true,
      gameInUserMessage: true
    }
  if (model.startsWith('claude-') && keys.anthropic != null)
    return { api: 'messages', ...keys.anthropic }
  return undefined
}

/** The models this server can put an utterance to, in the scorer's order. */
export function modelsOf(keys: ProviderKeys): DictationModel[] {
  return DICTATION_MODELS.filter(model => endpointFor(model, keys) != null)
}
