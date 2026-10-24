import { useLayoutEffect, useRef } from 'react'

import { currentRoute, setNavigationGuard } from '../navigation/useAddressBar'

/**
 * While Tess's chat covers the app, the browser's Back closes it and goes
 * nowhere: the guard puts the address back, and its check closes the chat
 * and declines the move, so the route and the history stay as they were.
 * Removed as soon as the chat closes, so Back is the page's again.
 */
export function useTessBack(active: boolean, close: () => void): void {
  const closing = useRef(close)
  closing.current = close
  useLayoutEffect(
    () =>
      active
        ? setNavigationGuard(async () => {
            closing.current()
            return false
          }, currentRoute())
        : undefined,
    [active]
  )
}
