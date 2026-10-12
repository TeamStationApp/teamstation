/** A rectangle in screen points, as a maestro-d hierarchy reports it. */
export interface ScreenBounds {
  x: number
  y: number
  width: number
  height: number
}

interface Tree {
  bounds?: ScreenBounds
  children?: Tree[]
}

const hasSize = (bounds: ScreenBounds | undefined): bounds is ScreenBounds =>
  bounds != null && bounds.width > 0 && bounds.height > 0

/**
 * The screen's size from a hierarchy: its root's bounds on iOS, and on Android,
 * whose root carries none, the largest element's. A fixed fallback pinched the
 * Pixel's top-left corner, where the gear is, so the e2e pinch never zoomed.
 */
export function screenOf(tree: Tree): ScreenBounds {
  if (hasSize(tree.bounds)) return tree.bounds
  let best: ScreenBounds | undefined
  const visit = (node: Tree): void => {
    if (
      hasSize(node.bounds) &&
      (best == null ||
        node.bounds.width * node.bounds.height > best.width * best.height)
    ) {
      best = node.bounds
    }
    for (const child of node.children ?? []) visit(child)
  }
  visit(tree)
  if (best == null) throw new Error('The hierarchy has no element with a size')
  return best
}
