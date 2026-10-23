import { createContext, useContext, useState } from 'react'

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

/**
 * How many times this screen has come back from under another: 0 until then.
 * A screen stays mounted beneath the one pushed over it, so a load that ought
 * to see what that screen changed depends on this, as it would have run again
 * on a fresh mount.
 */
export function useSceneReveals(): number {
  const shown = useSceneShown()
  const [held, setHeld] = useState({ shown, reveals: 0 })
  if (held.shown === shown) return held.reveals
  const reveals = held.reveals + (shown ? 1 : 0)
  setHeld({ shown, reveals })
  return reveals
}
