/**
 * Where the player's own controls are, so our squares can avoid them.
 *
 * The same problem in three vocabularies. In a browser the controls live inside
 * the `<video>` element's shadow DOM; on a phone they belong to AVPlayer or to
 * ExoPlayer. Either way there is no slot between them and the picture: anything
 * we draw is over the whole thing, controls included, or behind it where no
 * finger reaches. So the gesture layer goes above and has holes cut in it, and
 * the holes have to be measured.
 *
 * The web rectangles were: Chrome's probed through the debugging protocol,
 * WebKit's photographed. The two native sets are **estimated** from Apple's
 * and Material's touch targets and have not been checked against a device —
 * so a tap landing on a control that is not where this says it is remains the
 * likeliest thing here to be wrong.
 *
 * That has already happened once. ExoPlayer's rewind, forward, previous and
 * next buttons sat on top of this app's own ten-second squares and the
 * estimate put them in the wrong place, so taps meant for the app reached the
 * player. The first fix was to turn those buttons off, which does not work —
 * see `exoPlayerRects` — so they are measured instead.
 *
 * **These holes are only cut while the controls are actually on screen.**
 * `PlayerSurface` takes the whole picture back the moment the bar fades,
 * which is most of the time; a hole cut for a bar that is not being drawn is
 * just a dead patch of picture, and on Android it covered the square that
 * runs the film backwards.
 */

export interface Rect {
  x: number
  y: number
  w: number
  h: number
}

export type Engine = 'chrome' | 'webkit' | 'avplayer' | 'exoplayer' | 'unknown'

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
 * AVPlayer's inline controls, iOS 26.
 *
 * The same bar Safari draws, because Safari's controls *are* AVPlayer's — the
 * numbers below are `webkitRects`' own, which were photographed on an iPhone,
 * with the fullscreen and speaker buttons moved: in the native player they sit
 * at the **top right** together rather than at either corner, and the route
 * button joins them.
 */
function avPlayerRects(w: number, h: number): Rect[] {
  const T = 44
  const cx = w / 2
  const cy = h / 2
  return [
    { x: w - T * 3, y: 0, w: T * 3, h: T }, // route, speaker, fullscreen
    { x: cx - 78 - T / 2, y: cy - T / 2, w: T, h: T }, // back ten
    { x: cx - T / 2, y: cy - T / 2, w: T, h: T }, // play / pause
    { x: cx + 78 - T / 2, y: cy - T / 2, w: T, h: T }, // forward ten
    // 60, not the 40 this was first estimated at. A quarter-speed hold in
    // the bottom-middle square does nothing at 56 points above the picture's
    // lower edge and works at 95, so AVPlayer's real chrome reaches higher
    // than the scrubber it was measured from. Measured on an iPad rather than
    // taken from Apple's metrics, which is what the first number was.
    { x: 0, y: h - 60, w, h: 60 } // the times and the scrubber
  ]
}

/**
 * ExoPlayer's default controls.
 *
 * One band across the bottom holding the clocks and the scrubber, and three
 * buttons across the middle. Material's touch target is 48dp rather than
 * Apple's 44, and the middle cluster is spaced more widely.
 */
/**
 * ExoPlayer's default overlay, measured on a device rather than guessed at.
 *
 * Five buttons across the middle — previous, back five, play, forward
 * fifteen, next — and a bar along the bottom. The first attempt at this cut
 * holes for three of them at ±96, and taps meant for ten seconds reached the
 * player's own skip buttons instead, because the outer two are further out
 * than that and were not covered at all.
 *
 * They could not simply be turned off. `react-native-video` 6.19.3 takes a
 * `controlsStyles` prop with `hidePrevious`, `hideNext`, `hideForward` and
 * `hideRewind` in it, and on Android **parses all four and reads none of
 * them**: `ControlsConfig.parse` fills the object, `refreshControlsStyles`
 * calls `updateControllerVisibility` and nothing else, and the only getter
 * used anywhere in the Android source is `getHideLiveBadge`. The comment
 * above it says the per-button work "may need to be reimplemented". So the
 * buttons stay, and the holes have to fit them.
 *
 * The span comes from where they actually landed on the emulator: the outer
 * two at about 118 and 124 points either side of centre. The control layout
 * is a fixed size, so those offsets do not scale with the picture — which is
 * why this is an absolute span and not a fraction of the width. One band
 * across all five rather than five rectangles, because the gaps between them
 * are smaller than a fingertip and a hole you cannot hit is not a hole.
 */
function exoPlayerRects(w: number, h: number): Rect[] {
  /** Apple's is 44, Material's is 48; the bar is taller than either. */
  const T = 56
  /** Half the cluster: the outer button's centre, plus its own half-width. */
  const SPAN = 124 + T / 2
  const cx = w / 2
  const cy = h / 2
  return [
    {
      x: Math.max(0, cx - SPAN),
      y: cy - T / 2,
      w: Math.min(2 * SPAN, w),
      h: T
    },
    { x: 0, y: h - 56, w, h: 56 } // the clocks, the scrubber, fullscreen
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
  if (engine === 'avplayer') return avPlayerRects(w, h)
  if (engine === 'exoplayer') return exoPlayerRects(w, h)
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
 * The picture, minus every rectangle the player owns.
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

/**
 * How deep the player's own controls run in from the top and the bottom of a
 * picture `height` tall: the lowest edge of anything touching the top, and the
 * highest edge of anything touching the bottom.
 *
 * What is drawn in a corner — the slow-motion words — sits just inside these,
 * so it is never on a button.
 */
export function edgeBars(
  rects: Rect[],
  height: number
): { top: number; bottom: number } {
  const top = Math.max(
    0,
    ...rects.filter(rect => rect.y <= 1).map(rect => rect.y + rect.h)
  )
  const bottom = Math.max(
    0,
    ...rects
      .filter(rect => rect.y + rect.h >= height - 1)
      .map(rect => height - rect.y)
  )
  return { top, bottom }
}
