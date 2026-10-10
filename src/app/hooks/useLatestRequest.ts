import { useCallback, useEffect, useRef } from 'react'

/** A slower old response cannot restore data after a newer refresh or access refusal. */
export function useLatestRequest(): () => () => boolean {
  const generation = useRef(0)
  const alive = useRef(true)
  useEffect(() => {
    const requests = generation
    alive.current = true
    return () => {
      alive.current = false
      requests.current++
    }
  }, [])
  return useCallback(() => {
    const request = ++generation.current
    return () => alive.current && generation.current === request
  }, [])
}
