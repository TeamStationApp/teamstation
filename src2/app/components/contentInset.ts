import { createContext, useContext } from 'react'

/**
 * How far in from its container the content column starts, each side.
 *
 * A pill strip scrolls sideways, and drawn inside the padded column it was
 * cut off at the margin: a pill swiped left vanished a finger's width from
 * the edge of the screen. A strip reads this to cancel the column's padding,
 * so it runs to the screen's edges while its first pill still starts where
 * everything else on the page does. Whatever pads a column provides it.
 */
export interface ContentInset {
  left: number
  right: number
}

export const NO_INSET: ContentInset = { left: 0, right: 0 }

export const ContentInsetContext = createContext<ContentInset>(NO_INSET)

export function useContentInset(): ContentInset {
  return useContext(ContentInsetContext)
}
