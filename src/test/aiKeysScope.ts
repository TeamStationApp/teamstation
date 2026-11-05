import type { AiKeysScope } from '../server/aiKeys'
import { publicUrl } from '../server/serverConfig'

/** Test servers have no sessionSecret, so AI keys are sealed under this one. */
export const TEST_AI_KEYS_SCOPE: AiKeysScope = {
  origin: publicUrl,
  secret: 'test-ai-keys-secret'
}
