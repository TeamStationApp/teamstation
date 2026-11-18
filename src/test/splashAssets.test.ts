import {
  cpSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

import { expect } from 'chai'
import { describe, it } from 'mocha'

/**
 * The launch splash's maths and committed outputs (scripts/splash). Pure: it
 * starts no process and reads only committed files. The browser, encoding and
 * regeneration cases are in scripts/splash/splashAssets.mac-test.ts, which only
 * `npm run coverage.splash -- --js` runs, on macOS.
 */

type Keys = Array<[number, number]>
interface Timeline {
  durationMs: number
  design: { width: number; height: number; side: number }
  stadium: { width: number; height: number; focus: [number, number] }
  layers: Record<string, { easing: number[]; tracks: Record<string, Keys> }>
}
interface Image {
  width: number
  height: number
  data: Uint8Array
}

const math: {
  SOURCE_FILES: string[]
  ANIMATED: Record<string, string[]>
  checkTimeline: (timeline: unknown) => Timeline
  cubicBezier: (
    x1: number,
    y1: number,
    x2: number,
    y2: number
  ) => (p: number) => number
  sampleTrack: (keys: Keys, easing: number[], progress: number) => number
  sampleAll: (
    timeline: Timeline,
    ms: number
  ) => Record<string, Record<string, number>>
  brandSize: (
    timeline: Timeline,
    w: number,
    h: number
  ) => { side: number; k: number }
  coverRect: (
    timeline: Timeline,
    w: number,
    h: number
  ) => {
    x: number
    y: number
    width: number
    height: number
    visible: { width: number; height: number }
  }
  frameZeroCrop: (
    timeline: Timeline,
    w?: number,
    h?: number
  ) => {
    x: number
    y: number
    width: number
    height: number
    centre: [number, number]
  }
  sourceFiles: (root: string) => string[]
  sourcesHash: (root: string, files: string[]) => string
  recordedHash: (text: string) => string | null
} = require('../../scripts/splash/splashMath.mjs')
const compare: {
  compareImages: (
    a: Image,
    b: Image,
    options?: { maskTop?: number; fit?: number }
  ) => { pass: boolean; reason: string; meanError?: number }
  parseArgs: (argv: string[]) => {
    screenshot: string
    reference: string
    options: Record<string, number>
  }
  main: (argv: string[], log?: (line: string) => void) => number
} = require('../../scripts/splash/compareToReference.mjs')

const root = resolve(__dirname, '../..')
const timeline = math.checkTimeline(
  JSON.parse(
    readFileSync(join(root, 'mobile/icons/splash/timeline.json'), 'utf8')
  )
)
const samples: {
  sourcesSha256: string
  samples: Record<
    string,
    Array<Record<string, Record<string, number>> & { ms: number }>
  >
} = JSON.parse(
  readFileSync(join(root, 'src/test/fixtures/splashSamples.json'), 'utf8')
)
const REGENERATE =
  'run `socket npm run splash.assets` and commit what it writes'

const clone = (): Timeline => JSON.parse(JSON.stringify(timeline))

/** A solid image, with an optional rectangle of another colour. */
function image(
  width: number,
  height: number,
  value: number,
  patch?: { x: number; y: number; w: number; h: number; value: number }
): Image {
  const data = new Uint8Array(width * height * 4)
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++) {
      const inside =
        patch != null &&
        x >= patch.x &&
        x < patch.x + patch.w &&
        y >= patch.y &&
        y < patch.y + patch.h
      const v = inside ? patch.value : value
      data.set([v, v, v, 255], (y * width + x) * 4)
    }
  return { width, height, data }
}

describe('splash maths', () => {
  it('fits the stadium so wider windows crop less of it', () => {
    const phone = math.coverRect(timeline, 390, 844)
    expect(phone.visible.width).to.be.closeTo(0.252, 0.001)
    expect(phone.x + phone.width / 2).to.be.closeTo(195, 0.01)
    const tv = math.coverRect(timeline, 1920, 1080)
    expect(tv.visible.width).to.be.closeTo(0.969, 0.001)
    const iPad = math.coverRect(timeline, 1194, 834)
    expect(iPad.visible.width).to.be.within(
      phone.visible.width,
      tv.visible.width
    )
    // Wider than the image itself: the width fills, less the bleed, and the
    // height crops instead.
    const wide = math.coverRect(timeline, 2400, 1000)
    expect(wide.visible.width).to.be.closeTo(0.99, 0.001)
    expect(wide.visible.height).to.be.below(0.8)
  })

  it('sizes the mark for any window', () => {
    const sides = [
      [390, 844, 210],
      [1194, 834, 207.5],
      [834, 1194, 297.1],
      [1920, 1080, 268.7]
    ]
    for (const [w, h, side] of sides)
      expect(math.brandSize(timeline, w, h).side).to.be.closeTo(side, 0.05)
    expect(math.brandSize(timeline, 390, 844).k).to.equal(1)
  })

  it('crops frame 0 about the zoom’s fixed point', () => {
    const crop = math.frameZeroCrop(timeline)
    expect(crop).to.include({ x: 1769, y: 1066, width: 1966, height: 1098 })
    expect(crop.centre).to.deep.equal([2752, 1615])
    const small = math.frameZeroCrop(timeline, 1376, 768)
    expect(small.width / 1376).to.be.closeTo(crop.width / 5504, 0.001)
    expect(small.y / 768).to.be.closeTo(crop.y / 3072, 0.001)
  })

  it('solves cubic-bezier as CSS does', () => {
    const linear = math.cubicBezier(0, 0, 1, 1)
    expect(linear(0.3)).to.be.closeTo(0.3, 1e-6)
    const ease = math.cubicBezier(0.25, 0.1, 0.25, 1)
    expect(ease(0)).to.equal(0)
    expect(ease(1)).to.equal(1)
    expect(ease(0.5)).to.be.closeTo(0.8024, 1e-3)
    // A flat start makes Newton's slope vanish; bisection still converges.
    const flat = math.cubicBezier(1, 0, 1, 0.5)
    expect(flat(0.5)).to.be.within(0, 0.5)
  })

  it('applies the curve to each segment between keyframes', () => {
    const keys: Keys = [
      [0, 0],
      [0.5, 10],
      [1, 0]
    ]
    expect(math.sampleTrack(keys, [0, 0, 1, 1], 0.25)).to.be.closeTo(5, 1e-6)
    expect(math.sampleTrack(keys, [0, 0, 1, 1], 0.75)).to.be.closeTo(5, 1e-6)
    expect(math.sampleTrack(keys, [0, 0, 1, 1], -1)).to.equal(0)
    expect(math.sampleTrack(keys, [0, 0, 1, 1], 2)).to.equal(0)
  })

  it('matches the browser’s computed values at every sample', () => {
    let rows = 0
    for (const [size, list] of Object.entries(samples.samples))
      for (const row of list) {
        const expected = math.sampleAll(timeline, row.ms)
        for (const [layer, props] of Object.entries(expected))
          for (const [prop, value] of Object.entries(props))
            expect(
              row[layer][prop],
              `${size} ${row.ms} ms ${layer}.${prop}`
            ).to.be.closeTo(value, 0.002)
        rows++
      }
    expect(rows).to.equal(4 * 41)
  })
})

describe('splash timeline checks', () => {
  it('accepts the committed timeline', () => {
    expect(math.checkTimeline(clone()).durationMs).to.equal(2000)
  })

  const broken: Array<[string, (t: Timeline) => void, RegExp]> = [
    ['a non-positive duration', t => (t.durationMs = 0), /durationMs/],
    ['a missing layer', t => delete t.layers.glow, /glow: missing layer/],
    [
      'a three-number curve',
      t => (t.layers.stadium.easing = [0, 0, 1]),
      /four numbers/
    ],
    [
      'a five-number curve',
      t => (t.layers.dark.easing = [0, 0, 1, 1, 1]),
      /four numbers/
    ],
    [
      'a single keyframe',
      t => (t.layers.mark.tracks.blur = [[0, 1]]),
      /two keyframes/
    ],
    [
      'a track that does not end at 1',
      t =>
        (t.layers.mark.tracks.blur = [
          [0, 1],
          [0.9, 0]
        ]),
      /from 0 to 1/
    ],
    [
      'keyframe times that do not ascend',
      t =>
        (t.layers.dark.tracks.opacity = [
          [0, 0],
          [0.6, 1],
          [0.5, 1],
          [1, 1]
        ]),
      /must ascend/
    ],
    [
      'filter tracks that do not share times',
      t =>
        (t.layers.stadium.tracks.blur = [
          [0, 0],
          [1, 4]
        ]),
      /must share keyframe times/
    ]
  ]
  for (const [what, breakIt, message] of broken)
    it(`rejects ${what}`, () => {
      const t = clone()
      breakIt(t)
      expect(() => math.checkTimeline(t)).to.throw(message)
    })
})

describe('splash generated files', () => {
  const hash = math.sourcesHash(root, math.sourceFiles(root))

  it('were generated from the committed sources', () => {
    expect(
      readFileSync(join(root, 'scripts/splash/sources.sha256'), 'utf8').trim(),
      REGENERATE
    ).to.equal(hash)
    expect(samples.sourcesSha256, REGENERATE).to.equal(hash)
    const generated = [
      'mobile/icons/splash/timeline.js',
      'mobile/apps/common/TeamStationSplash/Sources/TeamStationSplashCore/SplashTimeline.swift',
      'android/app/src/main/java/app/teamstation/app/splash/SplashTimeline.kt'
    ].filter(file => existsSync(join(root, file)))
    expect(generated).to.include('mobile/icons/splash/timeline.js')
    for (const file of generated)
      expect(
        math.recordedHash(readFileSync(join(root, file), 'utf8')),
        `${file}: ${REGENERATE}`
      ).to.equal(hash)
  })

  it('notices a one-byte change to a source', () => {
    const copy = mkdtempSync(join(tmpdir(), 'splash-hash-'))
    try {
      for (const file of math.SOURCE_FILES)
        cpSync(join(root, file), join(copy, file), { recursive: true })
      expect(math.sourcesHash(copy, math.sourceFiles(copy))).to.equal(hash)
      const json = join(copy, 'mobile/icons/splash/timeline.json')
      writeFileSync(json, readFileSync(json, 'utf8') + ' ')
      expect(math.sourcesHash(copy, math.sourceFiles(copy))).to.not.equal(hash)
    } finally {
      rmSync(copy, { recursive: true, force: true })
    }
  })

  it('reads no hash from a file without one', () => {
    expect(math.recordedHash('// written by hand')).to.equal(null)
  })

  it('keeps every encoded stadium under 2.5 MB at full width', () => {
    const encoded = [
      'mobile/apps/common/TeamStationSplash/Sources/TeamStationSplash/Resources/splashStadium.heic',
      'android/app/src/main/res/drawable-nodpi/splash_stadium.webp'
    ].filter(file => existsSync(join(root, file)))
    for (const file of encoded) {
      const bytes = readFileSync(join(root, file))
      expect(bytes.length, file).to.be.at.most(2.5 * 1024 * 1024)
      expect(encodedWidth(bytes), file).to.equal(timeline.stadium.width)
    }
  })
})

/**
 * The width an HEIC's `ispe` boxes or a lossy WebP's VP8 header gives. An HEIC
 * holds its picture as a grid of tiles, each with its own `ispe`; the widest
 * is the whole image's.
 */
function encodedWidth(bytes: Buffer): number {
  let widest = -1
  for (
    let at = bytes.indexOf('ispe');
    at >= 0;
    at = bytes.indexOf('ispe', at + 4)
  )
    widest = Math.max(widest, bytes.readUInt32BE(at + 8))
  if (widest > 0) return widest
  const vp8 = bytes.indexOf('VP8 ')
  if (vp8 >= 0) return bytes.readUInt16LE(vp8 + 14) & 0x3fff
  return -1
}

describe('compareToReference', () => {
  it('passes an identical pair and one a little apart', () => {
    expect(
      compare.compareImages(image(8, 8, 100), image(8, 8, 100)).pass
    ).to.equal(true)
    const near = compare.compareImages(image(8, 8, 100), image(8, 8, 104))
    expect(near.pass).to.equal(true)
    expect(near.meanError).to.equal(4)
  })

  it('fails a shifted brand block', () => {
    const a = image(20, 20, 10, { x: 5, y: 5, w: 6, h: 6, value: 200 })
    const b = image(20, 20, 10, { x: 9, y: 5, w: 6, h: 6, value: 200 })
    const result = compare.compareImages(a, b)
    expect(result.pass).to.equal(false)
    expect(result.reason).to.match(/pixels off by more than 32/)
  })

  it('fails a region wrong throughout though the whole frame is close', () => {
    // A 48x48 patch, 4% of a 240x240 frame: whole-frame figures pass, its tile does not.
    const a = image(240, 240, 20)
    const b = image(240, 240, 20, { x: 48, y: 48, w: 48, h: 48, value: 200 })
    const result = compare.compareImages(a, b)
    expect(result.pass).to.equal(false)
    expect(result.reason).to.match(/worst 48px tile 180.0/)
    expect(compare.compareImages(a, a).reason).to.match(
      /^within tolerance: mean error 0.00/
    )
  })

  it('brings a screenshot a pixel off onto the reference grid', () => {
    const near = image(10, 11, 80)
    expect(compare.compareImages(near, image(9, 10, 80)).pass).to.equal(false)
    expect(
      compare.compareImages(near, image(9, 10, 80), { fit: 3 }).pass
    ).to.equal(true)
    expect(
      compare.compareImages(image(20, 20, 80), image(9, 10, 80), { fit: 3 })
        .pass
    ).to.equal(false)
  })

  it('fails mismatched sizes', () => {
    expect(
      compare.compareImages(image(8, 8, 0), image(8, 9, 0)).reason
    ).to.match(/size 8x8 is not/)
  })

  it('leaves the masked status bar out', () => {
    const a = image(10, 60, 50, { x: 0, y: 0, w: 10, h: 54, value: 255 })
    const b = image(10, 60, 50)
    expect(compare.compareImages(a, b).pass).to.equal(false)
    expect(compare.compareImages(a, b, { maskTop: 54 }).pass).to.equal(true)
    expect(compare.compareImages(a, b, { maskTop: 60 }).meanError).to.equal(0)
  })

  it('reads its options and refuses bad ones', () => {
    expect(
      compare.parseArgs([
        'a.png',
        'b.png',
        '--mask-top',
        '54',
        '--max-mean',
        '3',
        '--max-off',
        '0.1',
        '--fit',
        '2'
      ])
    ).to.deep.equal({
      screenshot: 'a.png',
      reference: 'b.png',
      options: { maskTop: 54, maxMean: 3, maxOff: 0.1, fit: 2 }
    })
    expect(() => compare.parseArgs(['a.png'])).to.throw(
      /screenshot and a reference/
    )
    expect(() =>
      compare.parseArgs(['a.png', 'b.png', '--mask-top', 'x'])
    ).to.throw(/needs a number/)
    expect(() => compare.parseArgs(['a.png', 'b.png', '--wat'])).to.throw(
      /Unknown option/
    )
    const lines: string[] = []
    expect(compare.main(['only-one.png'], line => lines.push(line))).to.equal(2)
    expect(lines[0]).to.match(/Give a screenshot/)
  })
})
