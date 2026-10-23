import { useCallback, useRef } from 'react'

/**
 * The latest `handler`, under one identity for as long as the component is
 * mounted: what it is handed to (game cards kept built across pill changes)
 * is not drawn again for a new one.
 */
export function useStableCallback<Args extends unknown[], Result>(
  handler: (...args: Args) => Result
): (...args: Args) => Result {
  const latest = useRef(handler)
  latest.current = handler
  return useCallback((...args: Args) => latest.current(...args), [])
}
