import type { Rect } from './motion'

/**
 * Where the test pattern draws what the suite reads back, as fractions of the
 * picture. `testPatternGame.ts` draws it and `counter.ts` reads it, so both
 * take the boxes from here.
 *
 * The frame counter sits on a solid black box in the lower middle: clear of
 * the tile's name at the top left, the grid's notices at the top, and the
 * scrub bar along the bottom of the screen.
 */
export const LAYOUT = {
  /** The angle's name, large. */
  label: { x: 0.04, y: 0.06, size: 0.1 },
  /** Seven digits of frame number, white on black. */
  counter: { x: 0.3, y: 0.56, w: 0.4, h: 0.15 },
  /** Media time and wall clock, for people and the webcam. */
  clock: { x: 0.04, y: 0.8, size: 0.05 }
} as const

/** The pattern's frame rate, matched to the Distributor's uploads. */
export const PATTERN_FPS = 60

/** The picture's own aspect ratio. */
export const PATTERN_ASPECT = 16 / 9

/**
 * Where a picture of `aspect` lands inside a tile drawn `object-fit:
 * contain`: centred, as large as fits, letterboxed on the other axis.
 */
export function contentRect(tile: Rect, aspect: number = PATTERN_ASPECT): Rect {
  if (tile.w / tile.h > aspect) {
    const w = tile.h * aspect
    return { x: tile.x + (tile.w - w) / 2, y: tile.y, w, h: tile.h }
  }
  const h = tile.w / aspect
  return { x: tile.x, y: tile.y + (tile.h - h) / 2, w: tile.w, h }
}

/**
 * Where the angle's name is drawn inside the picture's on-screen rectangle:
 * a band across the top left just wide enough for "Primary" in large type,
 * and short of the pattern's yellow bar.
 */
export function labelBox(content: Rect): Rect {
  const { x, y, size } = LAYOUT.label
  return {
    x: content.x + content.w * (x - 0.01),
    y: content.y + content.h * (y - 0.01),
    w: content.w * 0.27,
    h: content.h * (size + 0.04)
  }
}

/** The counter's box inside the picture's on-screen rectangle. */
export function counterBox(content: Rect): Rect {
  const box = LAYOUT.counter
  return {
    x: content.x + content.w * box.x,
    y: content.y + content.h * box.y,
    w: content.w * box.w,
    h: content.h * box.h
  }
}

/**
 * The test pattern as `testPatternGame.ts` made the uploads' stand-ins, and
 * as the stack's test-pattern media are to be made: four program angles of
 * moving test pattern with a seven-digit frame counter, the angle's name and
 * the wall clock burned in, so a frozen or repeated frame is beyond doubt.
 */
/** The angles, as the source game's uploads were paired with them. */
export const ANGLES = ['Primary', 'Home', '1st', '3rd'] as const

/** The Distributor uploads' length, measured on 2026-10-26. */
export const DURATION_SEC = 5630.3

/** A keyframe every 2 s at 60 fps, as the uploads have. */
export const GOP_FRAMES = 2 * PATTERN_FPS

export interface EncodeOptions {
  label: string
  /** When the recording began: the wall clock burned into it counts from here. */
  startMs: number
  durationSec: number
  /** A file, or an `rtmp://` URL to send the pattern to live. */
  out: string
  fontfile: string
  /**
   * `hevc_videotoolbox` on a Mac, as the uploads were made; `libx265`
   * where there is no VideoToolbox, such as a stack's droplet.
   */
  encoder?: 'hevc_videotoolbox' | 'libx265'
}

/** drawtext's own escaping for text that contains `:` and `\`. */
function drawText(text: string): string {
  return text.replace(/\\/g, '\\\\\\\\').replace(/:/g, '\\:')
}

/**
 * The encoder's arguments. 5 Mbit/s requested lands at about 4 Mbit/s from
 * VideoToolbox on this pattern, which is what the uploads carry; temporal
 * noise makes every frame cost bits and differ from the last.
 */
export function patternArgs(options: EncodeOptions): string[] {
  const { counter, label, clock } = LAYOUT
  // Live, the pattern goes out at its own pace as FLV, which names HEVC
  // itself and refuses the hvc1 tag a file needs for Safari.
  const live = /^rtmps?:\/\//.test(options.out)
  const font = `fontfile=${options.fontfile}:fontcolor=white`
  const epochSec = (options.startMs / 1000).toFixed(3)
  const filter = [
    'noise=alls=12:allf=t',
    `drawbox=x=iw*${counter.x}:y=ih*${counter.y}:w=iw*${counter.w}:h=ih*${counter.h}:color=black:t=fill`,
    `drawtext=${font}:text='%{eif\\:n\\:d\\:7}':fontsize=h*${(counter.h * 0.8).toFixed(3)}:` +
      `x=w*${counter.x}+(w*${counter.w}-tw)/2:y=h*${counter.y}+(h*${counter.h}-th)/2`,
    `drawtext=${font}:text='${drawText(options.label)}':fontsize=h*${label.size}:` +
      `x=w*${label.x}:y=h*${label.y}:box=1:boxcolor=black@0.6`,
    `drawtext=${font}:text='%{pts\\:hms}   %{pts\\:gmtime\\:${epochSec}\\:%H\\\\\\:%M\\\\\\:%S} Z':` +
      `fontsize=h*${clock.size}:x=w*${clock.x}:y=h*${clock.y}:box=1:boxcolor=black@0.6`,
    'format=yuv420p'
  ].join(',')
  return [
    '-nostdin',
    '-loglevel',
    'error',
    ...(live ? ['-re'] : []),
    '-f',
    'lavfi',
    '-i',
    `testsrc2=size=1920x1080:rate=${PATTERN_FPS}`,
    '-f',
    'lavfi',
    '-i',
    'sine=frequency=1000:sample_rate=48000:beep_factor=4',
    '-t',
    String(options.durationSec),
    '-vf',
    filter,
    '-c:v',
    options.encoder ?? 'hevc_videotoolbox',
    ...((options.encoder ?? 'hevc_videotoolbox') === 'libx265'
      ? ['-preset', 'ultrafast', '-x265-params', 'log-level=none:bframes=0']
      : ['-profile:v', 'main', ...(live ? ['-realtime', '1'] : [])]),
    ...(live ? [] : ['-tag:v', 'hvc1']),
    '-b:v',
    '5M',
    '-maxrate',
    '5.6M',
    '-bufsize',
    '5.6M',
    '-g',
    String(GOP_FRAMES),
    '-c:a',
    'aac',
    '-b:a',
    '125k',
    '-ac',
    '1',
    ...(live ? ['-f', 'flv'] : ['-y']),
    options.out
  ]
}
