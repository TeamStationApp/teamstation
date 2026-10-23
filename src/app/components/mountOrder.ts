import { useLayoutEffect, useRef } from 'react'

/**
 * How long a move turned back mid-way stands still before it goes back: the
 * moving parts take their new roles in a commit that reaches the screen a
 * frame or two later, and until then they still move by the old move. The
 * stack navigator's scenes and a pill group's pages alike.
 */
export const REVERSE_HOLD_MS = 48

/**
 * Sorts `items` into the order their keys were first mounted, the order
 * their nodes were put in. A role change (a push turned back, a pill
 * reversed mid-slide) must not move a node: a moved scroller loses its
 * place, and a moved `<video>` or `<iframe>` starts over. Stacking comes from
 * `zIndex`, not from the order. A key no longer drawn is forgotten after the
 * commit, and `onForget` hears it.
 */
export function useMountOrder<T>(
  items: T[],
  keyOf: (item: T) => string,
  onForget?: (key: string) => void
): T[] {
  const order = useRef(new Map<string, number>())
  let next = 0
  for (const value of order.current.values()) next = Math.max(next, value + 1)
  const keys = items.map(keyOf)
  for (const key of keys)
    if (!order.current.has(key)) order.current.set(key, next++)
  useLayoutEffect(() => {
    for (const key of [...order.current.keys()])
      if (!keys.includes(key)) {
        order.current.delete(key)
        onForget?.(key)
      }
  })
  return [...items].sort(
    (a, b) =>
      (order.current.get(keyOf(a)) ?? 0) - (order.current.get(keyOf(b)) ?? 0)
  )
}
