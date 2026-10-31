#!/usr/bin/env node
/**
 * Draws the phone app's icon for both platforms from the mark's own path data.
 *
 *     node src/tools/makeAppIcons.mjs
 *
 * It is drawn rather than resized: `src/app/components/tsMarkPaths.ts` is the
 * vector the app puts in its own header, and the gradient's two colours come
 * from the theme, so the icon is the same mark in the same colours and cannot
 * drift from what the header draws.
 *
 * The one difference is the background. In the app the mark is strokes over
 * nothing, so the header's glass shows through its middle. An icon has nothing
 * behind it, so it sits on the app's own canvas colour.
 */
import { spawnSync } from 'node:child_process'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

import { PNG } from 'pngjs'
import puppeteer from 'puppeteer'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const PATHS = join(ROOT, 'src/app/components/tsMarkPaths.ts')
const THEME = join(ROOT, 'src/app/theme/tsBallpark.ts')
const IOS_ICONS = join(
  ROOT,
  'ios/TeamStation/Images.xcassets/AppIcon.appiconset'
)
const ANDROID_RES = join(ROOT, 'android/app/src/main/res')

// Android's launcher crops an adaptive icon to whatever shape the phone's
// launcher uses. Two thirds of the tile is the *square* that survives, and a
// round launcher keeps a circle 2/3 of the tile across, and a square only
// survives inside that circle if its diagonal fits: 0.667 / sqrt(2) = 0.47.
// Drawn at 0.66 the arc's top-left came out cut flat against the mask on the
// emulator, and 0.58 was still not enough — the corners are what get taken,
// and the mark has its arc in one corner and the leaf's tail in another.
const ADAPTIVE_SAFE = 0.46
// iOS applies its own rounding and wants the artwork to reach the edges.
const IOS_INSET = 0.72

const DENSITIES = { mdpi: 48, hdpi: 72, xhdpi: 96, xxhdpi: 144, xxxhdpi: 192 }

const paths = readFileSync(PATHS, 'utf8')
const theme = readFileSync(THEME, 'utf8')

/** One `export const NAME = '...'` out of the paths module. */
function read(name) {
  const match = new RegExp(`${name} =\\s*\\n?\\s*'([^']*)'`).exec(paths)
  if (match == null) throw new Error(`No ${name} in ${PATHS}`)
  return match[1]
}

function readList(name) {
  const block = new RegExp(
    `${name}: string\\[\\] = \\[([\\s\\S]*?)\\n\\]`
  ).exec(paths)
  if (block == null) throw new Error(`No ${name} in ${PATHS}`)
  return [...block[1].matchAll(/'([^']*)'/g)].map(match => match[1])
}

function colour(name) {
  // The palette entries are named rather than spelled at the point of use.
  const key = name === 'backgroundColor' ? 'bone' : name
  const match =
    new RegExp(`${name}: '(#[0-9A-Fa-f]{6})'`).exec(theme) ??
    new RegExp(`${key}: '(#[0-9A-Fa-f]{6})'`).exec(theme)
  if (match == null) throw new Error(`No colour ${name} in ${THEME}`)
  return match[1]
}

/** One `export const NAME = <number>` out of the paths module. */
function number(name) {
  const match = new RegExp(`${name} = ([0-9.]+)`).exec(paths)
  if (match == null) throw new Error(`No ${name} in ${PATHS}`)
  return match[1]
}

/** The gradient's line and its two stops, as the paths module writes them. */
function gradient() {
  const line = /MARK_GRADIENT = \{([^}]*)\}/.exec(paths)
  const stops = /MARK_GRADIENT_STOPS[^=]*= \[([^\]]*)\]/.exec(paths)
  if (line == null || stops == null) {
    throw new Error(`No MARK_GRADIENT in ${PATHS}`)
  }
  const points = Object.fromEntries(
    [...line[1].matchAll(/(\w+): ([0-9.]+)/g)].map(match => [
      match[1],
      match[2]
    ])
  )
  return { points, stops: stops[1].split(',').map(stop => stop.trim()) }
}

/** The mark, centred on a square, at `scale` of the square's width. */
function svg(size, scale, background) {
  const { points, stops } = gradient()
  const drawn = size * scale
  const offset = (size - drawn) / 2
  const fill =
    background == null
      ? ''
      : `<rect width="${size}" height="${size}" fill="${background}"/>`
  const strokes = readList('MARK_PATHS')
    .map(d => `<path d="${d}"/>`)
    .join('')
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" ` +
    `height="${size}" viewBox="0 0 ${size} ${size}" style="display:block">${fill}` +
    `<svg x="${offset}" y="${offset}" width="${drawn}" height="${drawn}" ` +
    `viewBox="${read('MARK_VIEW_BOX')}">` +
    `<defs><linearGradient id="mark" gradientUnits="userSpaceOnUse" ` +
    `x1="${points.x1}" y1="${points.y1}" x2="${points.x2}" y2="${points.y2}">` +
    `<stop offset="${stops[0]}" stop-color="${colour('markGradientStart')}"/>` +
    `<stop offset="${stops[1]}" stop-color="${colour('markGradientEnd')}"/>` +
    `</linearGradient></defs>` +
    `<g fill="none" stroke="url(#mark)" ` +
    `stroke-width="${number('MARK_STROKE_WIDTH')}" ` +
    `stroke-linecap="round" stroke-linejoin="round">${strokes}</g>` +
    `</svg></svg>`
  )
}

function writeText(path, text) {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, text)
}

const browser = await puppeteer.launch()
const page = await browser.newPage()

async function writePng(path, size, scale, background) {
  await page.setViewport({ width: size, height: size, deviceScaleFactor: 1 })
  await page.setContent(
    `<!doctype html><body style="margin:0">${svg(size, scale, background)}</body>`
  )
  const shot = await page.screenshot({ omitBackground: background == null })
  const png = PNG.sync.read(Buffer.from(shot))
  // A PNG with an alpha channel is rejected by the App Store, so an opaque
  // icon is written without one.
  const bytes = PNG.sync.write(png, { colorType: background == null ? 6 : 2 })
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, bytes)
  console.log(`${relative(ROOT, path)}  ${size}×${size}`)
}

async function buildIos() {
  // One 1024 image: Xcode has taken every other size from it since 13.
  await writePng(
    join(IOS_ICONS, 'AppIcon.png'),
    1024,
    IOS_INSET,
    colour('backgroundColor')
  )
  writeText(
    join(IOS_ICONS, 'Contents.json'),
    '{\n  "images" : [\n    {\n      "filename" : "AppIcon.png",\n' +
      '      "idiom" : "universal",\n      "platform" : "ios",\n' +
      '      "size" : "1024x1024"\n    }\n  ],\n  "info" : {\n' +
      '    "author" : "xcode",\n    "version" : 1\n  }\n}\n'
  )
}

async function buildAndroid() {
  const canvas = colour('backgroundColor')
  for (const [density, size] of Object.entries(DENSITIES)) {
    const folder = join(ANDROID_RES, `mipmap-${density}`)
    // The legacy icons, for a launcher that does not do adaptive ones.
    await writePng(join(folder, 'ic_launcher.png'), size, IOS_INSET, canvas)
    await writePng(
      join(folder, 'ic_launcher_round.png'),
      size,
      IOS_INSET,
      canvas
    )
    // And the foreground of the adaptive one, which is drawn over a plain
    // background colour and cropped to the launcher's own shape.
    await writePng(
      join(folder, 'ic_launcher_foreground.png'),
      size * 2,
      ADAPTIVE_SAFE,
      undefined
    )
  }

  writeText(
    join(ANDROID_RES, 'values/ic_launcher_background.xml'),
    '<?xml version="1.0" encoding="utf-8"?>\n<resources>\n' +
      `    <color name="ic_launcher_background">${canvas}</color>\n` +
      '</resources>\n'
  )
  for (const name of ['ic_launcher', 'ic_launcher_round']) {
    writeText(
      join(ANDROID_RES, 'mipmap-anydpi-v26', `${name}.xml`),
      '<?xml version="1.0" encoding="utf-8"?>\n' +
        '<adaptive-icon xmlns:android="http://schemas.android.com/apk/res/android">\n' +
        '    <background android:drawable="@color/ic_launcher_background"/>\n' +
        '    <foreground android:drawable="@mipmap/ic_launcher_foreground"/>\n' +
        '</adaptive-icon>\n'
    )
  }
}

try {
  await buildIos()
  await buildAndroid()
} finally {
  await browser.close()
}

// Say so rather than leaving a stray alpha channel to be discovered.
const alpha = spawnSync(
  'sips',
  ['-g', 'hasAlpha', join(IOS_ICONS, 'AppIcon.png')],
  {
    encoding: 'utf8'
  }
)
console.log(alpha.stdout.trim().split('\n').at(-1))
