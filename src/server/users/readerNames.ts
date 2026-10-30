import { AsyncLocalStorage } from 'node:async_hooks'

/**
 * Whether this request's names go to a model. Tess reaches the API the way the
 * app does, and what it answers her, a change she made included, is put in
 * front of an LLM, so a public format that shows a surname must not reach her.
 * This is held for the request, so every name it formats is clamped in one
 * place (`teamFormats`).
 */
const spoken = new AsyncLocalStorage<boolean>()

/** Runs `read` as a read whose names go to a model. */
export function runSpoken<T>(read: () => T): T {
  return spoken.run(true, read)
}

/**
 * Runs `write` for the public: what a request stores or sends to somebody
 * else, the live board and mail, whoever made the request.
 */
export function outsideSpoken<T>(write: () => T): T {
  return spoken.exit(write)
}

export function isSpoken(): boolean {
  return spoken.getStore() === true
}
