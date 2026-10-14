import type { ChatBounds } from './chatInteractionModel'

const clamp = (value: number, low: number, high: number): number =>
  Math.max(low, Math.min(value, Math.max(low, high)))

/** All coordinates are local to the same-window overlay, including keyboards. */
export function spotlightLayout(options: {
  frame: ChatBounds
  safe: { top: number; right: number; bottom: number; left: number }
  keyboardTop?: number
  source?: ChatBounds
  preview: number
  panel: number
  reactions: number
  gap: number
  maxWidth: number
  mine: boolean
  minimumPanel?: number
}): {
  left: number
  top: number
  width: number
  preview: number
  panel: number
  reactions: number
  previewTop: number
  panelTop: number
  sourceX: number
  sourceY: number
  compact: boolean
  animateSource: boolean
} {
  const { frame, safe, gap } = options
  const horizontal = Math.max(0, frame.width - safe.left - safe.right)
  const horizontalGap = Math.min(gap, horizontal / 4)
  const leftEdge = clamp(safe.left, 0, frame.width) + horizontalGap
  const rightEdge = Math.max(leftEdge, frame.width - safe.right - horizontalGap)
  const rawTop = clamp(safe.top, 0, frame.height)
  const rawBottom = clamp(
    Math.min(
      frame.height - safe.bottom,
      (options.keyboardTop ?? Infinity) - frame.y
    ),
    rawTop,
    frame.height
  )
  const available = rawBottom - rawTop
  const minimumPanel = options.minimumPanel ?? 44
  const minimumPreview = Math.min(options.preview, minimumPanel / 2)
  const reactionGap = options.reactions > 0 ? gap : 0
  const previewGap = options.preview > 0 ? gap : 0
  const compact =
    available - gap * 2 <
    minimumPanel + minimumPreview + options.reactions + reactionGap + previewGap
  // A short band belongs entirely to one scrollable actions/reactions panel.
  const topEdge = rawTop + (compact ? 0 : gap)
  const bottomEdge = rawBottom - (compact ? 0 : gap)
  const height = bottomEdge - topEdge
  const width = Math.max(0, Math.min(options.maxWidth, rightEdge - leftEdge))
  const reactions = compact ? 0 : options.reactions
  const panel = compact
    ? height
    : Math.min(
        Math.max(minimumPanel, Math.min(options.panel, height * 0.55)),
        height - reactions - reactionGap - minimumPreview - previewGap
      )
  const preview = compact
    ? 0
    : Math.min(
        options.preview,
        height - panel - reactions - reactionGap - previewGap
      )
  const previewTop = compact ? 0 : reactions + reactionGap
  const panelTop = compact ? 0 : previewTop + preview + previewGap
  const total = panelTop + panel
  const source = options.source
  // A clipped bubble's beginning is not the content visible at the hold point.
  // Fade at the bounded destination rather than inventing a distant lift origin.
  const animateSource =
    source != null &&
    !compact &&
    source.x >= frame.x + safe.left &&
    source.x + source.width <= frame.x + frame.width - safe.right &&
    source.y >= frame.y + rawTop &&
    source.y + source.height <= frame.y + rawBottom
  const left = clamp(
    source == null
      ? (frame.width - width) / 2
      : source.x -
          frame.x -
          (options.mine ? width - Math.min(source.width, width) : 0),
    leftEdge,
    rightEdge - width
  )
  const top = clamp(
    source == null
      ? (topEdge + bottomEdge - total) / 2
      : source.y - frame.y - previewTop,
    topEdge,
    bottomEdge - total
  )
  return {
    left,
    top,
    width,
    preview,
    panel,
    reactions,
    previewTop,
    panelTop,
    compact,
    animateSource,
    sourceX: !animateSource
      ? 0
      : source.x -
        frame.x -
        left -
        (options.mine ? width - Math.min(source.width, width) : 0),
    sourceY: !animateSource ? 0 : source.y - frame.y - top - previewTop
  }
}
