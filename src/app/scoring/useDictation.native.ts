import type { Dictation, UseDictationOptions } from './dictationTypes'

/**
 * Dictation is web-only for now: the phone has no `getUserMedia` or
 * `AudioWorklet`, and a native microphone module is its own piece of work.
 */
export function useDictation(_options: UseDictationOptions): Dictation {
  return {
    enabled: false,
    connected: false,
    holding: false,
    busy: false,
    text: null,
    message: null,
    ask: null,
    setEnabled: () => undefined,
    hold: () => undefined,
    release: () => undefined,
    answer: () => undefined,
    dismiss: () => undefined
  }
}

export function dictationUrl(_apiBaseUrl: string): string {
  return ''
}
