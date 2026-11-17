#!/usr/bin/env node
// Compares a device screenshot of the frozen splash with the reference frame
// buildSplashAssets.mjs --frames rendered at the same size and time.
//
//   node scripts/splash/compareToReference.mjs <screenshot.png> <reference.png>
//     [--mask-top <px>] [--max-mean <0-255>] [--max-off <fraction>] [--fit <px>]
//     [--max-tile <0-255>]
//
// It passes when the mean per-channel error is at most --max-mean (6), at
// most --max-off (0.02) of the pixels differ by more than 32 in any channel,
// and no 48-pixel tile's mean error is over --max-tile (60). It prints the
// figures either way.
// --mask-top leaves out that many rows at the top: the status bar, which the
// reference page does not draw. --fit resamples a screenshot within that many
// pixels of the reference's size onto it. Exits 1 on a failure, 2 on bad
// arguments.
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

import pngjs from 'pngjs'

export const DEFAULTS = {
  maskTop: 0,
  maxMean: 6,
  maxOff: 0.02,
  fit: 0,
  tile: 48,
  maxTile: 60
}

/**
 * `image` resampled (bilinear) to `width`×`height`. A density such as
 * Android's 2.625 puts a screen a pixel off any whole-CSS-pixel page, so a
 * screenshot within `fit` pixels of the reference is brought onto its grid.
 */
export function resample(image, width, height) {
  const data = new Uint8Array(width * height * 4)
  const sx = image.width / width
  const sy = image.height / height
  for (let y = 0; y < height; y++) {
    const fy = Math.min(image.height - 1, Math.max(0, (y + 0.5) * sy - 0.5))
    const y0 = Math.floor(fy)
    const y1 = Math.min(image.height - 1, y0 + 1)
    const ty = fy - y0
    for (let x = 0; x < width; x++) {
      const fx = Math.min(image.width - 1, Math.max(0, (x + 0.5) * sx - 0.5))
      const x0 = Math.floor(fx)
      const x1 = Math.min(image.width - 1, x0 + 1)
      const tx = fx - x0
      for (let c = 0; c < 4; c++) {
        const at = (yy, xx) => image.data[(yy * image.width + xx) * 4 + c]
        const top = at(y0, x0) * (1 - tx) + at(y0, x1) * tx
        const bottom = at(y1, x0) * (1 - tx) + at(y1, x1) * tx
        data[(y * width + x) * 4 + c] = Math.round(top * (1 - ty) + bottom * ty)
      }
    }
  }
  return { width, height, data }
}

/**
 * Compares two decoded images ({ width, height, data } with RGBA bytes).
 * Returns the error figures and whether they pass.
 */
export function compareImages(actual, expected, options = {}) {
  const { maskTop, maxMean, maxOff, fit, tile, maxTile } = {
    ...DEFAULTS,
    ...options
  }
  if (
    (actual.width !== expected.width || actual.height !== expected.height) &&
    Math.abs(actual.width - expected.width) <= fit &&
    Math.abs(actual.height - expected.height) <= fit
  )
    actual = resample(actual, expected.width, expected.height)
  if (actual.width !== expected.width || actual.height !== expected.height)
    return {
      pass: false,
      reason: `size ${actual.width}x${actual.height} is not the reference's ${expected.width}x${expected.height}`
    }
  const top = Math.min(actual.height, Math.max(0, Math.round(maskTop)))
  let sum = 0
  let off = 0
  const pixels = actual.width * (actual.height - top)
  for (let y = top; y < actual.height; y++)
    for (let x = 0; x < actual.width; x++) {
      const i = (y * actual.width + x) * 4
      let worst = 0
      for (let c = 0; c < 3; c++) {
        const d = Math.abs(actual.data[i + c] - expected.data[i + c])
        sum += d
        if (d > worst) worst = d
      }
      if (worst > 32) off++
    }
  // A whole-frame mean forgives a small region that is wrong throughout,
  // such as a missing wordmark or a brand block a few points out of place:
  // every tile must be close too.
  let worstTile = 0
  for (let ty = top; ty < actual.height; ty += tile)
    for (let tx = 0; tx < actual.width; tx += tile) {
      let tileSum = 0
      let count = 0
      for (let y = ty; y < Math.min(actual.height, ty + tile); y++)
        for (let x = tx; x < Math.min(actual.width, tx + tile); x++) {
          const i = (y * actual.width + x) * 4
          for (let c = 0; c < 3; c++)
            tileSum += Math.abs(actual.data[i + c] - expected.data[i + c])
          count += 3
        }
      worstTile = Math.max(worstTile, tileSum / count)
    }
  const meanError = pixels === 0 ? 0 : sum / (pixels * 3)
  const offFraction = pixels === 0 ? 0 : off / pixels
  const pass =
    meanError <= maxMean && offFraction <= maxOff && worstTile <= maxTile
  const figures = `mean error ${meanError.toFixed(2)} (max ${maxMean}), ${(offFraction * 100).toFixed(2)}% of pixels off by more than 32 (max ${maxOff * 100}%), worst ${tile}px tile ${worstTile.toFixed(1)} (max ${maxTile})`
  return {
    pass,
    meanError,
    offFraction,
    worstTile,
    reason: pass ? `within tolerance: ${figures}` : figures
  }
}

/** Reads the command line; throws on anything it does not know. */
export function parseArgs(argv) {
  const files = []
  const options = {}
  const names = {
    '--mask-top': 'maskTop',
    '--max-mean': 'maxMean',
    '--max-off': 'maxOff',
    '--fit': 'fit',
    '--max-tile': 'maxTile'
  }
  for (let i = 0; i < argv.length; i++) {
    const name = names[argv[i]]
    if (name != null) {
      const value = Number(argv[++i])
      if (!Number.isFinite(value))
        throw new Error(`${argv[i - 1]} needs a number`)
      options[name] = value
    } else if (argv[i].startsWith('--'))
      throw new Error(`Unknown option ${argv[i]}`)
    else files.push(argv[i])
  }
  if (files.length !== 2) throw new Error('Give a screenshot and a reference')
  return { screenshot: files[0], reference: files[1], options }
}

/** The command: prints the figures and returns the exit code. */
export function main(argv, log = console.log) {
  let args
  try {
    args = parseArgs(argv)
  } catch (error) {
    log(`compareToReference: ${error.message}`)
    return 2
  }
  const read = file => pngjs.PNG.sync.read(readFileSync(file))
  const result = compareImages(
    read(args.screenshot),
    read(args.reference),
    args.options
  )
  log(
    `${result.pass ? 'PASS' : 'FAIL'} ${args.screenshot} vs ${args.reference}: ${result.reason}`
  )
  return result.pass ? 0 : 1
}

if (process.argv[1] === fileURLToPath(import.meta.url))
  process.exitCode = main(process.argv.slice(2))
