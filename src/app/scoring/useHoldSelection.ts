import { useCallback, useEffect, useRef } from 'react'

/** Keep Safari's native selection/menu lifecycle out of the held Undo gesture. */
export function useHoldSelection(): {
  onPressIn: () => void
  onPressOut: () => void
  onLongPress: () => void
} {
  const held = useRef(false)
  const completed = useRef(false)
  const releaseFrame = useRef<number | null>(null)
  const editing = useCallback((): boolean => {
    const active = document.activeElement as HTMLElement | null
    return (
      active?.tagName === 'INPUT' ||
      active?.tagName === 'TEXTAREA' ||
      active?.isContentEditable === true
    )
  }, [])
  const clearGestureSelection = useCallback((): void => {
    if (!editing()) document.getSelection()?.removeAllRanges()
  }, [editing])
  useEffect(() => {
    const selection = (event: Event): void => {
      if (editing()) return
      if (
        held.current ||
        (completed.current && document.getSelection()?.isCollapsed === false)
      ) {
        event.stopImmediatePropagation()
        if (completed.current) clearGestureSelection()
      }
    }
    const menu = (event: Event): void => {
      if (held.current && !editing()) {
        event.preventDefault()
        event.stopImmediatePropagation()
        clearGestureSelection()
      }
    }
    document.addEventListener('selectionchange', selection, true)
    document.addEventListener('select', selection, true)
    document.addEventListener('contextmenu', menu, true)
    return () => {
      held.current = false
      completed.current = false
      if (releaseFrame.current != null)
        window.cancelAnimationFrame(releaseFrame.current)
      document.removeEventListener('selectionchange', selection, true)
      document.removeEventListener('select', selection, true)
      document.removeEventListener('contextmenu', menu, true)
    }
  }, [clearGestureSelection, editing])
  return {
    onPressIn: useCallback(() => {
      if (releaseFrame.current != null)
        window.cancelAnimationFrame(releaseFrame.current)
      releaseFrame.current = null
      held.current = true
      completed.current = false
      clearGestureSelection()
    }, [clearGestureSelection]),
    onLongPress: useCallback(() => {
      completed.current = true
      clearGestureSelection()
    }, [clearGestureSelection]),
    onPressOut: useCallback(() => {
      held.current = false
      if (completed.current) {
        clearGestureSelection()
        // Safari recreates a held word's selection just after touch release.
        releaseFrame.current = window.requestAnimationFrame(() => {
          clearGestureSelection()
          completed.current = false
          releaseFrame.current = null
        })
      }
    }, [clearGestureSelection])
  }
}
