import { useEffect, useState } from 'react'

/**
 * `value` once it has held still for `delay` milliseconds. The first value
 * is returned at once; each change after that restarts the wait.
 */
export function useDebouncedValue<T>(value: T, delay: number): T {
  const [settled, setSettled] = useState(value)
  useEffect(() => {
    const timer = setTimeout(() => {
      setSettled(value)
    }, delay)
    return () => {
      clearTimeout(timer)
    }
  }, [value, delay])
  return settled
}
