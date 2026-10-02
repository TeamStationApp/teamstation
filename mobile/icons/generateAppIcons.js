#!/usr/bin/env node
/**
 * Compose the operator apps' icons from the TeamStation mark plus a per-app
 * wireframe glyph.
 *
 * Source of truth for the mark: `mobile/icons/tsLogo.png`, the mark from
 * `src/app/assets/teamStationMark.svg` on the cream canvas.
 *
 * Layout: cream canvas (sampled from the logo). The glyph leads, centered and
 * as large as an equal margin on every side allows. A small mark signs the
 * lower-right corner at that same margin; where the two meet the mark sits on
 * top, with a cream halo so it stays readable.
 *
 * Requires ImageMagick (`magick`) and librsvg (`rsvg-convert`) on PATH.
 * Magick's built-in SVG renderer leaves these stroke-only glyphs blank, so
 * rasterization goes through rsvg-convert. Install on macOS with:
 *   brew install imagemagick librsvg
 *
 * Usage (from repo root or this directory):
 *   node mobile/icons/generateAppIcons.js
 */
const path = require('path')
const fs = require('fs')
const os = require('os')
const { execFileSync } = require('child_process')

const iconsDir = __dirname
const repoRoot = path.resolve(iconsDir, '..', '..')
const SRC_LOGO = path.join(iconsDir, 'tsLogo.png')

const CANVAS = 1024
const MARGIN = Math.round(CANVAS * 0.125)
const GLYPH_BOX = CANVAS - 2 * MARGIN
const SIGNATURE_SIZE = Math.round(CANVAS * 0.37)
const HALO_DISK = 24
// The logo's cream carries faint compression noise, so trimming it needs some tolerance.
const TRIM_FUZZ = '6%'

const APPS = [
  {
    name: 'director',
    svg: path.join(iconsDir, 'clapboard.svg'),
    out: path.join(
      repoRoot,
      'mobile/apps/gsDirector/App/Assets.xcassets/AppIcon.appiconset/AppIcon.png'
    )
  },
  {
    name: 'cameraman',
    svg: path.join(iconsDir, 'cineCamera.svg'),
    out: path.join(
      repoRoot,
      'mobile/apps/gsCameraman/App/Assets.xcassets/AppIcon.appiconset/AppIcon.png'
    ),
    // The Android build wears the same mark. Two apps that stream from the same operator's pocket
    // should not be told apart by their icons.
    androidRes: path.join(
      repoRoot,
      'mobile/apps/gsCameramanAndroid/app/src/main/res'
    )
  },
  {
    name: 'preview',
    svg: path.join(iconsDir, 'monitors.svg'),
    out: path.join(
      repoRoot,
      'mobile/apps/gsPreview/App/Assets.xcassets/AppIcon.appiconset/AppIcon.png'
    )
  }
]

function findBin(name, extraPaths, hint) {
  const candidates = [name, ...extraPaths]
  for (const bin of candidates) {
    try {
      execFileSync(bin, ['--version'], { stdio: 'ignore' })
      return bin
    } catch {
      try {
        execFileSync(bin, ['-version'], { stdio: 'ignore' })
        return bin
      } catch {
        // try next
      }
    }
  }
  throw new Error(hint)
}

const MAGICK = findBin(
  'magick',
  ['/opt/homebrew/bin/magick', '/usr/local/bin/magick'],
  'ImageMagick `magick` not found. Install on macOS with: brew install imagemagick'
)
const RSVG = findBin(
  'rsvg-convert',
  ['/opt/homebrew/bin/rsvg-convert', '/usr/local/bin/rsvg-convert'],
  'librsvg `rsvg-convert` not found. Install on macOS with: brew install librsvg'
)

function magick(...args) {
  execFileSync(MAGICK, args, { stdio: ['ignore', 'pipe', 'inherit'] })
}

function magickOut(...args) {
  return execFileSync(MAGICK, args, { encoding: 'utf8' }).trim()
}

function sampleCream(logoPath) {
  const hex = magickOut(logoPath, '-format', '%[hex:u.p{0,0}]', 'info:')
  const rgb = hex.replace(/[^0-9A-Fa-f]/g, '').slice(0, 6)
  if (rgb.length !== 6) {
    throw new Error(`could not sample cream from ${logoPath}: got ${hex}`)
  }
  return `#${rgb.toUpperCase()}`
}

function rasterizeSvg(svgPath, sizePx, dest) {
  execFileSync(
    RSVG,
    [
      '-w',
      String(sizePx),
      '-h',
      String(sizePx),
      '--background-color=none',
      svgPath,
      '-o',
      dest
    ],
    { stdio: ['ignore', 'pipe', 'inherit'] }
  )
}

function trimToContent(src, dest) {
  magick(src, '-fuzz', TRIM_FUZZ, '-trim', '+repage', dest)
}

function addCreamHalo(imagePath, cream, dest) {
  magick(
    imagePath,
    '(',
    '+clone',
    '-alpha',
    'extract',
    '-threshold',
    '1%',
    '-morphology',
    'Dilate',
    `Disk:${HALO_DISK}`,
    // The dilated mask becomes the halo's alpha and cream fills it. Copying alpha from a
    // colorized image instead would make the whole box ~90% opaque cream, graying what it covers.
    '-colorspace',
    'sRGB',
    '-background',
    cream,
    '-alpha',
    'shape',
    ')',
    '+swap',
    '-background',
    'none',
    '-compose',
    'over',
    '-composite',
    dest
  )
}

// The trimmed mark at signature size, its convex hull filled with cream so glyph lines stop at
// the mark's outline instead of showing through its middle, then haloed. The border leaves the
// halo room to grow past the mark's own box.
function prepareSignature(trimmedLogo, cream, dest) {
  const keyed = `${dest}.keyed.png`
  const filled = `${dest}.filled.png`
  magick(
    trimmedLogo,
    '-resize',
    `${SIGNATURE_SIZE}x${SIGNATURE_SIZE}`,
    '-fuzz',
    TRIM_FUZZ,
    '-transparent',
    cream,
    '-bordercolor',
    'none',
    '-border',
    String(HALO_DISK),
    keyed
  )
  const hull = magickOut(keyed, '-format', '%[convex-hull]', 'info:')
  magick(
    keyed,
    '(',
    '+clone',
    '-alpha',
    'transparent',
    '-fill',
    cream,
    '-draw',
    `polygon ${hull}`,
    ')',
    '+swap',
    '-compose',
    'over',
    '-composite',
    filled
  )
  addCreamHalo(filled, cream, dest)
}

function composeIcon({ signature, cream, glyph, dest }) {
  const signatureOffset = MARGIN - HALO_DISK
  magick(
    '-size',
    `${CANVAS}x${CANVAS}`,
    `xc:${cream}`,
    '(',
    glyph,
    '-resize',
    `${GLYPH_BOX}x${GLYPH_BOX}`,
    ')',
    '-gravity',
    'center',
    '-geometry',
    '+0+0',
    '-composite',
    signature,
    '-gravity',
    'southeast',
    '-geometry',
    `+${signatureOffset}+${signatureOffset}`,
    '-composite',
    '-alpha',
    'off',
    '-depth',
    '8',
    `PNG24:${dest}`
  )
}

const ANDROID_DENSITIES = [
  { dir: 'mipmap-mdpi', scale: 1 },
  { dir: 'mipmap-hdpi', scale: 1.5 },
  { dir: 'mipmap-xhdpi', scale: 2 },
  { dir: 'mipmap-xxhdpi', scale: 3 },
  { dir: 'mipmap-xxxhdpi', scale: 4 }
]
const ADAPTIVE_DP = 108
const ADAPTIVE_SAFE_DP = 66
const LEGACY_DP = 48

function writeAndroidMipmaps(name, composedPng, resDir) {
  for (const { dir, scale } of ANDROID_DENSITIES) {
    const outDir = path.join(resDir, dir)
    fs.mkdirSync(outDir, { recursive: true })
    const adaptiveCanvasPx = Math.round(ADAPTIVE_DP * scale)
    const adaptiveSafePx = Math.round(ADAPTIVE_SAFE_DP * scale)
    const legacyPx = Math.round(LEGACY_DP * scale)
    magick(
      composedPng,
      '-resize',
      `${legacyPx}x${legacyPx}`,
      '-depth',
      '8',
      path.join(outDir, 'ic_launcher.png')
    )
    magick(
      composedPng,
      '-resize',
      `${legacyPx}x${legacyPx}`,
      '-depth',
      '8',
      path.join(outDir, 'ic_launcher_round.png')
    )
    magick(
      composedPng,
      '-background',
      'none',
      '-resize',
      `${adaptiveSafePx}x${adaptiveSafePx}`,
      '-gravity',
      'center',
      '-extent',
      `${adaptiveCanvasPx}x${adaptiveCanvasPx}`,
      '-alpha',
      'set',
      path.join(outDir, 'ic_launcher_foreground.png')
    )
    console.log(
      `[icons] ${name} ${dir}: ic_launcher ${legacyPx}px, ` +
        `foreground ${adaptiveCanvasPx}px (safe ${adaptiveSafePx}px)`
    )
  }
}

function main() {
  if (!fs.existsSync(SRC_LOGO)) {
    throw new Error(`Source logo not found: ${SRC_LOGO}`)
  }
  const cream = sampleCream(SRC_LOGO)
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gs-app-icons-'))
  try {
    const trimmed = path.join(tmp, 'logo-trimmed.png')
    trimToContent(SRC_LOGO, trimmed)
    const signature = path.join(tmp, 'logo-signature.png')
    prepareSignature(trimmed, cream, signature)

    for (const app of APPS) {
      if (!fs.existsSync(app.svg)) {
        throw new Error(`Glyph SVG not found: ${app.svg}`)
      }
      fs.mkdirSync(path.dirname(app.out), { recursive: true })
      const glyphRaw = path.join(tmp, `${app.name}-glyph.png`)
      const glyphTrimmed = path.join(tmp, `${app.name}-glyph-trimmed.png`)
      rasterizeSvg(app.svg, CANVAS, glyphRaw)
      trimToContent(glyphRaw, glyphTrimmed)
      composeIcon({ signature, cream, glyph: glyphTrimmed, dest: app.out })
      console.log(
        `[icons] ${app.name}: ${path.relative(repoRoot, app.out)} ` +
          `(canvas ${CANVAS}, glyph fits ${GLYPH_BOX} centered, ` +
          `mark ${SIGNATURE_SIZE} SE margin ${MARGIN}, cream ${cream})`
      )
      if (app.androidRes) {
        writeAndroidMipmaps(app.name, app.out, app.androidRes)
      }
    }
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true })
  }
}

main()
