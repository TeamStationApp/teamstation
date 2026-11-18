import { execFileSync } from 'node:child_process'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

import { expect } from 'chai'
import { after, before, describe, it } from 'mocha'
import { PNG } from 'pngjs'
import puppeteer, { type Browser } from 'puppeteer'

/**
 * The splash generator's browser, encoding and regeneration cases. It launches
 * headless Chrome and runs sips and cwebp, which the unit tier forbids and
 * Linux CI lacks, so only `npm run coverage.splash -- --js` runs it, on macOS.
 */

const build: {
  ROOT: string
  STAND_IN_WIDTH: number
  build: (options: {
    root?: string
    outRoot?: string
    log?: (line: string) => void
  }) => Promise<{
    hash: string
    targets: Record<string, boolean>
  }>
  main: (
    argv: string[],
    options?: { root?: string; log?: (line: string) => void }
  ) => Promise<void>
  parseArgs: (argv: string[]) => {
    frames?: string
    sizes?: Array<{ w: number; h: number; scale: number }>
  }
  parseSizes: (text: string) => Array<{ w: number; h: number; scale: number }>
  requireTools: (tools: string[], path?: string) => void
  encodeUnder: (
    png: string,
    out: string,
    format: string,
    maxBytes?: number,
    run?: unknown
  ) => number
} = require('./buildSplashAssets.mjs')
interface Image {
  width: number
  height: number
  data: Uint8Array
}

const compare: {
  main: (argv: string[], log?: (line: string) => void) => number
  resample: (image: Image, width: number, height: number) => Image
  compareImages: (
    actual: Image,
    expected: Image
  ) => { pass: boolean; meanError: number; worstTile: number; reason: string }
} = require('./compareToReference.mjs')

const math: {
  coverRect: (
    timeline: unknown,
    w: number,
    h: number
  ) => { element: { x: number; y: number; width: number; height: number } }
} = require('./splashMath.mjs')

const root = resolve(__dirname, '../..')
const quiet = (): void => undefined

describe('splash reference page against the design', function () {
  this.timeout(60000)
  let browser: Browser
  before(async () => {
    browser = await puppeteer.launch({ headless: true })
  })
  after(async () => {
    await browser.close()
  })

  /** Every animated value design.html (selectors in `sel`) computes at `ms`. */
  async function read(
    file: string,
    sel: Record<string, string>,
    ms: number,
    start: { id: string; className: string } | null
  ): Promise<number[][]> {
    const page = await browser.newPage()
    // design.html pulls Tailwind and fonts from the network; nothing animated depends on them.
    await page.setRequestInterception(true)
    page.on('request', request => {
      const decided = request.url().startsWith('file:')
        ? request.continue()
        : request.abort()
      decided.catch(() => undefined)
    })
    await page.setViewport({ width: 1000, height: 1000 })
    const url = pathToFileURL(join(root, 'mobile/icons/splash', file))
    url.search = 'w=390&h=844&t=0'
    await page.goto(url.href, { waitUntil: 'load' })
    const values = await page.evaluate(
      (
        selectors: Record<string, string>,
        at: number,
        play: { id: string; className: string } | null
      ) => {
        // design.html starts its run by adding a class to the stage.
        if (play != null)
          document.getElementById(play.id)!.classList.add(play.className)
        for (const a of document.getAnimations()) {
          a.pause()
          a.currentTime = at
        }
        const out: number[][] = []
        for (const selector of Object.values(selectors)) {
          const style = getComputedStyle(document.querySelector(selector)!)
          const m = new DOMMatrixReadOnly(style.transform)
          const filters = [...style.filter.matchAll(/\(([-\d.e]+)/g)].map(
            match => Number(match[1])
          )
          out.push([Number(style.opacity), m.a, m.f, ...filters])
        }
        return out
      },
      sel,
      ms,
      start
    )
    await page.close()
    return values
  }

  it('computes the same values as design.html at every 100 ms', async () => {
    const design = {
      stadium: '.stadium-bg-portrait',
      dark: '.dark-gradient-overlay',
      glow: '.brand-glow',
      logo: '.logo-container',
      wordmark: '.wordmark-wrap'
    }
    const splash = {
      stadium: '.stadium',
      dark: '.dark',
      glow: '.glow',
      logo: '.logo',
      wordmark: '.wordmark'
    }
    for (let ms = 0; ms <= 2000; ms += 100) {
      const theirs = await read('design.html', design, ms, {
        id: 'phoneStage',
        className: 'animating'
      })
      const ours = await read('splash.html', splash, ms, null)
      theirs.forEach((row, i) => {
        row.forEach((value, j) =>
          expect(
            ours[i][j],
            `${Object.keys(design)[i]}[${j}] at ${ms} ms`
          ).to.be.closeTo(value, 0.002)
        )
      })
    }
  })
})

describe('the frame-0 placeholder', function () {
  this.timeout(120000)

  /**
   * What the apps draw while the 4K stadium decodes: the placeholder
   * aspect-filled into the stadium element, cut to the `w`x`h` window.
   */
  function placeholderIn(placeholder: Image, w: number, h: number): Image {
    const timeline = JSON.parse(
      readFileSync(join(root, 'mobile/icons/splash/timeline.json'), 'utf8')
    )
    const element = math.coverRect(timeline, w, h).element
    const scale = Math.max(
      element.width / placeholder.width,
      element.height / placeholder.height
    )
    const drawn = compare.resample(
      placeholder,
      Math.round(placeholder.width * scale),
      Math.round(placeholder.height * scale)
    )
    const left = Math.round(element.x + (element.width - drawn.width) / 2)
    const top = Math.round(element.y + (element.height - drawn.height) / 2)
    const out = new Uint8Array(w * h * 4)
    for (let y = 0; y < h; y++)
      for (let x = 0; x < w; x++) {
        const from = ((y - top) * drawn.width + (x - left)) * 4
        out.set(drawn.data.subarray(from, from + 4), (y * w + x) * 4)
      }
    return { width: w, height: h, data: out }
  }

  it('fills the stadium element as frame 0 does, at every window shape', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'splash-placeholder-'))
    const browser = await puppeteer.launch({ headless: true })
    try {
      execFileSync('sips', [
        '-s',
        'format',
        'png',
        join(
          root,
          'mobile/apps/common/TeamStationSplash/Sources/TeamStationSplash/Resources/splashLaunchFrame.jpg'
        ),
        '--out',
        join(dir, 'placeholder.png')
      ])
      const placeholder = PNG.sync.read(
        readFileSync(join(dir, 'placeholder.png'))
      )
      const page = await browser.newPage()
      for (const [w, h] of [
        [390, 844],
        [834, 1194],
        [1194, 834],
        [1920, 1080]
      ]) {
        await page.setViewport({ width: w, height: h, deviceScaleFactor: 1 })
        const url = pathToFileURL(join(root, 'mobile/icons/splash/splash.html'))
        url.search = `w=${w}&h=${h}&t=0&novignette&nobrand`
        await page.goto(url.href, { waitUntil: 'load' })
        const frame = PNG.sync.read(
          Buffer.from(await page.screenshot({ type: 'png' }))
        )
        const result = compare.compareImages(
          placeholderIn(placeholder, w, h),
          frame
        )
        expect(result.meanError, `${w}x${h}: ${result.reason}`).to.be.below(2.5)
        expect(result.worstTile, `${w}x${h}: ${result.reason}`).to.be.below(12)
      }
    } finally {
      await browser.close()
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('splash generator', function () {
  this.timeout(600000)

  it('regenerates every committed text output byte for byte, and every platform target', async () => {
    const out = mkdtempSync(join(tmpdir(), 'splash-build-'))
    try {
      for (const dir of [
        'mobile/apps/common/TeamStationSplash',
        'ios/TeamStation/Images.xcassets',
        'appletv/ios/TeamStationTV/Images.xcassets/LaunchFrame.imageset',
        'android/app/src/main/java/app/teamstation/app/splash'
      ])
        mkdirSync(join(out, dir), { recursive: true })
      writeFileSync(join(out, 'ios/TeamStation/LaunchScreen.storyboard'), '')
      const lines: string[] = []
      const result = await build.build({
        root,
        outRoot: out,
        log: line => lines.push(line)
      })
      expect(result.targets).to.deep.equal({
        swift: true,
        ios: true,
        tv: true,
        android: true
      })
      for (const file of [
        'mobile/icons/splash/timeline.js',
        'scripts/splash/sources.sha256',
        'src/test/fixtures/splashSamples.json',
        'ios/TeamStation/LaunchScreen.storyboard'
      ])
        expect(readFileSync(join(out, file), 'utf8'), file).to.equal(
          readFileSync(join(root, file), 'utf8')
        )
      const heic = join(
        out,
        'mobile/apps/common/TeamStationSplash/Sources/TeamStationSplash/Resources/splashStadium.heic'
      )
      const webp = join(
        out,
        'android/app/src/main/res/drawable-nodpi/splash_stadium.webp'
      )
      for (const file of [heic, webp])
        expect(statSync(file).size, file).to.be.at.most(2.5 * 1024 * 1024)
      expect(
        readdirSync(
          join(
            out,
            'mobile/apps/common/TeamStationSplash/Sources/TeamStationSplash/Resources'
          )
        ).sort()
      ).to.deep.equal([
        'splashLaunchFrame.jpg',
        'splashMark.png',
        'splashMarkBlurred.png',
        'splashStadium.heic',
        'splashStadiumBlurred.jpg',
        'splashWordmark.png',
        'splashWordmarkBlurred.png'
      ])
      for (const file of [
        'mobile/apps/common/TeamStationSplash/Sources/TeamStationSplashCore/SplashTimeline.swift',
        'android/app/src/main/java/app/teamstation/app/splash/SplashTimeline.kt',
        'ios/TeamStation/Images.xcassets/LaunchFrame390x844.imageset/LaunchFrame390x844.jpg',
        'ios/TeamStation/Images.xcassets/LaunchFrame390x844.imageset/LaunchFrame390x844-ipad.jpg',
        'ios/TeamStation/Images.xcassets/LaunchFrame390x844.imageset/Contents.json',
        'ios/TeamStation/Images.xcassets/LaunchFrame1210x834.imageset/LaunchFrame1210x834.jpg',
        'ios/TeamStation/Images.xcassets/LaunchFrame1210x834.imageset/LaunchFrame1210x834-iphone.jpg',
        'appletv/ios/TeamStationTV/Images.xcassets/LaunchFrame.imageset/Contents.json'
      ])
        expect(existsSync(join(out, file)), file).to.equal(true)
      const swift = readFileSync(
        join(
          out,
          'mobile/apps/common/TeamStationSplash/Sources/TeamStationSplashCore/SplashTimeline.swift'
        ),
        'utf8'
      )
      expect(swift).to.include(`sources sha256 ${result.hash}`)
      expect(swift).to.include('"scale": SplashTrack([(0.0, 2.8), (1.0, 1.0)])')
      const kotlin = readFileSync(
        join(
          out,
          'android/app/src/main/java/app/teamstation/app/splash/SplashTimeline.kt'
        ),
        'utf8'
      )
      expect(kotlin).to.include(
        '"scale" to SplashTrack(listOf(0.0 to 2.8, 1.0 to 1.0))'
      )
      expect(lines.join('\n')).to.match(/tv: launch frame 1920x1080/)
      expect(lines.join('\n')).to.match(
        /ios: launch frames 844x390@2, 667x375@2, 1133x744@0.75, 1210x834@0.75, 1376x1032@0.75, 1032x1376@0.75, 834x1210@0.75, 744x1133@0.75, 375x667@2, 390x844@2/
      )
      const standIn = execFileSync('sips', [
        '-g',
        'pixelWidth',
        join(
          out,
          'ios/TeamStation/Images.xcassets/LaunchFrame390x844.imageset/LaunchFrame390x844-ipad.jpg'
        )
      ]).toString()
      expect(standIn).to.include(`pixelWidth: ${build.STAND_IN_WIDTH}`)
    } finally {
      rmSync(out, { recursive: true, force: true })
    }
  })

  it('rebuilds the repository’s own outputs from the command', async () => {
    const lines: string[] = []
    await build.main([], { root, log: line => lines.push(line) })
    expect(lines[0]).to.equal('samples: 4 sizes')
  })

  it('writes reference frames that match themselves and differ across time', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'splash-frames-'))
    try {
      const lines: string[] = []
      await build.main(['--frames', dir, '--sizes', '390x844@1'], {
        root,
        log: line => lines.push(line)
      })
      const files = readdirSync(dir).sort()
      expect(files).to.deep.equal([
        'reference-390x844@1-t0.7.png',
        'reference-390x844@1-t0.png',
        'reference-390x844@1-t1.4.png',
        'reference-390x844@1-t2.png'
      ])
      expect(lines.at(-1)).to.equal('390x844: mark side 210.0')
      const a = join(dir, 'reference-390x844@1-t0.png')
      const b = join(dir, 'reference-390x844@1-t2.png')
      expect(compare.main([a, a], quiet)).to.equal(0)
      expect(compare.main([a, b], quiet)).to.equal(1)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('reads its sizes and arguments', () => {
    expect(build.parseSizes('402x874@3, 1920x1080')).to.deep.equal([
      { w: 402, h: 874, scale: 3 },
      { w: 1920, h: 1080, scale: 1 }
    ])
    expect(() => build.parseSizes('402by874')).to.throw(/Not a size/)
    expect(() => build.parseArgs(['--frames', 'x'])).to.throw(/go together/)
    expect(() => build.parseArgs(['--what'])).to.throw(/Unknown argument/)
  })

  it('stops with an install hint when a tool is missing', () => {
    expect(() => {
      build.requireTools(['cwebp'], '/nonexistent')
    }).to.throw(/brew install webp/)
    expect(() => {
      build.requireTools(['sips'], '')
    }).to.throw(/brew install sips/)
    expect(() => {
      build.requireTools(['sips'], '/usr/bin')
    }).to.not.throw()
  })

  it('gives up when even quality 40 is too large', () => {
    const dir = mkdtempSync(join(tmpdir(), 'splash-encode-'))
    try {
      const png = join(dir, 'in.png')
      require('node:fs').copyFileSync(
        join(root, 'mobile/icons/splash/stadium.jpg'),
        png
      )
      expect(() =>
        build.encodeUnder(png, join(dir, 'out.jpg'), 'jpeg', 10)
      ).to.throw(/still over 10 bytes/)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
