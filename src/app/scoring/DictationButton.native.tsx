import type React from 'react'

import type { DictationButtonProps } from './dictationTypes'

/** Dictation is web-only for now; the phone shows no control and no log. */
export function useDictationControls(_props: DictationButtonProps): {
  control: React.ReactElement | null
  log: React.ReactElement | null
} {
  return { control: null, log: null }
}
