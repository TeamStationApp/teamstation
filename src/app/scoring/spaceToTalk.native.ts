import type { RefObject } from 'react'

import type { SpaceToTalkOptions, TalkKeys } from './dictationTypes'

/**
 * A phone has no keyboard Space to bind. The hook stays so the scoring screen
 * calls the same thing on both platforms.
 */
export function useSpaceToTalk(
  _active: boolean,
  _talks: boolean,
  _keys: RefObject<TalkKeys>,
  _options?: SpaceToTalkOptions
): void {}
