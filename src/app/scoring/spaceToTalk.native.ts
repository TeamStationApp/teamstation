import type { RefObject } from 'react'

/**
 * A phone has no keyboard Space to bind. The hook stays so the scoring screen
 * calls the same thing on both platforms.
 */
export function useSpaceToTalk(
  _active: boolean,
  _talks: boolean,
  _keys: RefObject<{ hold: () => void; release: () => void }>
): void {}
