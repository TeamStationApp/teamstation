/**
 * Where the browser's own controls are, so our squares can avoid them.
 *
 * The controls live inside the `<video>` element's shadow DOM: anything we draw
 * is either over the whole element, controls included, or behind the picture
 * where no pointer reaches it. There is no slot in between. So the gesture layer
 * goes above and has holes cut in it, and the holes have to be measured.
 */

export interface Rect {
  x: number
  y: number
  w: number
  h: number
}

export type Engine = 'chrome' | 'webkit' | 'unknown'

/**
 * Chrome 147, macOS. Probed through the debugging protocol, which can read into
 * the shadow root, at 390x219, 640x360, 952x536 and 1280x720 and again in
 * fullscreen: identical every time, in CSS pixels, and nothing scales with the
 * picture.
 *
 * Everything between the two button groups is a spacer — 1022px of it at 1280
 * wide and 132px even on a phone — which is where the bottom middle square
 * lives.
 */
function chromeRects(w: number, h: number): Rect[] {
  return [
    { x: 0, y: h - 72, w: 114, h: 48 }, // play, and the two clocks
    { x: w - 144, y: h - 72, w: 144, h: 48 }, // mute, fullscreen, overflow
    { x: 0, y: h - 24, w, h: 24 } // the scrubber
  ]
}

/**
 * Safari on the iPhone, iOS 26, portrait. Photographed rather than probed —
 * WebKit has no equivalent of Chrome's shadow-DOM call — at 360x203 and
 * 390x219, and the two agree: fixed sizes at fixed insets, with only the middle
 * cluster following the centre. The drawn glyphs are 14px inside an 8px inset;
 * 44 is Apple's touch target, and the target is what has to be cut out.
 *
 * The overlap costs nothing: every one of these does what our square would have
 * done — play/pause in the middle, ten seconds either side. Safari's own skip
 * buttons are ten seconds, which is a quiet confirmation of the number.
 */
function webkitRects(w: number, h: number): Rect[] {
  const T = 44
  const cx = w / 2
  const cy = h / 2
  return [
    { x: 0, y: 0, w: T, h: T }, // fullscreen
    { x: w - T, y: 0, w: T, h: T }, // speaker
    { x: cx - 78 - T / 2, y: cy - T / 2, w: T, h: T }, // back ten
    { x: cx - T / 2, y: cy - T / 2, w: T, h: T }, // play / pause
    { x: cx + 78 - T / 2, y: cy - T / 2, w: T, h: T }, // forward ten
    { x: 0, y: h - 40, w, h: 40 }, // the times and the scrubber
    { x: w - T, y: h - T, w: T, h: T } // the menu, where picture-in-picture is
  ]
}

/**
 * An engine nobody has measured gets no holes: it gives up the whole bar band
 * instead. That costs a little area and can never put a square on a control,
 * which is the way round to be wrong.
 */
function unknownRects(w: number, h: number): Rect[] {
  return [{ x: 0, y: h - 72, w, h: 72 }]
}

export function engineOf(userAgent: string): Engine {
  if (/Chrom(e|ium)|Edg\//.test(userAgent)) return 'chrome'
  if (userAgent.includes('Safari') && !/Chrom(e|ium)/.test(userAgent)) {
    return 'webkit'
  }
  return 'unknown'
}

export function controlRects(w: number, h: number, engine: Engine): Rect[] {
  if (engine === 'chrome') return chromeRects(w, h)
  if (engine === 'webkit') return webkitRects(w, h)
  return unknownRects(w, h)
}

/** `a` with `b` cut out of it: at most four pieces, and none of them empty. */
export function subtract(a: Rect, b: Rect): Rect[] {
  const left = Math.max(a.x, b.x)
  const right = Math.min(a.x + a.w, b.x + b.w)
  const top = Math.max(a.y, b.y)
  const bottom = Math.min(a.y + a.h, b.y + b.h)
  if (left >= right || top >= bottom) return [a]

  const out: Rect[] = []
  if (top > a.y) out.push({ x: a.x, y: a.y, w: a.w, h: top - a.y })
  if (bottom < a.y + a.h) {
    out.push({ x: a.x, y: bottom, w: a.w, h: a.y + a.h - bottom })
  }
  if (left > a.x) out.push({ x: a.x, y: top, w: left - a.x, h: bottom - top })
  if (right < a.x + a.w) {
    out.push({ x: right, y: top, w: a.x + a.w - right, h: bottom - top })
  }
  return out.filter(piece => piece.w > 1 && piece.h > 1)
}

/**
 * The picture, minus every rectangle the browser owns.
 *
 * The zone a press lands in is always worked out against the whole picture, so
 * the grid stays even thirds no matter which of these pieces caught it.
 */
export function liveRects(w: number, h: number, engine: Engine): Rect[] {
  let pieces: Rect[] = [{ x: 0, y: 0, w, h }]
  for (const taken of controlRects(w, h, engine)) {
    pieces = pieces.flatMap(piece => subtract(piece, taken))
  }
  return pieces
}
