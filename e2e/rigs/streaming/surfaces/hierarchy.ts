import type { Rect } from './regions'
import { LABELS, TILE_NOTICE } from './surface'

/**
 * Reads maestro-d's normalized hierarchy (`type`, `id`, `text`, `bounds`, `children`,
 * the same on every platform) for what a probe needs: each angle's tile and its notice,
 * the bar and where it is, and the screen's size in the hierarchy's units.
 */

export interface HierarchyNode {
  type?: string
  id?: string
  text?: string
  bounds?: Rect
  children?: HierarchyNode[]
}

export interface TileNode {
  angle: string
  bounds: Rect
  notice: string | null
}

export interface ScreenRead {
  screen: Rect | null
  tiles: TileNode[]
  bar: { bounds: Rect; fraction: number | null } | null
  texts: string[]
}

function* walk(node: HierarchyNode | undefined): Generator<HierarchyNode> {
  if (node == null) return
  yield node
  for (const child of node.children ?? []) yield* walk(child)
}

function labelOf(node: HierarchyNode): string {
  return node.text ?? node.id ?? ''
}

function inside(inner: Rect, outer: Rect): boolean {
  const cx = inner.x + inner.width / 2
  const cy = inner.y + inner.height / 2
  return (
    cx >= outer.x &&
    cx <= outer.x + outer.width &&
    cy >= outer.y &&
    cy <= outer.y + outer.height
  )
}

/** A percentage or a fraction after the bar's label, where the platform gives one. */
export function barFraction(text: string): number | null {
  const percent = /(\d+(?:\.\d+)?)\s*%/.exec(text)
  if (percent != null) return Math.min(1, Number(percent[1]) / 100)
  const ratio = /(\d+(?:\.\d+)?)\s*(?:of|\/)\s*(\d+(?:\.\d+)?)/.exec(text)
  if (ratio != null && Number(ratio[2]) > 0)
    return Math.min(1, Number(ratio[1]) / Number(ratio[2]))
  return null
}

export function readScreen(root: HierarchyNode | undefined): ScreenRead {
  const nodes = [...walk(root)]
  let screen: Rect | null = null
  for (const node of nodes) {
    const b = node.bounds
    if (
      b != null &&
      (screen == null || b.width * b.height > screen.width * screen.height)
    )
      screen = b
  }
  const tiles: TileNode[] = []
  for (const node of nodes) {
    const label = labelOf(node)
    if (node.bounds == null || !label.endsWith(LABELS.tileSuffix)) continue
    const angle = label.slice(0, -LABELS.tileSuffix.length).trim()
    if (angle === '' || tiles.some(tile => tile.angle === angle)) continue
    tiles.push({ angle, bounds: node.bounds, notice: null })
  }
  for (const node of nodes) {
    const label = labelOf(node)
    if (node.bounds == null || !TILE_NOTICE.test(label)) continue
    const tile = tiles.find(t => inside(node.bounds!, t.bounds))
    if (tile != null && tile.notice == null) tile.notice = label
  }
  const barNode = nodes.find(
    node => node.bounds != null && labelOf(node).startsWith(LABELS.bar)
  )
  return {
    screen,
    tiles,
    bar:
      barNode == null
        ? null
        : { bounds: barNode.bounds!, fraction: barFraction(labelOf(barNode)) },
    texts: nodes.map(labelOf).filter(text => text !== '')
  }
}

/** The element with this label, or this label and a value after a comma. */
export function findBounds(
  root: HierarchyNode | undefined,
  label: string
): Rect | null {
  for (const node of walk(root)) {
    const text = labelOf(node)
    if (node.bounds != null && (text === label || text.startsWith(`${label},`)))
      return node.bounds
  }
  return null
}

export function centre(rect: Rect): { x: number; y: number } {
  return {
    x: Math.round(rect.x + rect.width / 2),
    y: Math.round(rect.y + rect.height / 2)
  }
}
