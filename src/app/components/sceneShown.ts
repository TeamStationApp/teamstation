import { createContext, useContext } from 'react'

const SceneShownContext = createContext(true)

/** Given by the stack navigator's scene slot, per scene. */
export const SceneShownProvider = SceneShownContext.Provider

/**
 * Whether this screen is the one on show in the stack: false for a screen
 * kept covered beneath the top, or sliding out. A screen that plays or polls
 * stands down while it is not (a covered game's video would go on being
 * heard under the screen pushed over it), and picks up as it was when it is
 * shown again.
 */
export function useSceneShown(): boolean {
  return useContext(SceneShownContext)
}
