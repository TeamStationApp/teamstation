import { type RefObject, useEffect, useRef, useState } from 'react'

import {
  dragOutcome,
  NAV_TABS,
  type NavTabId,
  slotAt,
  type TabBounds
} from './tabBarModel'

interface CapsuleDrag {
  dragged: number | null
  press: (id: NavTabId) => void
  gesture: {
    onTouchesDown: () => void
    onActivate: (event: { x: number }) => void
    onUpdate: (event: { x: number }) => void
    onDeactivate: (event: { x: number; y: number; canceled: boolean }) => void
    onFinalize: () => void
  }
}

/**
 * A drag previews slots. Only its release can request a committed selection,
 * and a release back over the tab selected when it began springs back: a
 * request for the current tab pops its stack to the root.
 */
export function useCapsuleDrag(
  bounds: RefObject<TabBounds>,
  selectedIndex: number,
  onSelect: (id: NavTabId) => void,
  onSlotChange: () => void
): CapsuleDrag {
  const [dragged, setDragged] = useState<number | null>(null)
  const dragSlot = useRef(-1)
  const startIndex = useRef(-1)
  const suppressPress = useRef(false)
  const frame = useRef<number | null>(null)
  const cancelFrame = (): void => {
    if (frame.current != null) {
      cancelAnimationFrame(frame.current)
      frame.current = null
    }
  }
  useEffect(() => cancelFrame, [])
  return {
    dragged,
    press(id: NavTabId) {
      if (!suppressPress.current) onSelect(id)
    },
    gesture: {
      onTouchesDown() {
        cancelFrame()
        suppressPress.current = false
      },
      onActivate(event: { x: number }) {
        suppressPress.current = true
        startIndex.current = selectedIndex
        dragSlot.current = slotAt(
          event.x,
          bounds.current.width,
          NAV_TABS.length,
          bounds.current.rtl
        )
        setDragged(dragSlot.current)
      },
      onUpdate(event: { x: number }) {
        const slot = slotAt(
          event.x,
          bounds.current.width,
          NAV_TABS.length,
          bounds.current.rtl
        )
        if (slot < 0 || slot === dragSlot.current) return
        dragSlot.current = slot
        setDragged(slot)
        onSlotChange()
      },
      onDeactivate(event: { x: number; y: number; canceled: boolean }) {
        const slot = dragOutcome(event.x, event.y, bounds.current)
        if (!event.canceled && slot != null && slot !== startIndex.current)
          onSelect(NAV_TABS[slot].id)
      },
      onFinalize() {
        if (suppressPress.current) {
          cancelFrame()
          frame.current = requestAnimationFrame(() => {
            suppressPress.current = false
            frame.current = null
          })
        }
        setDragged(null)
      }
    }
  }
}
