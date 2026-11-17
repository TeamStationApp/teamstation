// The launch splash's maths, shared by the asset generator and its tests:
// the timeline's checks, the CSS cubic-bezier, keyframe sampling, the
// cover-fit geometry, the frame-0 crop and the sources' hash. The Swift and
// Kotlin renderers implement the same rules; their tests compare against the
// browser samples this module's tests also check.
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { join, relative } from 'node:path'

/** The files every generated output is made from, relative to the repository. */
export const SOURCE_FILES = [
  'mobile/icons/splash/stadium.jpg',
  'mobile/icons/splash/splash.html',
  'mobile/icons/splash/timeline.json',
  'mobile/icons/splash/fonts/PlusJakartaSans-ExtraBold.ttf',
  'scripts/splash/splashMath.mjs',
  'scripts/splash/buildSplashAssets.mjs'
]

/** SOURCE_FILES under `root`. */
export function sourceFiles(root) {
  return SOURCE_FILES.map(file => join(root, file))
}

/** The layers whose tracks animate, and the tracks each must have. */
export const ANIMATED = {
  stadium: ['scale', 'opacity', 'brightness', 'contrast', 'blur'],
  dark: ['opacity'],
  glow: ['opacity', 'scale'],
  mark: ['opacity', 'scale', 'blur'],
  wordmark: ['opacity', 'translateY', 'scale']
}

/**
 * Tracks drawn as one CSS property, which therefore need the same offsets:
 * a keyframe either sets the whole `filter` or none of it.
 */
export const SHARED_OFFSETS = [
  ['stadium', ['brightness', 'contrast', 'blur']],
  ['wordmark', ['translateY', 'scale']]
]

/**
 * Throws, naming the first problem, unless `timeline` is well formed: every
 * curve has four numbers, every track starts at 0, ends at 1 and ascends, and
 * the tracks drawn as one CSS property share their offsets.
 */
export function checkTimeline(timeline) {
  if (!(timeline.durationMs > 0)) throw new Error('durationMs must be positive')
  for (const [name, tracks] of Object.entries(ANIMATED)) {
    const layer = timeline.layers?.[name]
    if (layer == null) throw new Error(`${name}: missing layer`)
    const easing = layer.easing
    if (
      !Array.isArray(easing) ||
      easing.length !== 4 ||
      !easing.every(Number.isFinite)
    )
      throw new Error(`${name}: easing needs four numbers`)
    for (const track of tracks) {
      const keys = layer.tracks?.[track]
      if (!Array.isArray(keys) || keys.length < 2)
        throw new Error(`${name}.${track}: needs two keyframes`)
      const offsets = keys.map(([at]) => at)
      if (offsets[0] !== 0 || offsets.at(-1) !== 1)
        throw new Error(`${name}.${track}: keyframes must run from 0 to 1`)
      for (let i = 1; i < offsets.length; i++)
        if (!(offsets[i] > offsets[i - 1]))
          throw new Error(`${name}.${track}: keyframe times must ascend`)
    }
  }
  for (const [name, tracks] of SHARED_OFFSETS) {
    const first = JSON.stringify(
      timeline.layers[name].tracks[tracks[0]].map(([at]) => at)
    )
    for (const track of tracks.slice(1))
      if (
        JSON.stringify(
          timeline.layers[name].tracks[track].map(([at]) => at)
        ) !== first
      )
        throw new Error(
          `${name}: ${tracks.join(', ')} must share keyframe times`
        )
  }
  return timeline
}

/**
 * CSS's `cubic-bezier(x1, y1, x2, y2)` as a function of progress, solved for
 * x by Newton's method with a bisection fallback, as browsers do.
 */
export function cubicBezier(x1, y1, x2, y2) {
  const cx = 3 * x1
  const bx = 3 * (x2 - x1) - cx
  const ax = 1 - cx - bx
  const cy = 3 * y1
  const by = 3 * (y2 - y1) - cy
  const ay = 1 - cy - by
  const x = t => ((ax * t + bx) * t + cx) * t
  const y = t => ((ay * t + by) * t + cy) * t
  const dx = t => (3 * ax * t + 2 * bx) * t + cx
  return progress => {
    if (progress <= 0) return 0
    if (progress >= 1) return 1
    let t = progress
    for (let i = 0; i < 8; i++) {
      const error = x(t) - progress
      if (Math.abs(error) < 1e-7) return y(t)
      const slope = dx(t)
      if (Math.abs(slope) < 1e-6) break
      t -= error / slope
    }
    let lo = 0
    let hi = 1
    t = progress
    while (hi - lo > 1e-7) {
      if (x(t) < progress) lo = t
      else hi = t
      t = (lo + hi) / 2
    }
    return y(t)
  }
}

/**
 * A track's value at `progress` (0–1 of the run): the curve applies to each
 * segment between two keyframes, as CSS applies `animation-timing-function`.
 */
export function sampleTrack(keys, easing, progress) {
  if (progress <= keys[0][0]) return keys[0][1]
  const last = keys.at(-1)
  if (progress >= last[0]) return last[1]
  const ease = cubicBezier(...easing)
  for (let i = 1; i < keys.length; i++) {
    const [to, end] = keys[i]
    if (progress <= to) {
      const [from, start] = keys[i - 1]
      return start + (end - start) * ease((progress - from) / (to - from))
    }
  }
  return last[1]
}

/** Every animated track of `timeline` at `ms` milliseconds, by layer. */
export function sampleAll(timeline, ms) {
  const progress = Math.min(1, Math.max(0, ms / timeline.durationMs))
  const out = {}
  for (const [name, tracks] of Object.entries(ANIMATED)) {
    const layer = timeline.layers[name]
    out[name] = Object.fromEntries(
      tracks.map(track => [
        track,
        sampleTrack(layer.tracks[track], layer.easing, progress)
      ])
    )
  }
  return out
}

/** The mark's side and the brand block's scale `k` for a `w`×`h` window. */
export function brandSize(timeline, w, h) {
  const { width, height, side } = timeline.design
  const markSide = Math.min((side * w) / width, (side * h) / height)
  return { side: markSide, k: markSide / side }
}

/**
 * Where the stadium image lies at scale 1 in a `w`×`h` window: cover-fit to
 * the window plus the bleed, positioned at the focus. `visible` is the
 * fraction of the image's width and height the window shows.
 */
export function coverRect(timeline, w, h) {
  const { k } = brandSize(timeline, w, h)
  const { width: iw, height: ih, bleed, focus } = timeline.stadium
  const pad = bleed * k
  const ew = w + 2 * pad
  const eh = h + 2 * pad
  const scale = Math.max(ew / iw, eh / ih)
  const rw = iw * scale
  const rh = ih * scale
  return {
    x: -pad + (ew - rw) * focus[0],
    y: -pad + (eh - rh) * focus[1],
    width: rw,
    height: rh,
    element: { x: -pad, y: -pad, width: ew, height: eh },
    visible: { width: Math.min(1, w / rw), height: Math.min(1, h / rh) }
  }
}

/**
 * The part of the image the stadium element shows at t = 0, in image pixels.
 * The zoom keeps the focus fixed, so on each axis the view runs from
 * f − f/s to f + (1 − f)/s of the image.
 */
export function frameZeroCrop(
  timeline,
  imageWidth = timeline.stadium.width,
  imageHeight = timeline.stadium.height
) {
  const s = timeline.layers.stadium.tracks.scale[0][1]
  const [fx, fy] = timeline.stadium.focus
  const span = (f, size) => [
    Math.round((f - f / s) * size),
    Math.round((f + (1 - f) / s) * size)
  ]
  const [x0, x1] = span(fx, imageWidth)
  const [y0, y1] = span(fy, imageHeight)
  return {
    x: x0,
    y: y0,
    width: x1 - x0,
    height: y1 - y0,
    centre: [(x0 + x1) / 2, (y0 + y1) / 2]
  }
}

/**
 * One SHA-256 over the sources, each named by its path under `root`, so a
 * generated file can say which sources it was made from.
 */
export function sourcesHash(root, files) {
  const lines = [...files]
    .map(file => {
      const digest = createHash('sha256')
        .update(readFileSync(file))
        .digest('hex')
      return `${relative(root, file)}\0${digest}`
    })
    .sort()
  return createHash('sha256').update(lines.join('\n')).digest('hex')
}

/** The hash a generated text file records in its first lines, or null. */
export function recordedHash(text) {
  return /sources sha256 ([0-9a-f]{64})/.exec(text)?.[1] ?? null
}
