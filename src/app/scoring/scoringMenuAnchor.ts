import { type RefObject, useLayoutEffect, useState } from 'react'

/** The space between a web scoring menu and the deck under it. */
export const MENU_GAP = 8
/**
 * Where a web scoring menu opens, in viewport pixels: its bottom `bottom`
 * above the window's bottom edge, which puts it MENU_GAP above the deck's
 * top, as the native menus are; the deck's left and right edges, which are
 * inside the field column, so no menu reaches a side column; and the
 * trigger button's edges.
 */
export interface MenuAnchor {
  bottom: number
  deckLeft: number
  deckRight: number
  triggerLeft: number
  triggerRight: number
}

export function menuAnchor(
  trigger: HTMLElement | null
): MenuAnchor | undefined {
  const deck = trigger?.closest('[data-testid="scoring-deck"]')
  if (trigger == null || deck == null) return undefined
  const rect = deck.getBoundingClientRect()
  const button = trigger.getBoundingClientRect()
  return {
    bottom: window.innerHeight - rect.top + MENU_GAP,
    deckLeft: rect.left,
    deckRight: rect.right,
    triggerLeft: button.left,
    triggerRight: button.right
  }
}

/**
 * Measures the deck under `trigger` while `open`, again on each resize;
 * undefined while closed or outside a deck, where a menu keeps its fixed
 * placement.
 */
export function useMenuAnchor(
  open: boolean,
  trigger: RefObject<HTMLElement | null>
): MenuAnchor | undefined {
  const [anchor, setAnchor] = useState<MenuAnchor>()
  useLayoutEffect(() => {
    if (!open) {
      setAnchor(undefined)
      return
    }
    const measure = (): void => {
      setAnchor(menuAnchor(trigger.current))
    }
    measure()
    window.addEventListener('resize', measure)
    return () => {
      window.removeEventListener('resize', measure)
    }
  }, [open, trigger])
  return anchor
}
