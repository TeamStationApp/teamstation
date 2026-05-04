/**
 * Pixel-diffs screenshots/baseline/*.png vs screenshots/upgraded/*.png
 * using pixelmatch and writes annotated diffs to screenshots/diff/.
 *
 * Exits non-zero if any image exceeds the configured threshold.
 *
 * Usage:
 *   node tools/diffScreenshots.js [--threshold=0.5] [--baseline=...] [--upgraded=...] [--diff=...]
 *
 * --threshold is the maximum allowed % differing pixels per image
 * (default 0.5, i.e. 0.5%).
 */
const path = require('path')
const fs = require('fs')

const pixelmatch = require('pixelmatch')
const { PNG } = require('pngjs')

const REPO_ROOT = path.resolve(__dirname, '..')

function parseArgs() {
  const args = {
    threshold: 0.5,
    baseline: 'screenshots/baseline',
    upgraded: 'screenshots/upgraded',
    diff: 'screenshots/diff'
  }
  for (const arg of process.argv.slice(2)) {
    const m = arg.match(/^--([^=]+)=(.*)$/)
    if (m) {
      const v = m[2]
      args[m[1]] = m[1] === 'threshold' ? Number(v) : v
    }
  }
  return args
}

function readPng(absPath) {
  const buf = fs.readFileSync(absPath)
  return PNG.sync.read(buf)
}

function main() {
  const args = parseArgs()
  const baselineDir = path.resolve(REPO_ROOT, args.baseline)
  const upgradedDir = path.resolve(REPO_ROOT, args.upgraded)
  const diffDir = path.resolve(REPO_ROOT, args.diff)
  fs.mkdirSync(diffDir, { recursive: true })

  const baselineFiles = fs
    .readdirSync(baselineDir)
    .filter(f => f.endsWith('.png'))
    .sort()

  if (baselineFiles.length === 0) {
    console.error(`[diffScreenshots] no PNGs in ${baselineDir}`)
    process.exit(2)
  }

  let failures = 0
  console.log(
    `[diffScreenshots] comparing ${baselineFiles.length} files, threshold=${args.threshold}%`
  )

  for (const file of baselineFiles) {
    const aPath = path.join(baselineDir, file)
    const bPath = path.join(upgradedDir, file)
    if (!fs.existsSync(bPath)) {
      console.error(`  ${file}: MISSING in ${upgradedDir}`)
      failures += 1
      continue
    }
    const a = readPng(aPath)
    const b = readPng(bPath)
    if (a.width !== b.width || a.height !== b.height) {
      console.error(
        `  ${file}: dimension mismatch ${a.width}x${a.height} vs ${b.width}x${b.height}`
      )
      failures += 1
      continue
    }
    const diff = new PNG({ width: a.width, height: a.height })
    const diffPixels = pixelmatch(
      a.data,
      b.data,
      diff.data,
      a.width,
      a.height,
      { threshold: 0.1 }
    )
    const totalPixels = a.width * a.height
    const pct = (diffPixels / totalPixels) * 100
    fs.writeFileSync(path.join(diffDir, file), PNG.sync.write(diff))
    const status = pct <= args.threshold ? 'PASS' : 'FAIL'
    if (status === 'FAIL') failures += 1
    console.log(
      `  ${file}: ${pct.toFixed(3)}% diff (${diffPixels}/${totalPixels})  ${status}`
    )
  }

  if (failures > 0) {
    console.error(`[diffScreenshots] ${failures} file(s) failed`)
    process.exit(1)
  }
  console.log('[diffScreenshots] all files within threshold')
}

main()
