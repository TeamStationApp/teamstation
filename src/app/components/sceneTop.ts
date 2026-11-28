import { createContext, useContext } from 'react'

const SceneTopContext = createContext(true)

/** Given by the stack navigator's scene slot, per scene. */
export const SceneTopProvider = SceneTopContext.Provider

/**
 * Whether this screen is the stack's top: false for a scene drawn beneath a
 * drag back, covered, retained under a child or on its way out, all of which
 * stay mounted. Only the top may hand the header anything — a pinned band
 * beneath a pushed screen must not leave that screen's header bare.
 *
 * True outside a stack, where the screen is the only one there is.
 */
export function useSceneTop(): boolean {
  return useContext(SceneTopContext)
}
